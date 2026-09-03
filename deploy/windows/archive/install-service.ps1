# install-service.ps1
# Registers the Jarvis voice-assistant daemon as a Windows service via NSSM
# and starts it. Run with admin rights:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
#
# Removes any pre-existing Jarvis service, then (re)installs with:
#   - Auto-restart on crash with 3s cooldown
#   - stdout/stderr redirected to ~/jarvis/logs/ with NSSM rotation
#   - Startup type: Automatic (Delayed) so the network is up first

$ErrorActionPreference = "Stop"

$jarvisDir = Join-Path $env:USERPROFILE "jarvis"
$nssm      = Join-Path $jarvisDir "server\bin\nssm.exe"
$node      = "C:\Program Files\nodejs\node.exe"
$daemon    = Join-Path $jarvisDir "server\daemon.js"
$workdir   = Join-Path $jarvisDir "server"
$logDir    = Join-Path $jarvisDir "logs"
$service   = "Jarvis"

if (-not (Test-Path $nssm))   { throw "NSSM not found at $nssm. Run: winget install NSSM.NSSM, then copy win64\nssm.exe to server\bin\nssm.exe" }
if (-not (Test-Path $node))   { throw "node.exe not found at $node" }
if (-not (Test-Path $daemon)) { throw "daemon.js not found at $daemon" }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# ---- sanity: confirm user is admin ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warning "Not running as Administrator. Service install may fail."
}

# ---- stop + remove any existing service first (idempotent reinstall) ----
# Use Get-Service to test existence; nssm errors on a missing service, which
# would trip $ErrorActionPreference=Stop on a first-time install.
if (Get-Service -Name $service -ErrorAction SilentlyContinue) {
    & $nssm stop $service 2>$null | Out-Null
    & $nssm remove $service confirm 2>$null | Out-Null
    Start-Sleep -Milliseconds 500
}

# ---- install ----
& $nssm install $service $node $daemon
if ($LASTEXITCODE -ne 0) { throw "nssm install failed (exit $LASTEXITCODE)" }

# ---- command path / app dir / args ----
& $nssm set $service AppDirectory $workdir
# OPENCODE_BIN points straight at opencode.cmd so PATH need not include it.
# NSSM stores multiple AppEnvironmentExtra values as one newline-joined string,
# so pass them all in a single call.
& $nssm set $service AppEnvironmentExtra "NODE_ENV=production" "OPENCODE_BIN=$env:APPDATA`\npm\opencode.cmd"

# ---- exit / restart behaviour ----
& $nssm set $service AppExit Default Restart
& $nssm set $service AppRestartDelay 3000
& $nssm set $service Start SERVICE_AUTO_START   # Automatic (Delayed) below
& $nssm set $service Type SERVICE_WIN32_OWN_PROCESS
& $nssm set $service AppNoConsole 1

# Delayed start so networking + user session are ready
& $nssm set $service Start SERVICE_DELAYED_AUTO_START

# ---- logging with rotation ----
& $nssm set $service AppStdout (Join-Path $logDir "jarvis.out.log")
& $nssm set $service AppStderr (Join-Path $logDir "jarvis.err.log")
& $nssm set $service AppRotateFiles 1
& $nssm set $service AppRotateOnline 1
& $nssm set $service AppRotateBytes 10485760   # 10 MB per file
& $nssm set $service AppRotateBytesHigh 41943040 # 40 MB cap before truncate

# ---- display name ----
& $nssm set $service DisplayName "Jarvis Voice Assistant"

# ---- start ----
& $nssm start $service
if ($LASTEXITCODE -ne 0) { throw "nssm start failed (exit $LASTEXITCODE)" }

Write-Host "Jarvis service installed and started."
Write-Host "  Service : $service"
Write-Host "  Daemon  : $daemon"
Write-Host "  Logs    : $logDir\jarvis.*.log"
Write-Host "Logs rotate at 10 MB; newest is jarvis.<pid>.log / override in registry."
