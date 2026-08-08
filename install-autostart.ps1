# ═══════════════════════════════════════════════════════════════
# 注册开机自启（登录时启动 server.js）
#
#   .\install-autostart.ps1        注册并立即启动
#   .\install-autostart.ps1 -Off   取消自启并停掉服务
#
# 为什么用任务计划程序而不是启动文件夹的快捷方式：
#   - 快捷方式跑起来会留一个黑框控制台在桌面上，谁手贱关一下服务就没了
#   - 任务计划能配「崩了自动重启」，看板是无人值守的，这条很重要
#   - 卸载干净，不用去翻启动文件夹
#
# 不需要管理员权限：注册的是当前用户的登录触发任务，不是系统级服务。
# 代价是必须有人登录进桌面服务才会起来 —— 车间那台机器本来就是常年
# 登录着的，真要做成免登录的系统服务得存密码，不划算。
# ═══════════════════════════════════════════════════════════════

param([switch]$Off)

$ErrorActionPreference = 'Stop'

$TaskName = '质量趋势看板'
$Dir      = $PSScriptRoot
$Entry    = Join-Path $Dir 'server.js'
$Port     = 3200

# 找出「正在给看板服务的 server.js 进程」。
#
# 只按 server.js 的绝对路径匹配命令行是不够的：手工在项目目录里跑
# `node server.js` 起来的那个，命令行里是相对路径（"node.exe" server.js），
# 这么匹配根本认不出来 —— 于是 -Off 会打印「没有正在运行的 server.js」，
# 却把它留着占住端口，正好就是「任务删了、进程还在」。
#
# 所以两个信号取并集：
#   ① 命令行里带 server.js 的绝对路径 —— 计划任务是这么拉起来的
#   ② 谁在监听 3200 —— 不管当初怎么起来的，这才是真正在服务的那个
# ② 只认 node.exe：端口被别的程序占着是另一码事，不能在这儿误杀。
function Get-BoardProcess {
    $found = @{}

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*$Entry*" } |
        ForEach-Object { $found[[int]$_.ProcessId] = $_ }

    foreach ($ownerId in Get-PortOwner) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId" -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -eq 'node.exe') { $found[[int]$ownerId] = $proc }
    }

    @($found.Values)
}

function Get-PortOwner {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

if ($Off) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "✓ 已取消开机自启"
    } else {
        Write-Host "本来就没注册过"
    }
    # 顺手把正在跑的停掉。任务注销了而进程还在的话，端口一直占着，
    # 下次注册回来反而起不来。
    $running = Get-BoardProcess
    if ($running) {
        $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "✓ 已停止 PID $($_.ProcessId)" }
    } else {
        Write-Host "没有正在运行的 server.js"
    }
    return
}

if (-not (Test-Path $Entry)) { throw "找不到 $Entry —— 请在项目目录下运行本脚本。" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "PATH 里找不到 node。先装 Node.js（当前项目用 v24.18.0），装完重开 PowerShell 再跑。" }

# -WindowStyle Hidden 藏掉控制台窗口。看板机器上不该有个黑框杵在那儿，
# 更不该让人以为「关掉这个窗口」是无害的
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -Command ""Set-Location '$Dir'; & '$node' '$Entry'""" `
    -WorkingDirectory $Dir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# 崩了 1 分钟后重试，最多 3 次。ExecutionTimeLimit 0 = 不限时长，
# 默认那个 3 天上限会在某个周末把看板悄悄停掉
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description '车间大屏质量趋势看板后端（server.js）' -Force | Out-Null

Write-Host "✓ 已注册开机自启：$TaskName"
Write-Host "  下次登录 Windows 时会自动启动，无窗口。"

# 端口只能有一个人占。之前手工 `node server.js` 起过的话，得先停掉，
# 否则任务拉起的那个会 EADDRINUSE 秒退，而端口照样有人监听 —— 看起来是
# 成功了，实际自启是坏的，等大屏掉成离线快照才会被发现。
foreach ($p in Get-BoardProcess) {
    Stop-Process -Id $p.ProcessId -Force
    Write-Host "  已停掉占着 $Port 端口的旧进程 PID $($p.ProcessId)，改由计划任务接管"
}

# 端口被非 node 的东西占着就没法自动处理了，早点说清楚，别让它一路跑到
# 底再报一句含糊的「端口没起来」
$squatter = Get-PortOwner
if ($squatter) {
    $who = $squatter | ForEach-Object { "$((Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName)(PID $_)" }
    throw "$Port 端口被 $($who -join '、') 占着，不是 node。先把它停掉再跑本脚本。"
}

Start-ScheduledTask -TaskName $TaskName

# 校验要核对「监听 $Port 的那个进程确实是计划任务刚拉起来的 server.js」。
# 光看端口有没有人监听不够 —— 任何占着这个端口的东西都能把它点成绿灯。
# 计划任务固定用绝对路径拉起，所以命令行里带 $Entry 的才算数。
# 冷启动有时不止 3 秒（首次读 config、装了杀软的机器更慢），轮询到 10 秒。
$ok = $null
for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 1
    $ok = Get-PortOwner |
        ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue } |
        Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$Entry*" } |
        Select-Object -First 1
    if ($ok) { break }
}

if ($ok) {
    Write-Host "✓ 服务已启动（PID $($ok.ProcessId)），$Port 端口在监听"
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -match '^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback|Mihomo|clash|VMware|VirtualBox|WSL' }
    foreach ($ip in $ips) {
        Write-Host "  大屏填这个：http://$($ip.IPAddress):$Port/quality-maxhub.html"
    }
} else {
    $code = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
    Write-Host "⚠ $Port 端口没起来（计划任务退出码 $code）。手动跑一次 ``node server.js`` 看报什么错。"
    Write-Host "  常见原因：还没配 OA 账号（node server.js --set-account <账号>）。"
}

Write-Host ""
Write-Host "取消自启：.\install-autostart.ps1 -Off"
