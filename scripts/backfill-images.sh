#!/bin/bash
# Backfill images for a given domain/type in batches.
# Usage: ./scripts/backfill-images.sh <domain> [type] [limit]
# Examples:
#   ./scripts/backfill-images.sh listening albums
#   ./scripts/backfill-images.sh watching
#   ./scripts/backfill-images.sh collecting

set -euo pipefail

DOMAIN="${1:?Usage: $0 <listening|watching|collecting> [type] [limit]}"
TYPE="${2:-all}"
LIMIT="${3:-50}"

API_KEY=$(grep REWIND_ADMIN_KEY .dev.vars | cut -d= -f2)

# Collecting is mounted at / while listening/watching are mounted at /<domain>
if [ "$DOMAIN" = "collecting" ]; then
  URL="https://api.rewind.rest/v1/admin/collecting/backfill-images"
else
  URL="https://api.rewind.rest/v1/${DOMAIN}/admin/${DOMAIN}/backfill-images"
fi
LOG="scripts/backfill-${DOMAIN}.log"
BATCH=0
TOTAL_SUCCEEDED=0
TOTAL_SKIPPED=0
TOTAL_FAILED=0

echo "Starting ${DOMAIN} backfill (type=${TYPE}, limit=${LIMIT}) at $(date)" | tee "$LOG"

while true; do
  BATCH=$((BATCH + 1))
  RESULT=$(curl -s --max-time 300 -X POST "$URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"${TYPE}\",\"limit\":${LIMIT}}" 2>&1)

  # Check for curl/Worker errors
  if echo "$RESULT" | grep -q '"error"' || echo "$RESULT" | grep -q 'error code' || ! echo "$RESULT" | grep -q '"success"'; then
    echo "Batch $BATCH: Error, waiting 10s... ($(echo "$RESULT" | head -c 200))" | tee -a "$LOG"
    sleep 10
    continue
  fi

  # Parse results - handle both nested (listening/watching) and flat (collecting) shapes
  KEYS=$(echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)['results']
# Flat shape: results has 'total' directly
if 'total' in r or 'processed' in r:
    t = r.get('total', r.get('processed', 0))
    s = r.get('succeeded', 0)
    sk = r.get('skipped', 0)
    f = r.get('failed', 0)
    print(f'items:{t}:{s}:{sk}:{f}')
else:
    # Nested shape: results.albums, results.movies, etc.
    for k, v in r.items():
        t = v.get('total', v.get('queued', 0))
        s = v.get('succeeded', 0)
        sk = v.get('skipped', 0)
        f = v.get('failed', 0)
        print(f'{k}:{t}:{s}:{sk}:{f}')
" 2>/dev/null || echo "unknown:0:0:0:0")

  BATCH_TOTAL=0
  BATCH_SUCCEEDED=0
  LINE=""
  while IFS= read -r entry; do
    KEY=$(echo "$entry" | cut -d: -f1)
    T=$(echo "$entry" | cut -d: -f2)
    S=$(echo "$entry" | cut -d: -f3)
    SK=$(echo "$entry" | cut -d: -f4)
    F=$(echo "$entry" | cut -d: -f5)
    BATCH_TOTAL=$((BATCH_TOTAL + T))
    BATCH_SUCCEEDED=$((BATCH_SUCCEEDED + S))
    TOTAL_SUCCEEDED=$((TOTAL_SUCCEEDED + S))
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + SK))
    TOTAL_FAILED=$((TOTAL_FAILED + F))
    LINE="${LINE} ${KEY}=${S}ok/${SK}skip/${F}fail"
  done <<< "$KEYS"

  echo "Batch $BATCH (${BATCH_TOTAL} queued):${LINE}" | tee -a "$LOG"

  if [ "$BATCH_TOTAL" -eq 0 ]; then
    echo "" | tee -a "$LOG"
    echo "Done! No more items to process." | tee -a "$LOG"
    break
  fi

  sleep 3
done

echo "" | tee -a "$LOG"
echo "=== Summary ===" | tee -a "$LOG"
echo "Domain: $DOMAIN" | tee -a "$LOG"
echo "Batches: $BATCH" | tee -a "$LOG"
echo "Succeeded: $TOTAL_SUCCEEDED" | tee -a "$LOG"
echo "Skipped: $TOTAL_SKIPPED" | tee -a "$LOG"
echo "Failed: $TOTAL_FAILED" | tee -a "$LOG"
echo "Finished at $(date)" | tee -a "$LOG"
