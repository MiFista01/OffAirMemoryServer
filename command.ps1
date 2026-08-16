# install-extensions.ps1
param(
    [string]$Editor = "code"
)

$editorCommand = if ($Editor -eq "code") { "code" } else { "cursor" }

# Check if the command exists
$editorExists = Get-Command $editorCommand -ErrorAction SilentlyContinue

if (-not $editorExists) {
    Write-Host "Error: $editorCommand command not found!" -ForegroundColor Red
    Write-Host "Make sure $Editor is installed and added to PATH." -ForegroundColor Yellow
    exit 1
}

if (Test-Path "extensions.list") {
    Write-Host "Installing extensions from extensions.list using $editorCommand..." -ForegroundColor Green
    $extensions = Get-Content extensions.list
    $total = $extensions.Count
    $current = 0
    
    foreach ($extension in $extensions) {
        $current++
        Write-Host "[$current/$total] Installing: $extension" -ForegroundColor Yellow
        & $editorCommand --install-extension $extension
    }
    
    Write-Host "Done! Installed $total extensions." -ForegroundColor Green
} else {
    Write-Host "extensions.list not found!" -ForegroundColor Red
    exit 1
}