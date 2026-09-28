# Rebuild and verify the downloadable Windows converter package.
# Compatible with Windows PowerShell 5.1.
[CmdletBinding()]
param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$downloads = Join-Path $root 'public\downloads'
$names = @('ScreenMesh-Convert-Windows.cmd', 'ScreenMesh-Convert-Windows.ps1')
$archivePath = Join-Path $downloads 'ScreenMesh-Convert-Windows.zip'

if (-not $VerifyOnly) {
  Compress-Archive -LiteralPath ($names | ForEach-Object { Join-Path $downloads $_ }) -DestinationPath $archivePath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($name in $names) {
    $entry = $archive.GetEntry($name)
    if ($null -eq $entry) { throw "Missing $name in $archivePath" }
    $stream = $entry.Open()
    $memory = New-Object System.IO.MemoryStream
    try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
    $packagedHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($memory.ToArray())).Replace('-', '')
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $downloads $name) -Algorithm SHA256).Hash
    if ($packagedHash -ne $sourceHash) { throw "Packaged $name does not match its source file." }
  }
} finally {
  $archive.Dispose()
}

Write-Host 'Windows converter ZIP matches the current CMD and PowerShell source files.'
