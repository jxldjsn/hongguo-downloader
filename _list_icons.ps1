$file = 'src\components\icons\index.jsx'
$lines = Get-Content $file
foreach ($line in $lines) {
  if ($line -match '^export const (\w+)') {
    Write-Host $matches[1]
  }
}
