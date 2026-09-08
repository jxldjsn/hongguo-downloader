const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const srcDir = 'C:\\Users\\c1732\\Desktop\\项目等等\\抖音下载1\\抖音下载器安装包';
const tempDir = 'C:\\Temp\\portable-build';
const zipPath = path.join(srcDir, '抖音下载器-便携版-1.0.0.zip');

// Clean and create temp dir
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true });
}
fs.mkdirSync(tempDir, { recursive: true });

// Copy program folder
const programDir = path.join(tempDir, '抖音下载器');
fs.cpSync(path.join(srcDir, 'win-unpacked'), programDir, { recursive: true });

// Create shortcut using PowerShell
const lnkPath = path.join(tempDir, '抖音下载器.lnk');
const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${lnkPath.replace(/\\/g, '\\\\')}')
$Shortcut.TargetPath = '.\\抖音下载器\\抖音下载器.exe'
$Shortcut.WorkingDirectory = '.\\抖音下载器'
$Shortcut.Description = 'Douyin Downloader'
$Shortcut.Save()
`;

execSync(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`, { encoding: 'utf8' });

// Remove old zip
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Create zip
execSync(`powershell -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${zipPath}'"`, { encoding: 'utf8' });

// Cleanup
fs.rmSync(tempDir, { recursive: true });

console.log('Portable zip created:', zipPath);
