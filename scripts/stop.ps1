# 停止 QQ 机器人（独立桥）
#
# 正常情况下「关闭启动窗口」即可停止；本脚本用于窗口丢失/后台残留时兜底。
#
# 用法: pwsh -File scripts/stop.ps1
$ErrorActionPreference = 'Continue'

$killed = @()

# 按命令行精确定位桥进程（只杀跑 bridge.ts 的 bun，不误伤其他 bun）
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^bun(\.exe)?$' -and $_.CommandLine -like '*bridge.ts*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += $_.ProcessId
  }

if ($killed.Count -gt 0) {
  Write-Host ("已停止桥进程: {0}" -f ($killed -join ', '))
} else {
  Write-Host '未发现运行中的桥进程（可能已经停止）'
}

# 报告锁状态：下次启动时，若持有进程已不存在会立即接管，无需等待
$lock = Join-Path $env:USERPROFILE '.config\opencode\opencode-qq-gateway.lock'
if (Test-Path $lock) {
  $raw = Get-Content $lock -Raw | ConvertFrom-Json
  $alive = $false
  try {
    process.kill([int]$raw.pid, 0)
    $alive = $true
  } catch {
    $alive = $false
  }
  Write-Host ("网关锁: pid={0}  {1}" -f $raw.pid, $(if ($alive) { '仍存活' } else { '已退出，下次启动将立即接管' }))
}
