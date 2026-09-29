# ICO 生成共享实现（供 make-bot-icon.ps1 / make-glyph-icon.ps1 复用）
#
# 约定：16/24/32/48 用标准 DIB 帧，64/128/256 用 PNG 帧，兼顾新旧图标 API。
# 用法：调用方先 param()，再 `. "$PSScriptRoot\icon-lib.ps1"`。

Add-Type -AssemblyName System.Drawing

$script:IconSizes = 16, 24, 32, 48, 64, 128, 256

function Add-RoundRect {
    param($path, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
    $d = $r * 2
    $path.AddArc($x,             $y,             $d, $d, 180, 90)
    $path.AddArc($x + $w - $d,   $y,             $d, $d, 270, 90)
    $path.AddArc($x + $w - $d,   $y + $h - $d,   $d, $d,   0, 90)
    $path.AddArc($x,             $y + $h - $d,   $d, $d,  90, 90)
    $path.CloseFigure()
}

function New-IconGraphics {
    param([System.Drawing.Bitmap]$bmp)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    return $g
}

<# 圆角渐变底（尺寸按 256 基准等比缩放） #>
function Fill-RoundedGradient {
    param([System.Drawing.Graphics]$g, [int]$Size, [System.Drawing.Color]$Col1, [System.Drawing.Color]$Col2, [float]$Angle = 62)
    $f = $Size / 256.0
    $pad = [Math]::Max(1, [int][Math]::Round(2 * $f))
    $side = $Size - 2 * $pad
    $rect = [System.Drawing.Rectangle]::new($pad, $pad, $side, $side)
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    Add-RoundRect $path ([float]$pad) ([float]$pad) ([float]$side) ([float]$side) ([float]([Math]::Max(3, 58 * $f)))
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $Col1, $Col2, $Angle)
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()
}

function ConvertTo-DibFrame {
    param([System.Drawing.Bitmap]$bmp)
    $w = $bmp.Width; $h = $bmp.Height
    $data = $bmp.LockBits(
        [System.Drawing.Rectangle]::new(0, 0, $w, $h),
        [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $raw = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $bmp.UnlockBits($data)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt32]40); $bw.Write([Int32]$w); $bw.Write([Int32]($h * 2))
    $bw.Write([UInt16]1);  $bw.Write([UInt16]32)
    $bw.Write([UInt32]0);  $bw.Write([UInt32]0)
    $bw.Write([Int32]0);   $bw.Write([Int32]0)
    $bw.Write([UInt32]0);  $bw.Write([UInt32]0)
    for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($raw, $y * $stride, $w * 4) }
    $maskRow = [int][Math]::Floor(($w + 31) / 32) * 4
    $bw.Write((New-Object byte[] ($maskRow * $h)))
    $bw.Flush()
    $bytes = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()
    return , $bytes
}

<# 把一批同尺寸的位图写成 .ico（按宽度排序，索引 0 为最小尺寸） #>
function Write-IcoFile {
    param([string]$Path, [System.Drawing.Bitmap[]]$Bitmaps)

    $ordered = $Bitmaps | Sort-Object -Property Width
    $frames = New-Object System.Collections.ArrayList
    foreach ($bmp in $ordered) {
        if ($bmp.Width -le 48) {
            $bytes = ConvertTo-DibFrame -bmp $bmp
        } else {
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $bytes = $ms.ToArray()
            $ms.Dispose()
        }
        [void]$frames.Add([PSCustomObject]@{ Size = [int]$bmp.Width; Bytes = $bytes })
    }

    $fs = [System.IO.File]::Create($Path)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($fr in $frames) {
        $dim = if ($fr.Size -ge 256) { 0 } else { $fr.Size }
        $bw.Write([byte]$dim); $bw.Write([byte]$dim)
        $bw.Write([byte]0);    $bw.Write([byte]0)
        $bw.Write([UInt16]1);  $bw.Write([UInt16]32)
        $bw.Write([UInt32]$fr.Bytes.Length)
        $bw.Write([UInt32]$offset)
        $offset += $fr.Bytes.Length
    }
    foreach ($fr in $frames) { $bw.Write($fr.Bytes) }
    $bw.Flush(); $bw.Dispose(); $fs.Dispose()

    return $frames.Count
}
