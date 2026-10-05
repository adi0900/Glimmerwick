<#
.SYNOPSIS
    Builds the Rust simulation (crate `bridge`) to WebAssembly and installs the JS package into
    web/src/wasm/pkg/ with an atomic directory swap.

.DESCRIPTION
    1. cargo build -p bridge --target wasm32-unknown-unknown --profile wasm-dev   (or --release)
    2. wasm-bindgen --target web  -> a staging directory *outside* web/ (so Vite's file watcher never
       sees half-written files)
    3. validates the output, then swaps it into web/src/wasm/pkg/:
         a) preferred: two same-volume directory renames (old -> staging, new -> pkg); if the second
            fails the previous package is restored;
         b) fallback when Windows refuses to rename `pkg` because a file watcher (the Vite dev
            server) holds it open: every file is replaced with the atomic ReplaceFile API, the wasm
            first and the JS glue (bridge.js) last, so a reader never sees a half-written file and
            only a few milliseconds of "new wasm + old glue" are possible.
       Either way the web side never sees a half-written package.
    4. prints the .wasm size.

.PARAMETER Release
    Use the `release` profile (opt-level 3, LTO, codegen-units 1: slow to build, smallest/fastest)
    instead of the fast `wasm-dev` profile.

.EXAMPLE
    powershell -File tools/build-wasm.ps1
    powershell -File tools/build-wasm.ps1 -Release
#>
[CmdletBinding()]
param([switch]$Release)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location $root

# Runs a native command; cmdlet-style error handling does not apply to native stderr output.
function Invoke-Native {
    param([Parameter(Mandatory)][string]$What, [Parameter(Mandatory)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

$profileName = if ($Release) { 'release' } else { 'wasm-dev' }
$clock = [Diagnostics.Stopwatch]::StartNew()

# --- the CLI must match the wasm-bindgen crate version in Cargo.lock ------------------------------
$cliVersion = ((& wasm-bindgen --version) -replace '^wasm-bindgen\s+', '').Trim()
$lock = Get-Content -Raw (Join-Path $root 'Cargo.lock')
if ($lock -match '(?ms)name = "wasm-bindgen"\r?\nversion = "([^"]+)"') {
    if ($Matches[1] -ne $cliVersion) {
        throw "wasm-bindgen CLI $cliVersion does not match the crate in Cargo.lock ($($Matches[1])). Do not install another CLI; fix the pin in Cargo.toml."
    }
}

# --- 1. cargo --------------------------------------------------------------------------------------
Write-Host "==> cargo build -p bridge --target wasm32-unknown-unknown --profile $profileName"
Invoke-Native 'cargo build' { cargo build -p bridge --target wasm32-unknown-unknown --profile $profileName }

$wasm = Join-Path $env:CARGO_TARGET_DIR "wasm32-unknown-unknown\$profileName\bridge.wasm"
if (-not (Test-Path $wasm)) { throw "expected build output not found: $wasm" }
$rawKB = [math]::Round((Get-Item $wasm).Length / 1KB)

# --- 2. wasm-bindgen into staging (same volume as the target dir and web/) ----------------------------
$stageRoot = Join-Path $env:CARGO_TARGET_DIR 'wasm-pkg-staging'
New-Item -ItemType Directory -Force $stageRoot | Out-Null
$stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$new = Join-Path $stageRoot "new-$stamp"
$old = Join-Path $stageRoot "old-$stamp"

$pkgParent = Join-Path $root 'web\src\wasm'
$pkg = Join-Path $pkgParent 'pkg'
New-Item -ItemType Directory -Force $pkgParent | Out-Null

try {
    Write-Host "==> wasm-bindgen --target web -> staging"
    Invoke-Native 'wasm-bindgen' { wasm-bindgen --target web --out-dir $new --out-name bridge $wasm }

    foreach ($f in 'bridge.js', 'bridge_bg.wasm', 'bridge.d.ts') {
        $p = Join-Path $new $f
        if (-not (Test-Path $p) -or (Get-Item $p).Length -eq 0) { throw "wasm-bindgen did not produce $f" }
    }

    # --- 3. swap ---------------------------------------------------------------------------------------
    # Preferred: rename the whole directory (old -> staging, new -> pkg). Windows refuses to rename a
    # directory that a file watcher holds open (the Vite dev server always does), so the fallback
    # replaces the files one by one with the atomic ReplaceFile API, glue (bridge.js) last.
    $swapped = $false
    if (-not (Test-Path $pkg)) {
        [IO.Directory]::Move($new, $pkg)
        $swapped = $true
    } else {
        $movedAway = $false
        try { [IO.Directory]::Move($pkg, $old); $movedAway = $true } catch { }
        if ($movedAway) {
            try { [IO.Directory]::Move($new, $pkg); $swapped = $true }
            catch { [IO.Directory]::Move($old, $pkg); throw }   # restore the previous package
        }
    }
    if ($swapped) {
        $swapMode = 'directory rename'
    } else {
        $swapMode = 'per-file atomic replace (pkg is held open by a watcher)'
        function Install-File([string]$src, [string]$dst) {
            for ($try = 1; $try -le 30; $try++) {
                try {
                    if (Test-Path $dst) { [IO.File]::Replace($src, $dst, [NullString]::Value) } else { [IO.File]::Move($src, $dst) }
                    return
                } catch {
                    if ($try -eq 30) { throw }
                    Start-Sleep -Milliseconds 100
                }
            }
        }
        $names = @(Get-ChildItem $new -File | ForEach-Object { $_.Name })
        $order = @('bridge_bg.wasm', 'bridge_bg.wasm.d.ts', 'bridge.d.ts') + @($names | Where-Object { $_ -notin @('bridge_bg.wasm', 'bridge_bg.wasm.d.ts', 'bridge.d.ts', 'bridge.js') }) + @('bridge.js')
        foreach ($n in $order) { Install-File (Join-Path $new $n) (Join-Path $pkg $n) }
        # remove files of an older layout
        Get-ChildItem $pkg -File | Where-Object { $_.Name -notin $names } | Remove-Item -Force -ErrorAction SilentlyContinue
    }
} finally {
    foreach ($d in $new, $old) {
        if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue }
    }
}

# --- 4. report -------------------------------------------------------------------------------------------
$size = (Get-Item (Join-Path $pkg 'bridge_bg.wasm')).Length
$inv = [Globalization.CultureInfo]::InvariantCulture
Write-Host ([string]::Format($inv, "==> OK  profile={0}  swap={1}`n    web/src/wasm/pkg/bridge_bg.wasm = {2:N0} bytes ({3:N2} MB; cargo output {4} KB)  in {5:N1}s",
    $profileName, $swapMode, $size, ($size / 1MB), $rawKB, $clock.Elapsed.TotalSeconds))
