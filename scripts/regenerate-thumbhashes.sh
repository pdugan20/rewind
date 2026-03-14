#!/bin/bash
#
# Regenerate thumbhashes for all existing images.
# Calls the admin endpoint in batches until remaining = 0.
#
# Usage:
#   ./scripts/regenerate-thumbhashes.sh

set -euo pipefail

API_KEY="rw_admin_4a70c8d41d5f0688e1a26d07b8425bbf"
API_BASE="https://api.rewind.rest"
BATCH_SIZE=5

BATCH=0
TOTAL_UPDATED=0
TOTAL_FAILED=0

while true; do
  BATCH=$((BATCH + 1))

  RESULT=$(curl -s -X POST "${API_BASE}/v1/admin/images/regenerate-thumbhashes" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"batch_size\": ${BATCH_SIZE}}" \
    --max-time 120)

  UPDATED=$(echo "$RESULT" | jq '.updated // 0')
  FAILED=$(echo "$RESULT" | jq '.failed // 0')
  REMAINING=$(echo "$RESULT" | jq '.remaining // 0')

  TOTAL_UPDATED=$((TOTAL_UPDATED + UPDATED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  echo "[INFO] Batch $BATCH: updated $UPDATED, failed $FAILED, remaining: $REMAINING (total: $TOTAL_UPDATED updated, $TOTAL_FAILED failed)"

  if [ "$REMAINING" -eq 0 ]; then
    echo "[SUCCESS] All thumbhashes regenerated: $TOTAL_UPDATED updated, $TOTAL_FAILED failed"
    break
  fi

  sleep 1
done
