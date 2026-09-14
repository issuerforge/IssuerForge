#!/usr/bin/env bash
# Локальний валідатор із уже завантаженими програмами.
#
# `--bpf-program` кладе програму в генезис: деплою немає, SOL не витрачається,
# і адреса та сама, що в `declare_id!`. Саме тому цикл T024 налагоджується тут,
# а на devnet іде вже готовим — один раз і за гроші.
#
# Кликати з PowerShell:
#   wsl.exe -e bash /mnt/<path>/scripts/wsl-localnet.sh
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."

FORGE=$(solana address -k target/deploy/issuer_forge-keypair.json)
ATTACKER=$(solana address -k target/deploy/attacker-keypair.json)

# Реєстр лежить у файловій системі WSL, а не в /mnt: на 9p-монтуванні валідатор
# пише реєстр у рази повільніше й іноді ламає його на зупинці.
LEDGER="$HOME/.cache/issuerforge-ledger"
rm -rf "$LEDGER"

echo "issuer_forge = $FORGE"
echo "attacker     = $ATTACKER"

exec solana-test-validator \
  --reset \
  --ledger "$LEDGER" \
  --bpf-program "$FORGE" target/deploy/issuer_forge.so \
  --bpf-program "$ATTACKER" target/deploy/attacker.so
