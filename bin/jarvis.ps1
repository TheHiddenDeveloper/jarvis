# jarvis — command-line front door to the Jarvis agent.
#
# Usage:
#   jarvis "do something"      one-shot task
#   jarvis                     interactive session (chat)
#   jarvis --voice             spoken conversation (mic -> Whisper -> reply via TTS)
#
# Wraps: opencode run --agent jarvis

param(
    [switch]$h,
    [switch]$help,
    [switch]$interactive,
    [switch]$voice
)

if ($h -or $help) {
    Write-Host "Usage: jarvis [options] [task]"
    Write-Host "  -h, --help          Show this help"
    Write-Host "  -i, --interactive   Interactive chat session"
    Write-Host "  --voice             Voice conversation mode"
    Write-Host "  [task]              One-shot task"
    exit 0
}

$OPENCODE_BIN = if ($env:OPENCODE_BIN) { $env:OPENCODE_BIN } else { "opencode" }

if ($interactive) {
    & $OPENCODE_BIN run --agent jarvis --interactive
    exit $LASTEXITCODE
}

if ($voice) {
    & "$PSScriptRoot\voice-loop.ps1"
    exit $LASTEXITCODE
}

if ($args.Count -eq 0) {
    Write-Host "Usage: jarvis [options] [task]"
    Write-Host "  -h, --help          Show this help"
    Write-Host "  -i, --interactive   Interactive chat session"
    Write-Host "  --voice             Voice conversation mode"
    Write-Host "  [task]              One-shot task"
    exit 0
}

& $OPENCODE_BIN run --agent jarvis $args
exit $LASTEXITCODE
