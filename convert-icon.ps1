Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('C:\Users\c1732\Desktop\项目等等\抖音下载1\抖音下载器win版\图标.jpg')
$img.Save('C:\Users\c1732\Desktop\项目等等\抖音下载1\抖音下载器win版\build\icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
Write-Host "PNG created successfully"
