param(
    [ValidateSet("start", "pair", "status", "backup", "restore")]
    [string]$Action = "start"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"
$QrFile = Join-Path $ScriptDir "pairing-qr.png"

function Invoke-LocalBashScript {
    param([Parameter(Mandatory = $true)][string]$ScriptName)

    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if ($null -ne $bash) {
        Push-Location $ScriptDir
        try {
            & $bash.Source "./$ScriptName"
            if ($LASTEXITCODE -ne 0) {
                throw "$ScriptName failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
        return
    }

    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if ($null -eq $wsl) {
        throw "Bash/WSL was not found. Install/enable WSL or Git Bash before running the zero-cost stack."
    }

    $wslDir = (& wsl.exe wslpath -a $ScriptDir).Trim()
    if (-not $wslDir) {
        throw "Could not translate the project path into WSL."
    }

    $escapedDir = $wslDir.Replace("'", "'\''")
    & wsl.exe bash -lc "cd '$escapedDir' && ./$ScriptName"
    if ($LASTEXITCODE -ne 0) {
        throw "$ScriptName failed with exit code $LASTEXITCODE"
    }
}

if ($Action -eq "start") {
    if (-not (Test-Path $EnvFile)) {
        Invoke-LocalBashScript "setup.sh"
    }
    Invoke-LocalBashScript "start.sh"
    Write-Host "ZERO_COST_LOCAL_READY"
    Write-Host "Next human-only action: run this same launcher with action 'pair'."
    exit 0
}

if (-not (Test-Path $EnvFile)) {
    throw "Local environment is not prepared yet. Run with action 'start' first."
}

switch ($Action) {
    "pair" {
        Invoke-LocalBashScript "pair.sh"
        if (Test-Path $QrFile) {
            Start-Process $QrFile
        }
    }
    "status" {
        Invoke-LocalBashScript "status.sh"
    }
    "backup" {
        Invoke-LocalBashScript "backup.sh"
    }
    "restore" {
        Invoke-LocalBashScript "restore-drill.sh"
    }
}
