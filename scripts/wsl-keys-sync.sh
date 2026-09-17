#!/usr/bin/env bash
# `anchor keys sync` + rebuild: declare_id! takes its address from the program keypair.
# Invoke from PowerShell, like every other WSL script here.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."
anchor keys list
anchor keys sync
anchor build
