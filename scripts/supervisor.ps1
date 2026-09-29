# opencode-qq 独立桥守护脚本
#
# 由计划任务在登录时启动；桥进程退出（崩溃/异常）后自动重启。
# 桥自身的日志在 ~/.config/opencode/opencode-qq.log，这里只记录重启事件。
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 计划任务的环境里 PATH 可能不含 bun，这里显式解析
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
  foreach ($c in @((Join-Path $env:USERPROFILE '.bun\bin\bun.exe'), 'C:\Program Files\bun\bun.exe')) {
    if (Test-Path $c) { $bun = $c; break }
  }
}
if (-not $bun) {
  Write-Error '未找到 bun，请检查安装或 PATH'
  exit 1
}

Write-Host "[supervisor] root=$root bun=$bun"

while ($true) {
  & $bun (Join-Path $root 'bridge.ts')
  $code = $LASTEXITCODE
  Write-Host ("[supervisor] {0} 桥进程退出 code={1}，5 秒后重启" -f (Get-Date -Format s), $code)
  Start-Sleep -Seconds 5
}
