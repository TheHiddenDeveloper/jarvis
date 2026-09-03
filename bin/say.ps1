# say.ps1 — Speak text aloud via piper (neural TTS). Text from first argument or stdin.
# Falls back to Windows System.Speech if piper is unavailable.

param(
    [string]$Text
)

$JARVIS_DIR = if ($env:JARVIS_DIR) { $env:JARVIS_DIR } else { "$PSScriptRoot\.." }
$MODEL = if ($env:JARVIS_PIPER_MODEL) { $env:JARVIS_PIPER_MODEL } else { "$JARVIS_DIR\models\piper\en_US-lessac-medium.onnx" }
$PIPER = if ($env:JARVIS_PIPER) { $env:JARVIS_PIPER } else { "$JARVIS_DIR\venv\Scripts\piper.exe" }
$SPEED = if ($env:JARVIS_PIPER_SPEED) { $env:JARVIS_PIPER_SPEED } else { "1.0" }
$RATE = 22050

if ([string]::IsNullOrEmpty($Text)) {
    $Text = [Console]::In.ReadToEnd()
}
if ([string]::IsNullOrEmpty($Text.Trim())) { exit 0 }

if ((Test-Path $PIPER) -and (Test-Path $MODEL)) {
    # Use piper TTS -> ffplay
    $tmpWav = Join-Path $env:TEMP "jarvis-speak.wav"
    $Text | & $PIPER --model $MODEL --length-scale $SPEED --output-raw 2>$null | `
        & ffmpeg -y -f s16le -ar $RATE -ac 1 -i pipe:0 "$tmpWav" 2>$null
    if (Test-Path $tmpWav) {
        & ffplay -nodisp -autoexit -loglevel quiet "$tmpWav" 2>$null
        Remove-Item $tmpWav -ErrorAction SilentlyContinue
    }
} else {
    # Fallback: Windows built-in speech synthesis
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.Speak($Text)
}
