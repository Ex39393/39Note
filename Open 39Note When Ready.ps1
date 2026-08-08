param(
  [string]$Url = 'http://127.0.0.1:5173/',
  [string]$LogPath = '',
  [switch]$ProbeOnly
)

$ErrorActionPreference = 'SilentlyContinue'
$maximumAttempts = 40
$retryDelayMilliseconds = 500
$expectedIdentity = '39Note::local-pdf-reader::v1'
$identityUrl = [Uri]::new([Uri]$Url, '39note-app-id.txt').AbsoluteUri

function Write-LaunchLog {
  param([string]$Message)

  if ($LogPath) {
    Add-Content -LiteralPath $LogPath -Value "[$(Get-Date -Format s)] $Message"
  }
}

function Test-PortInUse {
  try {
    $uri = [Uri]$Url
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $connection = $client.ConnectAsync($uri.Host, $uri.Port)
      return $connection.Wait(500) -and $client.Connected
    } finally {
      $client.Dispose()
    }
  } catch {
    return $false
  }
}

function Get-39NoteServerState {
  if (-not (Test-PortInUse)) {
    return 'Unavailable'
  }

  try {
    $rootResponse = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    if ($rootResponse.StatusCode -lt 200 -or $rootResponse.StatusCode -ge 400) {
      return 'Conflict'
    }

    $identityResponse = Invoke-WebRequest -UseBasicParsing -Uri $identityUrl -TimeoutSec 2
    if (
      $identityResponse.StatusCode -ge 200 -and
      $identityResponse.StatusCode -lt 400 -and
      $identityResponse.Content.Trim() -ceq $expectedIdentity
    ) {
      return '39Note'
    }

    return 'Conflict'
  } catch {
    if (Test-PortInUse) {
      return 'Conflict'
    }

    return 'Unavailable'
  }
}

if ($ProbeOnly) {
  $state = Get-39NoteServerState
  if ($state -eq '39Note') {
    exit 0
  }
  if ($state -eq 'Conflict') {
    Write-LaunchLog 'ERROR: Port 5173 is currently being used by another application.'
    exit 2
  }
  exit 1
}

for ($attempt = 1; $attempt -le $maximumAttempts; $attempt += 1) {
  $state = Get-39NoteServerState
  if ($state -eq '39Note') {
    Write-LaunchLog 'Verified 39Note identity; opening the default browser.'
    Write-Host "39Note is ready. Opening $Url in the default browser."
    Start-Process -FilePath $Url
    exit 0
  }
  if ($state -eq 'Conflict') {
    Write-LaunchLog 'ERROR: Port 5173 is currently being used by another application. The browser was not opened.'
    Write-Error 'Port 5173 is currently being used by another application. Close that application and start 39Note again.'
    exit 2
  }

  Start-Sleep -Milliseconds $retryDelayMilliseconds
}

Write-LaunchLog 'ERROR: Server readiness timed out after 20 seconds.'
Write-Error "39Note did not respond at $Url within 20 seconds. Review the server output for a port conflict or startup error."
exit 1
