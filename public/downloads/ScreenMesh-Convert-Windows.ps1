# ScreenMesh local video converter for Windows.
# Right-click and choose "Run with PowerShell", or run:
#   powershell -ExecutionPolicy Bypass -File .\ScreenMesh-Convert-Windows.ps1 "C:\Videos\master.mov"
[CmdletBinding()]
param([Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$InputPath)

$ErrorActionPreference = 'Stop'
$ProfileName = 'ScreenMesh V1: H.264 High@4.1, yuv420p, CRF 20, max 1920x1080, max 30 fps, AAC 160k'
$passed = 0; $failed = 0; $skipped = 0

function Require-Command([string]$Name, [string]$InstallHelp) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    Write-Host "Missing $Name. $InstallHelp" -ForegroundColor Red
    exit 2
  }
  return $command.Source
}

function Get-VideoInfo([string]$Path, [string]$Ffprobe) {
  try {
    $json = & $Ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,avg_frame_rate -show_entries format=duration -of json -- $Path 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $null -eq $json.streams -or $json.streams.Count -eq 0) { return $null }
    return $json
  } catch { return $null }
}

function Get-OutputPath([System.IO.FileInfo]$Source) {
  $directory = Join-Path $Source.DirectoryName 'ScreenMesh Converted'
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($Source.Name)
  $candidate = Join-Path $directory "$stem.screenmesh.mp4"
  $duplicate = 2
  while (Test-Path -LiteralPath $candidate) {
    $candidate = Join-Path $directory "$stem.screenmesh ($duplicate).mp4"
    $duplicate += 1
  }
  return $candidate
}

function Convert-File([System.IO.FileInfo]$Source, [string]$Ffmpeg, [string]$Ffprobe) {
  if ($Source.Name.EndsWith('.screenmesh.mp4', [System.StringComparison]::OrdinalIgnoreCase) -or $Source.DirectoryName -match '[\\/]ScreenMesh Converted$') {
    Write-Host "SKIPPED  $($Source.FullName)" -ForegroundColor Yellow; $script:skipped += 1; return
  }
  $inputInfo = Get-VideoInfo $Source.FullName $Ffprobe
  if ($null -eq $inputInfo) {
    Write-Host "SKIPPED  $($Source.Name) (no readable video stream)" -ForegroundColor Yellow; $script:skipped += 1; return
  }
  $stream = $inputInfo.streams[0]
  Write-Host "Input: $($Source.Name) - $($stream.width)x$($stream.height), $($inputInfo.format.duration)s, $($stream.avg_frame_rate) fps"
  $output = Get-OutputPath $Source
  $temporary = $output -replace '\.mp4$', '.partial.mp4'
  $arguments = @('-hide_banner', '-y', '-i', $Source.FullName, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-maxrate', '12M', '-bufsize', '24M', '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-fpsmax', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', $temporary)
  & $Ffmpeg @arguments
  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $temporary)) {
    Move-Item -LiteralPath $temporary -Destination $output -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $output) {
      $outputInfo = Get-VideoInfo $output $Ffprobe
      $sizeMiB = [math]::Round((Get-Item -LiteralPath $output).Length / 1MB, 1)
      if ($outputInfo) { $summary = "$($outputInfo.streams[0].width)x$($outputInfo.streams[0].height), $($outputInfo.streams[0].codec_name) $($outputInfo.streams[0].profile)" }
      else { $summary = 'metadata unavailable' }
      Write-Host "PASS     $output - $summary, $sizeMiB MiB" -ForegroundColor Green; $script:passed += 1; return
    }
  }
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  Write-Host "FAILED   $($Source.Name) - FFmpeg did not create a complete output file." -ForegroundColor Red; $script:failed += 1
}

$ffmpeg = Require-Command 'ffmpeg' 'Install FFmpeg first (for example: winget install Gyan.FFmpeg).'
$ffprobe = Require-Command 'ffprobe' 'Install FFmpeg first (for example: winget install Gyan.FFmpeg).'
Write-Host "ScreenMesh local converter - $ProfileName"
if (-not $InputPath -or $InputPath.Count -eq 0) { Write-Host 'Drag video files or folders onto this script, or pass paths in PowerShell.'; exit 1 }

foreach ($item in $InputPath) {
  if (-not (Test-Path -LiteralPath $item)) { Write-Host "FAILED   $item (path not found)" -ForegroundColor Red; $failed += 1; continue }
  $entry = Get-Item -LiteralPath $item
  if ($entry.PSIsContainer) {
    Get-ChildItem -LiteralPath $entry.FullName -File -Recurse | Where-Object { $_.DirectoryName -notmatch '[\\/]ScreenMesh Converted([\\/]|$)' -and -not $_.Name.EndsWith('.screenmesh.mp4', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Convert-File $_ $ffmpeg $ffprobe }
  } else { Convert-File $entry $ffmpeg $ffprobe }
}
Write-Host "Finished: PASS $passed  FAILED $failed  SKIPPED $skipped"
exit $(if ($failed -gt 0) { 1 } else { 0 })
