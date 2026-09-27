<#
.SYNOPSIS
  Open the Livetich admin console through an SSH tunnel.

.DESCRIPTION
  /admin (the dashboard and its API) is refused at the edge to every IP except
  the compose network gateway, which is where requests arriving through an SSH
  tunnel come from (see deploy/ADMIN.md). This script:

    1. opens the tunnel: local port 8443 -> the server's port 443;
    2. starts Edge (or Chrome) in its own profile with both livetich domains
       routed to that port, so the real certificates and CORS still apply;
    3. closes the tunnel when you close that browser window.

  Only this browser window goes through the tunnel; your normal browser and
  the public site are unaffected.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\admin-console.ps1
#>
param(
  [string]$Server = '139.84.239.106',
  [string]$User = 'root',
  [string]$Key = (Join-Path $HOME '.ssh\livetich_admin'),
  [int]$LocalPort = 8443
)

$ErrorActionPreference = 'Stop'

# Chromium browsers can remap a domain to a local port (--host-resolver-rules),
# which is what lets the tunnel use 8443: Windows refuses port 443 to a normal
# user.
$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) {
  throw 'Microsoft Edge or Google Chrome is needed to open the admin console.'
}
if (-not (Test-Path $Key)) {
  throw "No SSH key at $Key. Pass -Key with the path to your server key."
}

Write-Host "Opening the tunnel to $Server ..."
# Same console, so a key passphrase prompt is visible.
$tunnel = Start-Process ssh -PassThru -NoNewWindow -ArgumentList @(
  '-i', $Key,
  '-o', 'IdentitiesOnly=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-N', '-L', "${LocalPort}:localhost:443",
  "$User@$Server"
)

try {
  $deadline = (Get-Date).AddSeconds(120)
  while ($true) {
    if ($tunnel.HasExited) {
      throw 'The tunnel could not start. Check the key, and that port 22 on the server is reachable.'
    }
    try {
      $probe = [Net.Sockets.TcpClient]::new('127.0.0.1', $LocalPort)
      $probe.Dispose()
      break
    } catch {
      if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for the tunnel.' }
      Start-Sleep -Milliseconds 300
    }
  }

  # A profile of its own: the routing flags only take effect in a fresh browser
  # process, and the admin sign-in stays separate from everyday browsing.
  $profileDir = Join-Path $env:LOCALAPPDATA 'livetich-admin-browser'
  $rules = "MAP livetich.nekan.dev 127.0.0.1:$LocalPort, MAP api.livetich.nekan.dev 127.0.0.1:$LocalPort"

  Write-Host 'Tunnel open. Close the admin browser window to disconnect.'
  Start-Process $browser -Wait -ArgumentList @(
    "--user-data-dir=`"$profileDir`"",
    "--host-resolver-rules=`"$rules`"",
    # HTTP/3 would try UDP to the real server and bypass the tunnel.
    '--disable-quic',
    '--no-first-run',
    '--new-window',
    'https://livetich.nekan.dev/admin'
  )
} finally {
  if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  Write-Host 'Tunnel closed.'
}
