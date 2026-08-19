# bootstrap-windows.ps1
# One-command replication of the Jarvis AI-agent environment on Windows.
# Run from PowerShell (as the user):
#   iex "& { $(iwr -useb https://raw.githubusercontent.com/TheHiddenDeveloper/jarvis/master/scripts/bootstrap-windows.ps1) }"
#
# What it does:
#   1. Ensures Git, Python 3.11+, Node 18+ (auto winget-installs if missing)
#   2. Clones the three sync repos (jarvis, vault, skills) under $BaseDir
#   3. npm install for the server + MCP servers
#   4. Creates a Python venv for the Jarvis server/scripts
#   5. Copies .env.template -> .env and reminds you to fill in secrets
#   6. Links the skills library into the agent's load path ($HOME/.agents/skills)
#
# Manual / OS-specific (cannot be fully automated):
#   - Fill real secrets into .env  (kept out of git on purpose)
#   - Register the MCP server in your agent client (opencode/claude) config
#   - Desktop automation (ydotool/wtype/piper/whisper) is Linux/Wayland only;
#     the core agent + vault + cross-platform MCP tools still work on Windows.

param(
    [string]$BaseDir = "$env:USERPROFILE\jarvis-env",
    [string]$GitHubUser = "TheHiddenDeveloper",
    [switch]$NoPrereqInstall = $false
)

$ErrorActionPreference = "Stop"

function Need { param([string]$cmd)
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function InstallPrereqs {
    $pkgs = @()
    if (-not (Need git))    { $pkgs += "Git.Git" }
    if (-not (Need python)) { $pkgs += "Python.Python.3.11" }
    if (-not (Need node))   { $pkgs += "OpenJS.NodeJS.LTS" }
    if ($pkgs.Count -eq 0) { return }
    if (-not (Need winget)) { Write-Warning "winget missing; install Git/Python/Node manually."; return }
    foreach ($p in $pkgs) {
        Write-Host "  winget install $p" -ForegroundColor Yellow
        winget install --accept-package-agreements --accept-source-agreements -e $p
    }
    # Refresh PATH for the rest of this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

Write-Host "`n==> Jarvis Windows bootstrap" -ForegroundColor Cyan
Write-Host "    Base dir : $BaseDir"
Write-Host "    GitHub   : $GitHubUser`n"

# --- 1. Prerequisites ---
if (-not $NoPrereqInstall) { InstallPrereqs }
$missing = @()
if (-not (Need git))    { $missing += "git" }
if (-not (Need python)) { $missing += "python" }
if (-not (Need node))   { $missing += "node" }
if (-not (Need npm))    { $missing += "npm" }
if ($missing.Count -gt 0) {
    Write-Host "`nStill missing: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Install via:  winget install Git.Git Python.Python.3.11 OpenJS.NodeJS.LTS" -ForegroundColor Yellow
    exit 1
}

# --- 2. Clone repos ---
New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
Set-Location $BaseDir

function Clone { param([string]$repo, [string]$dest)
    if (Test-Path $dest) { Write-Host "  (skip) $dest already exists" }
    else { git clone "https://github.com/$GitHubUser/$repo.git" $dest }
}
Clone "jarvis"      "jarvis"
Clone "Ideaverse"   "vault"
Clone "jarvis-skills" "skills"

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
if (Test-Path "requirements.txt")      { pip install -r requirements.txt }
if (Test-Path "server/requirements.txt"){ pip install -r server/requirements.txt }
Pop-Location

# --- 5. Secrets ---
$vaultEnv = "$BaseDir\jarvis\.env"
if (-not (Test-Path $vaultEnv)) {
    Copy-Item "$BaseDir\jarvis\.env.template" $vaultEnv
    Write-Host "`n  Copied .env.template -> .env" -ForegroundColor Yellow
    Write-Host "  >>> EDIT $vaultEnv and fill in real secrets (DO NOT commit it)" -ForegroundColor Red
}

# --- 6. Link skills into the agent load path ---
$agentsSkills = "$env:USERPROFILE\.agents\skills"
$skillSrc     = "$BaseDir\skills"
if (Test-Path $agentsSkills) {
    Write-Host "`n  $agentsSkills already exists; leaving it untouched." -ForegroundColor Yellow
} else {
    try {
        cmd /c mklink /D `"$agentsSkills`" `"$skillSrc`" 2>$null
        if (Test-Path $agentsSkills) {
            Write-Host "  Linked skills: $agentsSkills -> $skillSrc" -ForegroundColor Green
        } else { throw }
    } catch {
        Write-Host "  Could not symlink (need admin/Developer Mode). Copying skills instead..." -ForegroundColor Yellow
        Copy-Item -Recurse -Force $skillSrc $agentsSkills
    }
}

Write-Host "`n==> Done. Remaining manual steps:" -ForegroundColor Green
Write-Host "  1. Fill secrets in $vaultEnv"
Write-Host "  2. Register the MCP server (jarvis/mcp/jarvis-tools) in your agent client config."
Write-Host "  3. Open $BaseDir\vault in Obsidian (set vault path)."
Write-Host "  4. Start the server:  Push-Location $BaseDir\jarvis\server; npm start`n"
