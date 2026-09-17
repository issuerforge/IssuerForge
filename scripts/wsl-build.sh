#!/usr/bin/env bash
# Builds the on-chain programs in WSL. Invoke from PowerShell, not Git Bash:
#   wsl.exe -e bash /mnt/<path-to-repo>/scripts/wsl-build.sh
# Git Bash mangles the /mnt/ path and bash -c swallows quotes — hence a file.
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."
anchor build
