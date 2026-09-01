#!/bin/bash
set -uo pipefail

TARGET_URL="${TARGET_URL:-http://daily-content-ideas:3060}"
REPORT_URL="${REPORT_URL:-https://ptp-internal.pages.dev/api/content-ideas-url}"

if [ -z "${TUNNEL_UPDATE_SECRET:-}" ]; then
  echo "FEIL: TUNNEL_UPDATE_SECRET er ikke satt. Kan ikke rapportere tunnel-URL." >&2
  exit 1
fi

report_url() {
  local url="$1"
  echo "[cloudflared-wrapper] Fant tunnel-URL: $url - rapporterer til $REPORT_URL"
  curl -fsS -X POST "$REPORT_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TUNNEL_UPDATE_SECRET" \
    -d "{\"url\": \"$url\"}" \
    && echo "[cloudflared-wrapper] Rapportert OK." \
    || echo "[cloudflared-wrapper] Klarte ikke å rapportere URL (ptp-internal nede/utilgjengelig?). Fortsetter uansett." >&2
}

echo "[cloudflared-wrapper] Starter quick tunnel mot $TARGET_URL ..."

REPORTED=""
cloudflared tunnel --url "$TARGET_URL" --no-autoupdate 2>&1 | while IFS= read -r line; do
  echo "$line"
  URL=$(echo "$line" | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | head -n1)
  if [ -n "$URL" ] && [ "$URL" != "$REPORTED" ]; then
    report_url "$URL"
    REPORTED="$URL"
  fi
done

echo "[cloudflared-wrapper] cloudflared avsluttet. Containeren restarter (restart: unless-stopped)."
exit 1
