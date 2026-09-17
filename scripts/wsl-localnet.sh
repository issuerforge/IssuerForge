#!/usr/bin/env bash
# A local validator with both programs already loaded.
#
# `--bpf-program` puts the program into genesis: no deploy, no SOL spent, and
# the address is the one in `declare_id!`. That is why the measurement loop is
# debugged here and goes to devnet only once it works — once, and for money.
#
# Invoke from PowerShell:
#   wsl.exe -e bash /mnt/<path>/scripts/wsl-localnet.sh
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."

FORGE=$(solana address -k target/deploy/issuer_forge-keypair.json)
ATTACKER=$(solana address -k target/deploy/attacker-keypair.json)

# The ledger lives on the WSL filesystem, not under /mnt: on a 9p mount the
# validator writes it several times slower and sometimes corrupts it on stop.
LEDGER="$HOME/.cache/issuerforge-ledger"
rm -rf "$LEDGER"

echo "issuer_forge = $FORGE"
echo "attacker     = $ATTACKER"

exec solana-test-validator \
  --reset \
  --ledger "$LEDGER" \
  --bpf-program "$FORGE" target/deploy/issuer_forge.so \
  --bpf-program "$ATTACKER" target/deploy/attacker.so
