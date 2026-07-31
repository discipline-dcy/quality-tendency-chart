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

if ($Off) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "✓ 已取消开机自启"
    } else {
        Write-Host "本来就没注册过"
    }
    # 顺手把正在跑的停掉。按 server.js 的绝对路径匹配命令行 —— 上面注册任务时
    # 也是用绝对路径拉起的，两处必须一致，否则这里匹配不上，任务删了进程还在。
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*$Entry*" }
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

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$listening = netstat -ano | Select-String ':3200\s.*LISTENING'
if ($listening) {
    Write-Host "✓ 服务已启动，3200 端口在监听"
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -match '^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback|Mihomo|clash|VMware|VirtualBox|WSL' }
    foreach ($ip in $ips) {
        Write-Host "  大屏填这个：http://$($ip.IPAddress):3200/quality-maxhub.html"
    }
} else {
    Write-Host "⚠ 3200 端口没起来。手动跑一次 ``node server.js`` 看报什么错。"
    Write-Host "  常见原因：还没配 OA 账号（node server.js --set-account <账号>）。"
}

Write-Host ""
Write-Host "取消自启：.\install-autostart.ps1 -Off"
