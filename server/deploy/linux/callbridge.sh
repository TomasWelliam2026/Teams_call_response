#!/usr/bin/env bash
# The "callbridge" command that setup installs (/usr/local/bin/callbridge links here).
#   callbridge status              services, addresses, what's connected
#   callbridge logs [server|caddy|turn]   follow a log (default: server)
#   callbridge restart|stop|start  all three services (restarting cuts live calls)
#   callbridge addresses           the Server URL and app address to use
#   callbridge tokens              the two tokens (root only)
#   callbridge uninstall [--purge] remove the services (--purge also deletes the folder and its tokens)
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
SERVICES=(callbridge-server callbridge-turn callbridge-https)

need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run it with sudo: sudo callbridge $*" >&2; exit 1; }; }

# The site names in the Caddyfile, in order.
addresses() {
  sed -n 's/^\([^[:space:]#{}][^{]*\){[[:space:]]*$/\1/p' "$DIR/Caddyfile" 2>/dev/null | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true
}

port() { sed -n 's/^PORT=//p' "$DIR/.env" 2>/dev/null | tr -d '\r' | tail -n1; }

live_calls() {
  curl -fsS --max-time 3 "http://127.0.0.1:${1:-8080}/healthz" 2>/dev/null | sed -n 's/.*"calls":\([0-9]*\).*/\1/p' || true
}

case ${1:-status} in
  status)
    echo ''
    echo ' Call Bridge server'
    for s in "${SERVICES[@]}"; do printf ' %-18s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || true)"; done
    health=''
    while read -r a; do
      if body=$(curl -fsS --max-time 5 "https://$a/healthz" 2>/dev/null); then
        health=$body; printf ' %-18s wss://%s/call  is answering\n' 'Address' "$a"
      else
        printf ' %-18s wss://%s/call  is NOT answering\n' 'Address' "$a"
      fi
    done < <(addresses)
    if [ -n "$health" ]; then
      field() { printf '%s' "$health" | sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p"; }
      printf ' %-18s %s min\n' 'Up for' $(( $(field uptimeSec) / 60 ))
      printf ' %-18s %s\n' 'Teams computers' "$(field teamsComputers)" 'Call Bridge apps' "$(field apps)"
      printf ' %-18s %s ringing, %s live\n' 'Calls' "$(field ringing)" "$(field calls)"
    else
      echo ' Not answering over HTTPS. Try: sudo callbridge restart, then callbridge logs caddy'
    fi
    echo '' ;;
  logs)
    log="$DIR/logs/${2:-server}.log"
    [ -f "$log" ] || { echo "No log at $log" >&2; exit 1; }
    tail -n 30 -F "$log" ;;
  restart|stop)
    need_root "$1"
    live=$(live_calls "$(port)")
    if [ "${live:-0}" -gt 0 ] && [ "${2:-}" != "--yes" ]; then
      read -r -p "$live call(s) are live and will be cut. Continue? (y/N) " answer || true
      case ${answer:-} in [yY]*) ;; *) exit 0 ;; esac
    fi
    systemctl "$1" "${SERVICES[@]}"; echo "Done: $1." ;;
  start)
    need_root start
    systemctl start "${SERVICES[@]}"; echo 'Started.' ;;
  addresses)
    while read -r a; do echo "Extension Server URL: wss://$a/call     App: https://$a/"; done < <(addresses) ;;
  tokens)
    need_root tokens
    grep -E '^(BRIDGE_TOKEN|OPERATOR_TOKEN)=' "$DIR/.env" ;;
  uninstall)
    need_root uninstall
    exec bash "$DIR/deploy/linux/uninstall.sh" "${@:2}" ;;
  -h|--help|help)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' ;;
  *)
    echo "Unknown command $1. Try: callbridge help" >&2; exit 1 ;;
esac
