# voice-loop.ps1 — Interactive spoken conversation loop.
#
#  1. Records a fixed window from the default DirectShow mic.
#  2. Transcribes with faster-whisper.
#  3. Sends the transcript to the jarvis agent.
#  4. Repeats. Ctrl+C or say "exit" to quit.

$JARVIS_DIR = if ($env:JARVIS_DIR) { $env:JARVIS_DIR } else { "$PSScriptRoot\.." }
$VENV_PY = "$JARVIS_DIR\venv\Scripts\python.exe"
$TRANSCRIBE = "$JARVIS_DIR\scripts\transcribe.py"
$OPENCODE_BIN = if ($env:OPENCODE_BIN) { $env:OPENCODE_BIN } else { "opencode" }
$SAY = "$PSScriptRoot\say.ps1"
$WORK = Join-Path $env:TEMP "jarvis-voice"
$SESSION_FILE = "$WORK\session.id"

if (-not (Test-Path $WORK)) { New-Item -ItemType Directory -Path $WORK -Force | Out-Null }

$MIC = if ($env:JARVIS_MIC) { $env:JARVIS_MIC } else { "default" }
$WIN = if ($env:JARVIS_VOICE_WINDOW) { [int]$env:JARVIS_VOICE_WINDOW } else { 6 }

function Capture {
    $out = "$WORK\in.wav"
    # Record from DirectShow audio device
    if ($MIC -eq "default") {
        # Find the default audio device name from daemon.js state or use first available
        $devFile = Join-Path $JARVIS_DIR "state\mic-source.txt"
        if (Test-Path $devFile) {
            $MIC = Get-Content $devFile -Raw
        } else {
            # Fallback: use first available DirectShow audio device
            $devices = & ffmpeg -f dshow -list_devices true -i dummy 2>&1 | Select-String -Pattern "(audio)" | Select-Object -First 1
            if ($devices -match '"([^"]+)"') {
                $MIC = $Matches[1]
            } else {
                Write-Host "No audio device found. Set JARVIS_MIC env var."
                return $null
            }
        }
    }
    & ffmpeg -y -f dshow -i "audio=$MIC" -t $WIN -af "volume=8dB" "$out" 2>$null
    if (-not (Test-Path $out)) { return $null }
    # Check volume level
    $output = & ffmpeg -i "$out" -af volumedetect -f null - 2>&1
    $maxv = -90
    if ($output -match 'max_volume:\s*([-\d.]+)') {
        $maxv = [double]$Matches[1]
    }
    return @{ File = $out; MaxV = $maxv }
}

function RunAgent {
    param([string]$Prompt)
    $sid = if (Test-Path $SESSION_FILE) { Get-Content $SESSION_FILE -Raw } else { "" }
    if ($sid) {
        & $OPENCODE_BIN run -s $sid.Trim() --agent jarvis $Prompt 2>$null | Select-Object -Last 3
    } else {
        & $OPENCODE_BIN run --agent jarvis --title "jarvis voice" $Prompt 2>$null | Select-Object -Last 3
        $line = & $OPENCODE_BIN session list 2>$null | Select-String "jarvis voice" | Select-Object -First 1
        if ($line -match '^\s*(\S+)') {
            Set-Content $SESSION_FILE $Matches[1]
        }
    }
}

Write-Host "Jarvis voice mode. Speak within the window after the prompt. Ctrl+C or say 'exit' to quit."
Write-Host

while ($true) {
    Write-Host -NoNewline "listening ($WIN s window)... "
    $result = Capture
    if ($null -eq $result) {
        Write-Host "recording failed, retrying."
        continue
    }
    $maxv = $result.MaxV
    if ($maxv -lt -40) {
        Write-Host "nothing heard ($maxv dB), retrying."
        continue
    }
    Write-Host "heard you ($maxv dB), transcribing..."
    $text = & $VENV_PY $TRANSCRIBE $result.File 2>$null
    $text = $text.Trim()
    if ([string]::IsNullOrEmpty($text)) {
        Write-Host "(didn't catch that)"
        continue
    }
    Write-Host "you: $text"

    if ($text -match '^(exit|quit|goodbye|bye|stop jarvis|that.s all)$') {
        Write-Host "Goodbye."
        & $SAY "Goodbye"
        break
    }

    RunAgent "You are in VOICE MODE (user speaks to you via microphone). Answer conversationally and briefly (1-3 short sentences, suitable for spoken reply). SPEAK your reply aloud using the jarvis-tools 'say' tool. Transcript: $text"
    Write-Host
}
