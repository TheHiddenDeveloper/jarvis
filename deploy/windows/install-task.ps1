# install-task.ps1
# Registers the Jarvis voice-assistant daemon as a Windows Scheduled Task that
# runs at user logon, in the interactive session (so voice + desktop-control
# tools work), with automatic restart on failure.
#
# Run elevated:
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
#
# Idempotent: removes any existing Jarvis task, then re-registers.

$ErrorActionPreference = "Stop"

# Derive the jarvis root from this script's own location (deploy\windows).
$winDir    = Split-Path -Parent $PSScriptRoot          # ...\deploy
$jarvisDir = Split-Path -Parent $winDir                 # ~\jarvis

$taskName  = "Jarvis"
$node      = "C:\Program Files\nodejs\node.exe"
$daemon    = Join-Path $jarvisDir "server\daemon.js"
$workdir   = Join-Path $jarvisDir "server"
$logDir    = Join-Path $jarvisDir "logs"
$wrapper   = Join-Path $PSScriptRoot "start-jarvis.cmd"
$account   = "AIDEN-PC\rodney"   # interactive account whose profile is C:\Users\rodne

if (-not (Test-Path $node))   { throw "node.exe not found at $node" }
if (-not (Test-Path $daemon)) { throw "daemon.js not found at $daemon" }
if (-not (Test-Path $wrapper)){ throw "start-jarvis.cmd not found at $wrapper" }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# ---- remove any existing task first (idempotent) ----
# Unregister-ScheduledTask throws if the task doesn't exist, so guard it.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# ---- principal: interactive user, limited (non-admin) is fine for desktop ----
$principal = New-ScheduledTaskPrincipal `
    -UserId $account `
    -LogonType Interactive `
    -RunLevel Limited

# ---- triggers: at user logon + at startup ----
$triggerLogon  = New-ScheduledTaskTrigger -AtLogOn -User $account
$triggerStart  = New-ScheduledTaskTrigger -AtStartup

# ---- settings: restart on failure, run regardless, no time limit ----
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

# -- action: call the wrapper cmd (handles logging robustly, no inline redirect) --
$action = New-ScheduledTaskAction `
    -Execute $wrapper `
    -WorkingDirectory $workdir

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($triggerLogon, $triggerStart) `
    -Principal $principal `
    -Settings $settings `
    -Description "Jarvis voice assistant daemon (auto-start at logon)"

Write-Host "Jarvis scheduled task registered."
Write-Host "  Task     : $taskName"
Write-Host "  Account  : $account (interactive)"
Write-Host "  Triggers : at logon + at startup"
Write-Host "  Restart  : up to 5x, 1min apart on failure"
Write-Host "  Logs     : $logDir\jarvis.{out,err}.log"
Write-Host "Start it now: Start-ScheduledTask -TaskName $taskName"
