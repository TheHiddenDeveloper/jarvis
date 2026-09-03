# uninstall-service.ps1
# Stops and removes the Jarvis Windows service. Run with admin rights:
#   powershell -ExecutionPolicy Bypass -File uninstall-service.ps1

$ErrorActionPreference = "Stop"

$jarvisDir = Join-Path $env:USERPROFILE "jarvis"
$nssm      = Join-Path $jarvisDir "server\bin\nssm.exe"
$service   = "Jarvis"

if (-not (Test-Path $nssm))   { throw "NSSM not found at $nssm" }

$svc = Get-Service -Name $service -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "Service '$service' is not installed. Nothing to do."
    exit 0
}

& $nssm stop $service 2>$null | Out-Null
Start-Sleep -Milliseconds 500
& $nssm remove $service confirm
if ($LASTEXITCODE -ne 0) { throw "nssm remove failed (exit $LASTEXITCODE)" }

Write-Host "Jarvis service removed."
