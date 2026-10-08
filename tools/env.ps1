# Dot-source before ANY Rust/cargo/wasm-bindgen command:
#     . .\tools\env.ps1   (from the repo root)
# Rust lives on E: (no global PATH / system settings were changed); this points the current shell at it.
$env:RUSTUP_HOME      = "E:\RustToolchain\rustup"
$env:CARGO_HOME       = "E:\RustToolchain\cargo"
$env:CARGO_TARGET_DIR = "E:\RustToolchain\target\glimmerwick"
$env:Path             = "E:\RustToolchain\cargo\bin;" + $env:Path
$env:RUST_BACKTRACE   = "1"
