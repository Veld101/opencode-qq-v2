# 新建一个 QQ 机器人实例（方案 A：多进程 + 配置目录隔离）
#
# 每个机器人 = 一个独立 config dir + 一个独立 AppID + 一个桌面快捷方式。
# 实例之间配置 / 网关锁 / 会话映射 / 日志全部隔离，互不共享 session。
#
# 用法:
#   pwsh -File scripts/new-bot.ps1 -Name bot-a
#   pwsh -File scripts/new-bot.ps1 -Name bot-b -Workdir D:/workspace/proj-b
#   pwsh -File scripts/new-bot.ps1 -Name bot-c -ShortcutDir 'D:\tools\快捷方式'
#
# 快捷方式目录优先级：-ShortcutDir > $env:OPENCODE_QQ_SHORTCUT_DIR > 桌面
#
# 建完之后需要手动做的一件事：往生成的 opencode-qq.json 里填该机器人的
# AppID / AppSecret（不同机器人必须是不同的 AppID）。
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Workdir,
    [string]$C1,
    [string]$C2,
    [string]$ShortcutDir,
    [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'

if ($Name -notmatch '^[A-Za-z0-9_-]+$') {
    throw "机器人名只能是字母/数字/下划线/连字符（得到：$Name）"
}

$shortcutDir = if ($ShortcutDir) { $ShortcutDir }
               elseif ($env:OPENCODE_QQ_SHORTCUT_DIR) { $env:OPENCODE_QQ_SHORTCUT_DIR }
               else { [Environment]::GetFolderPath('Desktop') }

$repo   = Split-Path -Parent $PSScriptRoot          # 仓库根目录
$cfgDir = Join-Path $env:USERPROFILE ".config\opencode\bots\$Name"
$cfgFile = Join-Path $cfgDir 'opencode-qq.json'
$iconDir = Join-Path $repo 'assets\bots'
$iconPath = Join-Path $iconDir "$Name.ico"
$launcher = Join-Path $repo 'start-bridge.cmd'

if (-not (Test-Path -LiteralPath $launcher)) { throw "找不到启动入口：$launcher" }

# ---- 1. 配置目录 ----
if (-not (Test-Path -LiteralPath $cfgDir)) {
    [void](New-Item -ItemType Directory -Path $cfgDir -Force)
    Write-Host "[1/3] 已创建配置目录: $cfgDir"
} else {
    Write-Host "[1/3] 配置目录已存在: $cfgDir"
}

if (-not (Test-Path -LiteralPath $cfgFile)) {
    $template = Join-Path $repo 'opencode-qq.example.json'
    if (-not (Test-Path -LiteralPath $template)) { throw "找不到配置模板：$template" }
    $json = Get-Content -LiteralPath $template -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Workdir) { $json | Add-Member -NotePropertyName workdir -NotePropertyValue $Workdir -Force }
    $json | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $cfgFile -Encoding UTF8
    Write-Host "[1/3] 已生成配置模板: $cfgFile  （待填 AppID/AppSecret）"
} elseif ($Workdir) {
    $json = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $json | Add-Member -NotePropertyName workdir -NotePropertyValue $Workdir -Force
    $json | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $cfgFile -Encoding UTF8
    Write-Host "[1/3] 已更新 workdir = $Workdir"
} else {
    Write-Host "[1/3] 配置已存在，保持不动: $cfgFile"
}

# ---- 2. 图标（未指定配色时按调色板自动分配）----
if (-not $C1 -or -not $C2) {
    $palette = @(
        @{ C1 = '#B07CFF'; C2 = '#6A2BD9' },   # 紫
        @{ C1 = '#FFB74D'; C2 = '#E07B00' },   # 橙
        @{ C1 = '#4DD6C1'; C2 = '#0E9E86' },   # 青
        @{ C1 = '#FF8FA3'; C2 = '#D6335A' },   # 玫红
        @{ C1 = '#7FA8FF'; C2 = '#2B4FD9' },   # 靛蓝
        @{ C1 = '#C0A16B'; C2 = '#8A6A22' }    # 棕金
    )
    # 按机器人名做稳定哈希选色：同名每次同色，增删其它机器人不会串色
    $sum = 0
    foreach ($ch in $Name.ToCharArray()) { $sum = ($sum * 31 + [int]$ch) % 1000003 }
    $pick = $palette[$sum % $palette.Count]
    if (-not $C1) { $C1 = $pick.C1 }
    if (-not $C2) { $C2 = $pick.C2 }
}

& (Join-Path $PSScriptRoot 'make-bot-icon.ps1') -Out $iconPath -C1 $C1 -C2 $C2 | Out-Null
Write-Host "[2/3] 已生成图标: $iconPath  ($C1 -> $C2)"

# ---- 3. 桌面快捷方式 ----
if ($NoShortcut) {
    Write-Host '[3/3] 跳过快捷方式（-NoShortcut）'
} else {
    if (-not (Test-Path -LiteralPath $shortcutDir)) { [void](New-Item -ItemType Directory -Path $shortcutDir -Force) }
    $lnkPath = Join-Path $shortcutDir "QQ机器人-$Name.lnk"
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $launcher
    $lnk.Arguments        = $Name
    $lnk.WorkingDirectory = $repo
    $lnk.IconLocation     = "$iconPath,0"
    $lnk.Description      = "opencode-qq 机器人实例：$Name"
    $lnk.Save()
    Write-Host "[3/3] 已创建快捷方式: $lnkPath"
}

Write-Host ''
Write-Host '下一步：'
Write-Host "  1) 编辑 $cfgFile，填入该机器人的 AppID / AppSecret"
if ($Workdir) { Write-Host "     工作目录已设为: $Workdir" } else { Write-Host '     如需独立工作目录，可在配置里加 "workdir" 或 "workspaces"' }
Write-Host "  2) 双击「QQ机器人-$Name」启动"
Write-Host "  3) 停止: pwsh -File scripts/stop.ps1 -Bot $Name"
