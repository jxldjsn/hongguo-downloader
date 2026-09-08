$file = 'src\components\icons\index.jsx'
$icons = @('Play','Share2','Bookmark','ExternalLink','Link2','Heart','MessageSquare','Film','Download','BarChart3','Flame','X')
$lines = Get-Content $file
foreach ($name in $icons) {
  $found = $lines | Where-Object { $_ -match "^export const $name\b" }
  if ($found) { Write-Host "OK  $name" } else { Write-Host "MISSING  $name" }
}
