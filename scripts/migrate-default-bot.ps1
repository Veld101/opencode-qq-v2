# 把「默认实例」迁移成具名机器人（可选，一次性）
#
# 迁移内容（移动，不是复制）：
#   <configDir>/opencode-qq.json           -> <configDir>/bots/<name>/opencode-qq.json
#   <configDir>/opencode-qq-sessions.json  -> <configDir>/bots/<name>/opencode-qq-sessions.json
#   <configDir>/opencode-qq.log*           -> 一并带走
# 然后调用 new-bot.ps1 生成图标与「QQ机器人-<name>」快捷方式。
#
# 注意：迁移前必须先停掉默认实例，否则它仍在用旧目录，会重建文件。
#
# 用法:
#   pwsh -File scripts/migrate-default-bot.ps1 -Name main
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ShortcutDir,
    [switch]$KeepOldShortcut
)
$ErrorActionPreference = 'Stop'

if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw "机器人名只能是字母/数字/下划线/连字符（得到：$Name）" }

$shortcutDir = if ($ShortcutDir) { $ShortcutDir }
               elseif ($env:OPENCODE_QQ_SHORTCUT_DIR) { $env:OPENCODE_QQ_SHORTCUT_DIR }
               else { [Environment]::GetFolderPath('Desktop') }

$cfgRoot = Join-Path $env:USERPROFILE '.config\opencode'
$dstDir  = Join-Path $cfgRoot "bots\$Name"
$srcCfg  = Join-Path $cfgRoot 'opencode-qq.json'

if (-not (Test-Path -LiteralPath $srcCfg)) { throw "没有可迁移的默认配置：$srcCfg" }
if (Test-Path -LiteralPath (Join-Path $dstDir 'opencode-qq.json')) { throw "目标已存在配置，拒绝覆盖：$dstDir\opencode-qq.json" }

# 默认实例还在跑吗？（看实例锁里的 pid 是否存活）
$lock = Join-Path $cfgRoot 'opencode-qq-instance.lock'
if (Test-Path -LiteralPath $lock) {
    $raw = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
    $alive = $false
    try { process.kill([int]$raw.pid, 0); $alive = $true } catch { $alive = $false }
    if ($alive) {
        throw "默认实例仍在运行（pid=$($raw.pid)）。请先关闭它的窗口，或执行 pwsh -File scripts/stop.ps1，再迁移。"
    }
}

[void](New-Item -ItemType Directory -Path $dstDir -Force)

$moved = @()
foreach ($f in @('opencode-qq.json', 'opencode-qq-sessions.json', 'opencode-qq.log', 'opencode-qq.log.1')) {
    $src = Join-Path $cfgRoot $f
    if (Test-Path -LiteralPath $src) {
        Move-Item -LiteralPath $src -Destination (Join-Path $dstDir $f) -Force
        $moved += $f
    }
}

Write-Host "已迁移到 $dstDir :"
foreach ($m in $moved) { Write-Host "  - $m" }

# 生成图标 + 「QQ机器人-<name>」快捷方式（配置已存在，会被保留）
$newBotArgs = @{ Name = $Name; ShortcutDir = $shortcutDir }
& (Join-Path $PSScriptRoot 'new-bot.ps1') @newBotArgs

# 处理旧的「QQ机器人」快捷方式
$oldLnk = Join-Path $shortcutDir 'QQ机器人.lnk'
if ((Test-Path -LiteralPath $oldLnk) -and -not $KeepOldShortcut) {
    $sh = New-Object -ComObject WScript.Shell
    $target = $sh.CreateShortcut($oldLnk).TargetPath
    if ($target -like '*start-bridge.cmd') {
        Remove-Item -LiteralPath $oldLnk -Force
        Write-Host "已删除旧快捷方式: $oldLnk"
    } else {
        Write-Host "旧快捷方式指向的不是本项目，保留: $oldLnk"
    }
}

Write-Host ''
Write-Host "迁移完成。请改用桌面「QQ机器人-$Name」启动。"
