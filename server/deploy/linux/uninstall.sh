#!/usr/bin/env bash
# Undoes install.sh: stops and removes the three services and the "callbridge" command.
# Keeps the install folder (with .env, your tokens) unless you pass --purge.
# Firewall rules it opened in ufw/firewalld are left in place.
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo 'Run it as root (sudo).' >&2; exit 1; }

for s in callbridge-server callbridge-turn callbridge-https; do
  if [ -f "/etc/systemd/system/$s.service" ]; then
    systemctl disable -q --now "$s" || true
    rm -f "/etc/systemd/system/$s.service"
    echo "Removed $s."
  fi
done
systemctl daemon-reload
[ "$(readlink -f /usr/local/bin/callbridge 2>/dev/null)" = "$DIR/deploy/linux/callbridge.sh" ] && rm -f /usr/local/bin/callbridge

if [ "${1:-}" = "--purge" ]; then
  # Refuse anything that doesn't look like an install folder.
  [ -f "$DIR/server.js" ] && [ "$DIR" != / ] || { echo "Not deleting $DIR: it doesn't look like a Call Bridge folder." >&2; exit 1; }
  rm -rf "$DIR"
  userdel callbridge 2>/dev/null || true
  echo "Deleted $DIR and the callbridge user."
else
  echo "Uninstalled. Your tokens are still in $DIR/.env. To delete the folder too: sudo bash $DIR/deploy/linux/uninstall.sh --purge"
fi
