# opencode-qq 独立桥守护脚本
#
# 由计划任务在登录时启动；桥进程退出（崩溃/异常）后自动重启。
# 桥自身的日志在 <configDir>/opencode-qq.log，这里只记录重启事件。
#
# 用法:
#   pwsh -File scripts/supervisor.ps1              # 默认实例
#   pwsh -File scripts/supervisor.ps1 -Bot bot-a   # 指定机器人（等价于 start-bridge.cmd bot-a）
param(
    [string]$Bot
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Bot) {
    $env:OPENCODE_QQ_CONFIG_DIR = Join-Path $env:USERPROFILE ".config\opencode\bots\$Bot"
}

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

$tag = if ($Bot) { "bot=$Bot " } else { "" }
Write-Host "[supervisor] ${tag}root=$root bun=$bun"

while ($true) {
    if ($Bot) {
        & $bun (Join-Path $root 'bridge.ts') --bot $Bot
    } else {
        & $bun (Join-Path $root 'bridge.ts')
    }
    $code = $LASTEXITCODE

    # 退出码 3 = 该机器人已有实例在运行（例如用户又手动双击了快捷方式）：
    # 让位退出，避免无意义的重启循环。
    if ($code -eq 3) {
        Write-Host ("[supervisor] {0} {1}已有实例在运行，守护退出" -f (Get-Date -Format s), $tag)
        exit 0
    }

    Write-Host ("[supervisor] {0} {1}桥进程退出 code={2}，5 秒后重启" -f (Get-Date -Format s), $tag, $code)
    Start-Sleep -Seconds 5
}
