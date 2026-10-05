# Orchestrator-only: push `main` to GitHub using the user's existing `gh` login.
# Uses a one-off credential helper, so no global/system git configuration is changed.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
