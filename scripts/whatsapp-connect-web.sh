#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SESSION_ROOT="${APP_ROOT}/outputs/whatsapp-session"
CLIENT_ID="${WHATSAPP_CLIENT_ID:-receipt-whatsapp-bot}"
SESSION_DIR="${SESSION_ROOT}/session-${CLIENT_ID}"

RESET_SESSION=0

for arg in "$@"; do
  case "$arg" in
    --reset-session)
      RESET_SESSION=1
      ;;
    *)
      echo "Argumento invalido: $arg" >&2
      echo "Uso: $0 [--reset-session]" >&2
      exit 1
      ;;
  esac
done

cd "$APP_ROOT"

if [ "$RESET_SESSION" -eq 1 ]; then
  rm -rf "$SESSION_DIR"
  echo "Sessao antiga removida: $SESSION_DIR"
fi

echo "Abrindo o WhatsApp no navegador para autenticacao..."
exec env WHATSAPP_HEADLESS=false node src/whatsapp.js
