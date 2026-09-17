#!/usr/bin/env bash
# Unit tests of the on-chain program in WSL. Invoke from PowerShell, like wsl-build.sh:
#   wsl.exe -e bash /mnt/<path-to-repo>/scripts/wsl-test.sh
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."
# Every target, not just --lib: the differential check against the TS half
# lives in `tests/rules.rs`, and --lib does not run it.
cargo test -p issuer-forge "$@"
