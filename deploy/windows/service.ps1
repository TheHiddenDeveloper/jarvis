# service.ps1
# Manage the Jarvis Windows service: status | start | stop | restart | logs
#   powershell -ExecutionPolicy Bypass -File service.ps1 status
#   powershell -ExecutionPolicy Bypass -File service.ps1 restart

param(
    [Parameter(Position = 0)]
    [ValidateSet("status", "start", "stop", "restart", "logs", "help")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$jarvisDir = Join-Path $env:USERPROFILE "jarvis"
$nssm      = Join-Path $jarvisDir "server\bin\nssm.exe"
$logDir    = Join-Path $jarvisDir "logs"
$service   = "Jarvis"

function Show-Status {
    $svc = Get-Service -Name $service -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Output "Service '$service' is NOT installed. Run install-service.ps1"
        exit 1
    }
    Write-Output ("Service : {0}" -f $svc.Name)
    Write-Output ("Status  : {0}" -f $svc.Status)
    Write-Output ("Start   : {0}" -f $svc.StartType)
    $proc = Get-CimInstance Win32_Service -Filter "Name='$service'" -ErrorAction SilentlyContinue
    if ($proc) { Write-Output ("PID     : {0}" -f $proc.ProcessId) }
}

switch ($Action) {
    "status" { Show-Status }
    "start" {
        if (-not (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw "Service not installed. Run install-service.ps1" }
        Start-Service -Name $service
        Start-Sleep -Seconds 2
        Show-Status
    }
    "stop" {
        if (-not (Get-Service -Name $service -ErrorAction SilentlyContinue)) { Write-Output "Service not installed."; exit 1 }
        Stop-Service -Name $service -Force
        Start-Sleep -Seconds 2
        Show-Status
    }
    "restart" {
        if (-not (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw "Service not installed. Run install-service.ps1" }
        Restart-Service -Name $service
        Start-Sleep -Seconds 2
        Show-Status
    }
    "logs" {
        if (-not (Test-Path $logDir)) { Write-Output "No logs directory yet."; exit 0 }
        Get-ChildItem $logDir -Filter "jarvis*.log" | Sort-Object LastWriteTime -Descending | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
    }
    "help" {
        Write-Output "Usage: service.ps1 {status|start|stop|restart|logs|help}"
    }
}
