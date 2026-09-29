# 生成管理类快捷方式图标（圆角渐变底 + 白色符号：▶ 运行 / ■ 停止）
#
# 用法:
#   pwsh -File scripts/make-glyph-icon.ps1 -Out assets/run-all.ico  -Glyph run
#   pwsh -File scripts/make-glyph-icon.ps1 -Out assets/stop-all.ico -Glyph stop
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][ValidateSet('run', 'stop')][string]$Glyph,
    [string]$C1,
    [string]$C2
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\icon-lib.ps1"

if (-not $C1) { $C1 = if ($Glyph -eq 'run') { '#57D68A' } else { '#FF8A80' } }
if (-not $C2) { $C2 = if ($Glyph -eq 'run') { '#1E9E55' } else { '#C62828' } }

$Out = [System.IO.Path]::GetFullPath($Out)
$outDir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $outDir)) { [void](New-Item -ItemType Directory -Path $outDir -Force) }

function New-GlyphBitmap {
    param([int]$s, [System.Drawing.Color]$Col1, [System.Drawing.Color]$Col2, [string]$Glyph)

    $bmp = [System.Drawing.Bitmap]::new($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-IconGraphics -bmp $bmp
    $f = $s / 256.0

    Fill-RoundedGradient -g $g -Size $s -Col1 $Col1 -Col2 $Col2

    $white = [System.Drawing.Color]::White
    $brush = [System.Drawing.SolidBrush]::new($white)

    if ($Glyph -eq 'run') {
        $pts = [System.Drawing.PointF[]]@(
            ([System.Drawing.PointF]::new([float](100 * $f), [float](70 * $f))),
            ([System.Drawing.PointF]::new([float](100 * $f), [float](186 * $f))),
            ([System.Drawing.PointF]::new([float](192 * $f), [float](128 * $f)))
        )
        $g.FillPolygon($brush, $pts)
    } else {
        $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
        Add-RoundRect $path ([float](84 * $f)) ([float](84 * $f)) ([float](88 * $f)) ([float](88 * $f)) ([float](18 * $f))
        $g.FillPath($brush, $path)
        $path.Dispose()
    }

    $brush.Dispose(); $g.Dispose()
    return $bmp
}

$col1 = [System.Drawing.ColorTranslator]::FromHtml($C1)
$col2 = [System.Drawing.ColorTranslator]::FromHtml($C2)

$bitmaps = foreach ($s in $script:IconSizes) { New-GlyphBitmap -s $s -Col1 $col1 -Col2 $col2 -Glyph $Glyph }
$null = Write-IcoFile -Path $Out -Bitmaps $bitmaps
foreach ($b in $bitmaps) { $b.Dispose() }

Write-Output ("icon -> {0}  ({1} bytes, {2} frames, glyph={3})" -f $Out, (Get-Item -LiteralPath $Out).Length, $script:IconSizes.Count, $Glyph)
