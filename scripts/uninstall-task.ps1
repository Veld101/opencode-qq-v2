# 卸载计划任务并停止守护
#
# 用法：
#   pwsh -File scripts/uninstall-task.ps1              # 默认实例
#   pwsh -File scripts/uninstall-task.ps1 -Bot bot-a   # 指定机器人
param(
    [string]$Bot
)
$ErrorActionPreference = 'Continue'

$taskName = if ($Bot) { "opencode-qq-bridge-$Bot" } else { 'opencode-qq-bridge' }
schtasks /End /TN $taskName 2>$null | Out-Null
schtasks /Delete /TN $taskName /F 2>$null | Out-Null
Write-Host "已结束并删除计划任务: $taskName"
