$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Choose your local Git repository'
$picker.ShowNewFolderButton = $false
try {
    if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Write($picker.SelectedPath)
    }
} finally {
    $picker.Dispose()
    $owner.Dispose()
}
