#!/bin/bash
#
# Backfill artist genre tags via the admin sync endpoint.
# Calls POST /v1/admin/sync/listening { type: "artist_tags" } in a loop,
# processing 500 artists per batch until all are tagged.
#
# Usage:
#   ./scripts/backfills/backfill-artist-tags.sh

set -euo pipefail

API_KEY="rw_admin_4a70c8d41d5f0688e1a26d07b8425bbf"
API_BASE="https://api.rewind.rest"

BATCH=0

while true; do
  BATCH=$((BATCH + 1))
  echo "[INFO] Batch $BATCH: requesting artist tag sync..."

  RESULT=$(curl -s -X POST "${API_BASE}/v1/admin/sync/listening" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"type":"artist_tags"}' \
    --max-time 300)

  TAGGED=$(echo "$RESULT" | jq '.items_synced // 0')
  REMAINING=$(echo "$RESULT" | jq '.remaining // 0')
  STATUS=$(echo "$RESULT" | jq -r '.status // "unknown"')

  if [ "$STATUS" != "completed" ]; then
    echo "[ERROR] Unexpected response: $RESULT"
    exit 1
  fi

  echo "[INFO] Batch $BATCH: tagged $TAGGED, remaining: $REMAINING"

  if [ "$REMAINING" -eq 0 ]; then
    echo "[SUCCESS] All artists tagged"
    break
  fi

  sleep 2
done
