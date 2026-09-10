#!/usr/bin/env bash
# Юніт-тести ончейн-програми у WSL. Кликати з PowerShell, як і wsl-build.sh:
#   wsl.exe -e bash /mnt/<path-to-repo>/scripts/wsl-test.sh
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."
cargo test -p issuer-forge --lib "$@"
