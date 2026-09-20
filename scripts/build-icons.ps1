# Rasterize the CH paths from assets/app-icon.svg with transparent backgrounds.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
foreach ($size in @(512, 32)) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform($size / 256.0, $size / 256.0)
    $white = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#faf9f5'), 24)
    $orange = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#d97757'), 24)
    $white.StartCap = $white.EndCap = [Drawing.Drawing2D.LineCap]::Square
    $orange.StartCap = $orange.EndCap = [Drawing.Drawing2D.LineCap]::Square
    $letter = [Drawing.Drawing2D.GraphicsPath]::new()
    $letter.AddBezier(108,66,96,52,84,48,70,48)
    $letter.AddBezier(70,48,39,48,24,77,24,128)
    $letter.AddBezier(24,128,24,179,39,208,70,208)
    $letter.AddBezier(70,208,84,208,96,204,108,190)
    $graphics.DrawPath($white, $letter)
    $graphics.DrawLine($orange,150,52,150,204)
    $graphics.DrawLine($orange,228,52,228,204)
    $graphics.DrawLine($orange,150,128,228,128)
    $filename = if ($size -eq 512) { 'app-icon.png' } else { 'tray-icon.png' }
    $bitmap.Save((Join-Path $root "assets/$filename"), [Drawing.Imaging.ImageFormat]::Png)
    $letter.Dispose(); $white.Dispose(); $orange.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
