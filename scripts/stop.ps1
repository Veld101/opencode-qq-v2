# 停止 QQ 机器人（独立桥）
#
# 正常情况下「关闭启动窗口」即可停止；本脚本用于窗口丢失/后台残留时兜底。
#
# 用法:
#   pwsh -File scripts/stop.ps1                 # 停止所有桥进程（全部机器人）
#   pwsh -File scripts/stop.ps1 -Bot bot-a      # 只停指定机器人
#
# 识别方式：start-bridge.cmd 用 `bun bridge.ts --bot <name>` 启动实例，
# 因此可按命令行里的 --bot 精确区分；不带 --bot 的是「默认」实例。
param(
    [string]$Bot
)

$ErrorActionPreference = 'Continue'

# 按命令行精确定位桥进程（只杀跑 bridge.ts 的 bun，不误伤其他 bun）
$procs = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^bun(\.exe)?$' -and $_.CommandLine -like '*bridge.ts*' }
)

if ($Bot) {
    $pattern = '--bot\s+' + [regex]::Escape($Bot) + '(\s|$)'
    $procs = @($procs | Where-Object { $_.CommandLine -match $pattern })
}

$killed = @()
foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += $p.ProcessId
}

if ($killed.Count -gt 0) {
    Write-Host ("已停止桥进程: {0}" -f ($killed -join ', '))
} else {
    if ($Bot) {
        Write-Host ("未发现运行中的桥进程（bot={0}，可能已经停止）" -f $Bot)
    } else {
        Write-Host '未发现运行中的桥进程（可能已经停止）'
    }
}

# 报告锁状态：下次启动时，若持有进程已不存在会立即接管，无需等待
$cfgDir = if ($Bot) { Join-Path $env:USERPROFILE ".config\opencode\bots\$Bot" } else { Join-Path $env:USERPROFILE '.config\opencode' }
$lock = Join-Path $cfgDir 'opencode-qq-gateway.lock'
if (Test-Path $lock) {
    $raw = Get-Content $lock -Raw | ConvertFrom-Json
    # PowerShell 里没有 process.kill()，用 Get-Process 判断存活
    $alive = $null -ne (Get-Process -Id ([int]$raw.pid) -ErrorAction SilentlyContinue)
    Write-Host ("网关锁: {0}  pid={1}  {2}" -f $lock, $raw.pid, $(if ($alive) { '仍存活' } else { '已退出，下次启动将立即接管' }))
}
