# 在桌面创建两个管理快捷方式：「QQ机器人-全部启动」「QQ机器人-全部停止」
#
# 用法: pwsh -File scripts/install-shortcuts.ps1
$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$assets  = Join-Path $repo 'assets'

# 管理图标：不存在时才生成，避免覆盖手动替换过的图标
$runIcon  = Join-Path $assets 'run-all.ico'
$stopIcon = Join-Path $assets 'stop-all.ico'
if (-not (Test-Path -LiteralPath $runIcon))  { & (Join-Path $PSScriptRoot 'make-glyph-icon.ps1') -Out $runIcon  -Glyph run  | Out-Null }
if (-not (Test-Path -LiteralPath $stopIcon)) { & (Join-Path $PSScriptRoot 'make-glyph-icon.ps1') -Out $stopIcon -Glyph stop | Out-Null }

$sh = New-Object -ComObject WScript.Shell

function New-Shortcut {
    param([string]$Path, [string]$Target, [string]$Icon, [string]$Desc)
    $lnk = $sh.CreateShortcut($Path)
    $lnk.TargetPath       = $Target
    $lnk.WorkingDirectory = $repo
    $lnk.IconLocation     = "$Icon,0"
    $lnk.Description      = $Desc
    $lnk.Save()
}

New-Shortcut -Path (Join-Path $desktop 'QQ机器人-全部启动.lnk') -Target (Join-Path $repo 'start-all.cmd') -Icon $runIcon  -Desc '启动所有已配置的 QQ 机器人（已在运行的会自动跳过）'
New-Shortcut -Path (Join-Path $desktop 'QQ机器人-全部停止.lnk') -Target (Join-Path $repo 'stop-all.cmd')  -Icon $stopIcon -Desc '停止所有 QQ 机器人桥进程'

Write-Host '已创建桌面快捷方式:'
Write-Host '  QQ机器人-全部启动  -> start-all.cmd'
Write-Host '  QQ机器人-全部停止  -> stop-all.cmd'
