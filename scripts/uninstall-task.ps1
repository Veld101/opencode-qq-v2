# 卸载计划任务并停止守护
$ErrorActionPreference = 'Continue'
$taskName = 'opencode-qq-bridge'
schtasks /End /TN $taskName 2>$null | Out-Null
schtasks /Delete /TN $taskName /F 2>$null | Out-Null
Write-Host "已结束并删除计划任务: $taskName"
