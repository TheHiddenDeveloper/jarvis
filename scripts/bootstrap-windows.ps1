# bootstrap-windows.ps1
# Replicates the Jarvis AI-agent environment on a Windows machine.
# Run from PowerShell (as the user, not admin):  iex "& { $(iwr -useb <raw-url>) }"
# or clone the jarvis repo first, then:  pwsh scripts/bootstrap-windows.ps1
#
# What this does:
#   1. Checks for Git, Python 3.11+, Node 18+ (offers winget install if missing)
#   2. Clones the three sync repos (jarvis, vault, skills) under $BaseDir
#   3. Sets up JS deps (npm install) for the server + MCP servers
#   4. Creates a Python venv for the Jarvis server/scripts
#   5. Copies .env.template -> .env and reminds you to fill in secrets
#
# What it does NOT do (manual / OS-specific):
#   - Fill real secrets into .env  (keep these out of git!)
#   - Register the MCP server in your agent client (opencode/claude) config
#   - Desktop automation (ydotool/wtype/piper/whisper) is Linux/Wayland only;
#     on Windows the core agent + vault + cross-platform MCP tools still work.

param(
    [string]$BaseDir = "$env:USERPROFILE\jarvis-env",
    [string]$GitHubUser = "TheHiddenDeveloper"
)

$ErrorActionPreference = "Stop"

function Need { param([string]$cmd)
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Warning "Missing: $cmd"
        return $false
    }
    return $true
}

Write-Host "`n==> Jarvis Windows bootstrap" -ForegroundColor Cyan
Write-Host "    Base dir : $BaseDir"
Write-Host "    GitHub   : $GitHubUser`n"

# --- 1. Prerequisites ---
$ok = $true
if (-not (Need git))        { $ok = $false }
if (-not (Need python))     { $ok = $false }
if (-not (Need node))       { $ok = $false }
if (-not (Need npm))        { $ok = $false }
if (-not $ok) {
    Write-Host "`nInstall missing tools, e.g.:  winget install Git.Git Python.Python.3.11 OpenJS.NodeJS.LTS" -ForegroundColor Yellow
    exit 1
}

# --- 2. Clone repos ---
New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
Set-Location $BaseDir

function Clone { param([string]$repo, [string]$dest)
    if (Test-Path $dest) { Write-Host "  (skip) $dest already exists" }
    else { git clone "https://github.com/$GitHubUser/$repo.git" $dest }
}

Clone "jarvis"           "jarvis"
Clone "Ideaverse"        "vault"      # Obsidian vault (open in Obsidian)
Clone "jarvis-skills"    "skills"

# --- 3. JS deps (server + MCP servers) ---
function NpmInstall { param([string]$dir)
    if (-not (Test-Path "$dir/package.json")) { return }
    Write-Host "  npm install in $dir"
    Push-Location $dir; npm install --no-audit --no-fund; Pop-Location
}

NpmInstall "jarvis/server"
NpmInstall "jarvis/mcp/jarvis-tools"
NpmInstall "jarvis/mcp/filesystem"
NpmInstall "jarvis/mcp/ai-vision-mcp"
NpmInstall "jarvis/mcp/playwright"

# --- 4. Python venv for server/scripts ---
Write-Host "  creating Python venv: jarvis/.venv"
Push-Location "jarvis"
if (-not (Test-Path ".venv")) { python -m venv .venv }
& "./.venv/Scripts/Activate.ps1"
if (Test-Path "requirements.txt") { pip install -r requirements.txt }
if (Test-Path "server/requirements.txt") { pip install -r server/requirements.txt }
Pop-Location

# --- 5. Secrets ---
$vaultEnv = "$BaseDir\jarvis\.env"
if (-not (Test-Path $vaultEnv)) {
    Copy-Item "$BaseDir\jarvis\.env.template" $vaultEnv
    Write-Host "`n  Copied .env.template -> .env" -ForegroundColor Yellow
    Write-Host "  >>> EDIT $vaultEnv and fill in real secrets (DO NOT commit it)" -ForegroundColor Red
}

# --- 6. Place skills where the agent loads them ---
$agentsSkills = "$env:USERPROFILE\.agents\skills"
Write-Host "`n  Agent skills dir: $agentsSkills"
Write-Host "  To use the synced skills, either:"
Write-Host "    (a) symlink:  cmd /c mklink /D `"$agentsSkills`" `"$BaseDir\skills`""
Write-Host "    (b) or just point your client at $BaseDir\skills"

Write-Host "`n==> Done. Next manual steps:" -ForegroundColor Green
Write-Host "  1. Fill secrets in $vaultEnv"
Write-Host "  2. Register the MCP server (jarvis/mcp/jarvis-tools) in your agent client config."
Write-Host "  3. Open $BaseDir\vault in Obsidian (set vault path)."
Write-Host "  4. Start the server:  Push-Location $BaseDir\jarvis\server; npm start`n"
