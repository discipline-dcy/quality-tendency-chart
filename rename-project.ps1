# ═══════════════════════════════════════════════════════════════
# 改名 / 挪位置
#
#   .\rename-project.ps1                          改成默认名「质量趋势图」
#   .\rename-project.ps1 quality-board            改成别的名字
#   .\rename-project.ps1 质量趋势图 -Destination C:\   顺便挪到 C:\
#
# 为什么要有这个脚本：
#   改文件夹名对 server.js 本身没有任何影响 —— 它全部用 __dirname 定位
#   config.json 和 html，叫什么、放哪都能跑。但改名会**悄悄搞坏开机自启**：
#   计划任务里存的是绝对路径，改完名它会去一个不存在的目录找 server.js，
#   而且是 -WindowStyle Hidden 跑的，不报错、不弹窗，只有等大屏掉成离线
#   快照时才会被发现。
#
#   所以改名必须是「停服务 → 改名 → 重新注册」，缺一步就埋一个雷。
#   顺序里最容易踩的是第一步必须在**旧**目录下做：install-autostart.ps1
#   的 -Off 是按 server.js 的绝对路径匹配进程来杀的，改完名再跑就匹配不到
#   旧进程，会变成「任务删了、进程还占着 3200 端口」。
# ═══════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
    # 不填就用项目的标准名字，省得每次都要记
    [Parameter(Position = 0)]
    [string]$NewName = '质量趋势图',

    # 只改名不用填。想顺便挪走（比如从桌面挪到 C:\，免得被人误拖误删）才填
    [string]$Destination
)

$ErrorActionPreference = 'Stop'

$Old       = $PSScriptRoot
$OldName   = Split-Path $Old -Leaf
$Installer = Join-Path $Old 'install-autostart.ps1'

# ── 先把能在动手前发现的问题全查掉 ──────────────────────────────
# 这类脚本最糟的失败方式是「改到一半」：服务停了、名字没改成，
# 看板停着而人以为已经改好了。所以所有校验都放在动手之前。

if ($NewName -match '[\\/:*?"<>|]') {
    throw "名字里不能有 \ / : * ? "" < > | 这些字符。"
}

if (-not (Test-Path (Join-Path $Old 'server.js'))) {
    throw "$Old 下没有 server.js —— 这个脚本要放在项目目录里运行。"
}
if (-not (Test-Path $Installer)) {
    throw "找不到 $Installer —— 项目文件不完整，改名会让自启没法重新注册。"
}

$Parent = if ($Destination) {
    # 早点查掉，不然 Resolve-Path 会在动手前抛一句挺难懂的话
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
        throw "目标目录 $Destination 不存在（或者不是个目录）。"
    }
    (Resolve-Path -LiteralPath $Destination).Path
} else {
    Split-Path $Old -Parent
}
$New    = Join-Path $Parent $NewName

if ($New -eq $Old) {
    Write-Host "新旧路径一样，什么都不用做。"
    return
}
if (Test-Path $New) {
    throw "$New 已经存在了。换个名字，或者先把那个目录挪走。"
}

Write-Host "  旧：$Old"
Write-Host "  新：$New"
Write-Host ""

# ── ① 停服务并注销旧任务 ────────────────────────────────────────
# 必须在旧目录下调用，理由见文件头
Write-Host "① 停服务、注销旧任务…"
& $Installer -Off

# -Off 现在按「命令行带绝对路径」+「谁在监听 3200」两个信号认人，手动
# `node server.js` 起的那种也能停掉了。但从这个目录跑起来的其它 node
# —— 既不监听 3200、命令行里也没有绝对路径的 —— 它还是认不出来，而只要
# 有进程把这个目录当工作目录，Windows 就会拒绝改名。这里按命令行里出现
# 过旧路径再补一网。
$stuck = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$Old*" }
foreach ($p in $stuck) {
    Stop-Process -Id $p.ProcessId -Force
    Write-Host "  ✓ 另外停掉了残留的 node PID $($p.ProcessId)"
}

# ── ② 改名 ──────────────────────────────────────────────────────
# 当前 shell 如果正站在这个目录里，它自己就会锁住目录导致改名失败。
# 先切到用户主目录 —— 一个跟本项目无关、肯定存在的位置。
Set-Location $env:USERPROFILE

Write-Host "② 改名…"
# 句柄释放有延迟（进程刚杀掉、杀毒软件在扫、资源管理器开着预览都会占一会儿），
# 直接失败太脆，重试几次绝大多数情况都能过去
$done = $false
for ($i = 1; $i -le 5; $i++) {
    try {
        Move-Item -LiteralPath $Old -Destination $New
        $done = $true
        break
    } catch {
        if ($i -eq 5) {
            throw ("改名失败：$($_.Exception.Message)`n" +
                   "  常见原因：资源管理器正开着这个文件夹、有终端 cd 在里面、`n" +
                   "  或者还有别的 node 进程把这个目录当工作目录。`n" +
                   "  全部关掉再跑一次。注意服务已经停了，看板现在是停的。")
        }
        Start-Sleep -Seconds 1
    }
}

if ($done) { Write-Host "  ✓ $OldName → $NewName" }

# ── ③ 在新路径重新注册 ──────────────────────────────────────────
# Register-ScheduledTask -Force 会覆盖同名任务，不会留下两个
Write-Host "③ 重新注册开机自启…"
Set-Location $New
& (Join-Path $New 'install-autostart.ps1')

Write-Host ""
Write-Host "══════════════════════════════════════════════"
Write-Host "改完了。大屏那头**不用动** —— 它认的是 IP:3200，跟路径无关。"
Write-Host "当前目录已经切到新位置：$New"
