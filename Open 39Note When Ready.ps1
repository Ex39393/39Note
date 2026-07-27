param(
  [string]$Url = 'http://127.0.0.1:5173/',
  [string]$LogPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$maximumAttempts = 40
$retryDelayMilliseconds = 500

for ($attempt = 1; $attempt -le $maximumAttempts; $attempt += 1) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1
    if ($response.StatusCode -ge 200) {
      if ($LogPath) {
        Add-Content -LiteralPath $LogPath -Value "[$(Get-Date -Format s)] Server ready; opening the default browser."
      }
      Write-Host "39Note is ready. Opening $Url in the default browser."
      Start-Process -FilePath $Url
      exit 0
    }
  } catch {
    # The server is still starting. Retry within the bounded readiness window.
  }

  Start-Sleep -Milliseconds $retryDelayMilliseconds
}

if ($LogPath) {
  Add-Content -LiteralPath $LogPath -Value "[$(Get-Date -Format s)] Server readiness timed out after 20 seconds."
}
Write-Error "39Note did not respond at $Url within 20 seconds. Review the server output for a port conflict or startup error."
exit 1
