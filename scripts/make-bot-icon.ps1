# 生成 opencode-qq 机器人图标（圆角渐变底 + 白色笑脸机器人）
#
# 用法:
#   pwsh -File scripts/make-bot-icon.ps1 -Out assets/bots/bot-a.ico -C1 '#B07CFF' -C2 '#6A2BD9'
#
# 小尺寸（<=32px）自动简化为「头 + 双眼」，保证 16px 下仍可辨识。
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$C1 = '#38C4FF',
    [string]$C2 = '#0A62D0'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\icon-lib.ps1"

$Out = [System.IO.Path]::GetFullPath($Out)
$outDir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $outDir)) { [void](New-Item -ItemType Directory -Path $outDir -Force) }

function New-BotBitmap {
    param([int]$s, [System.Drawing.Color]$Col1, [System.Drawing.Color]$Col2)

    $bmp = [System.Drawing.Bitmap]::new($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-IconGraphics -bmp $bmp

    $f = $s / 256.0
    $simple = $s -le 32

    Fill-RoundedGradient -g $g -Size $s -Col1 $Col1 -Col2 $Col2

    $white = [System.Drawing.Color]::White
    $dark  = [System.Drawing.Color]::FromArgb(
        255,
        [int][Math]::Round($Col2.R * 0.55 + 20),
        [int][Math]::Round($Col2.G * 0.55 + 20),
        [int][Math]::Round($Col2.B * 0.55 + 20)
    )

    # 天线（先画，头会盖住根部）
    if (-not $simple) {
        $antPen = [System.Drawing.Pen]::new($white, [float][Math]::Max(1.5, 12 * $f))
        $antPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $antPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawLine($antPen, [float](128 * $f), [float](92 * $f), [float](128 * $f), [float](58 * $f))
        $antPen.Dispose()
        $antBrush = [System.Drawing.SolidBrush]::new($white)
        $ar = [float](12 * $f)
        $g.FillEllipse($antBrush, [float](128 * $f - $ar), [float](52 * $f - $ar), $ar * 2, $ar * 2)
        $antBrush.Dispose()
    }

    # 头
    $headPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    Add-RoundRect $headPath ([float](58 * $f)) ([float](92 * $f)) ([float](140 * $f)) ([float](110 * $f)) ([float](30 * $f))
    $headBrush = [System.Drawing.SolidBrush]::new($white)
    $g.FillPath($headBrush, $headPath)

    # 眼睛
    $eyeR = if ($simple) { 18 } else { 14 }
    $eyeBrush = [System.Drawing.SolidBrush]::new($dark)
    $er = [float]($eyeR * $f)
    foreach ($cx in 99, 157) {
        $g.FillEllipse($eyeBrush, [float]($cx * $f - $er), [float](140 * $f - $er), $er * 2, $er * 2)
    }

    # 微笑
    if (-not $simple) {
        $mouthPen = [System.Drawing.Pen]::new($dark, [float][Math]::Max(1.5, 11 * $f))
        $mouthPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $mouthPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawArc($mouthPen, [float](108 * $f), [float](148 * $f), [float](40 * $f), [float](36 * $f), [float]25, [float]130)
        $mouthPen.Dispose()
    }

    $eyeBrush.Dispose(); $headBrush.Dispose(); $headPath.Dispose(); $g.Dispose()
    return $bmp
}

$col1 = [System.Drawing.ColorTranslator]::FromHtml($C1)
$col2 = [System.Drawing.ColorTranslator]::FromHtml($C2)

$bitmaps = foreach ($s in $script:IconSizes) { New-BotBitmap -s $s -Col1 $col1 -Col2 $col2 }
$null = Write-IcoFile -Path $Out -Bitmaps $bitmaps
foreach ($b in $bitmaps) { $b.Dispose() }

Write-Output ("icon -> {0}  ({1} bytes, {2} frames, {3} -> {4})" -f $Out, (Get-Item -LiteralPath $Out).Length, $script:IconSizes.Count, $C1, $C2)
