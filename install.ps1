# Installs the latest Claude Usage Bar release into VS Code.
$ErrorActionPreference = 'Stop'

$release = Invoke-RestMethod 'https://api.github.com/repos/IvanLazic2/claude-usage-bar/releases/latest'
$asset = $release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $asset) { throw 'No .vsix found in the latest release.' }

$file = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $file
try {
    code --install-extension $file --force
} finally {
    Remove-Item $file -ErrorAction SilentlyContinue
}
