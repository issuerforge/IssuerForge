#!/usr/bin/env bash
# `anchor keys sync` + перезбірка: declare_id! бере адресу з ключа програми.
# Кликати з PowerShell, як і решту WSL-скриптів.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."
anchor keys list
anchor keys sync
anchor build
