# 注册「登录时自动启动独立桥」的计划任务
#
# 特点：无需管理员（仅当前用户）、登录后延迟 30 秒启动（等 OpenCode 服务就绪）、
# 崩溃由 supervisor.ps1 自动重启。
#
# 用法： pwsh -File scripts/install-task.ps1
$ErrorActionPreference = 'Stop'

$taskName = 'opencode-qq-bridge'
$root = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'supervisor.ps1'

if (-not (Test-Path $supervisor)) { throw "找不到 $supervisor" }

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $pwsh) { throw '找不到 pwsh/powershell' }

# schtasks 的 /TR 参数：整条命令行用引号包住，内部引号需转义
$action = "`"$pwsh`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`""

schtasks /Create /TN $taskName /TR $action /SC ONLOGON /DELAY 0000:30 /F | Out-Null

Write-Host "已注册计划任务: $taskName"
Write-Host "  触发: 用户登录后延迟 30 秒"
Write-Host "  命令: $action"
Write-Host ""
Write-Host "手动启动:  schtasks /Run    /TN $taskName"
Write-Host "查看状态:  schtasks /Query  /TN $taskName /FO LIST"
Write-Host "停止:      schtasks /End    /TN $taskName"
Write-Host "卸载:      pwsh -File scripts/uninstall-task.ps1"
