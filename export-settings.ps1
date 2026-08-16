# export-settings.ps1
param(
    [string]$Editor = "code"
)

$editorCommand = if ($Editor -eq "code") { "code" } else { "cursor" }

# Check if the command exists
$editorExists = Get-Command $editorCommand -ErrorAction SilentlyContinue

if (-not $editorExists) {
    Write-Host "Error: $editorCommand command not found!" -ForegroundColor Red
    exit 1
}

# Paths to settings
$settingsPath = if ($Editor -eq "code") {
    "$env:APPDATA\Code\User\settings.json"
} else {
    "$env:APPDATA\Cursor\User\settings.json"
}

$keybindingsPath = if ($Editor -eq "code") {
    "$env:APPDATA\Code\User\keybindings.json"
} else {
    "$env:APPDATA\Cursor\User\keybindings.json"
}

# Copy settings
if (Test-Path $settingsPath) {
    Copy-Item $settingsPath -Destination "settings.json" -Force
    Write-Host "✓ Settings exported to settings.json" -ForegroundColor Green
} else {
    Write-Host "✗ Settings file not found at: $settingsPath" -ForegroundColor Yellow
}

# Copy keybindings
if (Test-Path $keybindingsPath) {
    Copy-Item $keybindingsPath -Destination "keybindings.json" -Force
    Write-Host "✓ Keybindings exported to keybindings.json" -ForegroundColor Green
} else {
    Write-Host "✗ Keybindings file not found at: $keybindingsPath" -ForegroundColor Yellow
}

Write-Host "`nDone! Settings exported." -ForegroundColor Green