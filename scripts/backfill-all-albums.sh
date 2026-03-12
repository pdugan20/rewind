#!/bin/bash
# Backfill all listening album images in batches of 100.
# Stops when no items remain. Logs results to scripts/backfill-albums.log.

set -euo pipefail

API_KEY=$(grep REWIND_ADMIN_KEY .dev.vars | cut -d= -f2)
URL="https://api.rewind.rest/v1/listening/admin/listening/backfill-images"
LOG="scripts/backfill-albums.log"
BATCH=0
TOTAL_SUCCEEDED=0
TOTAL_SKIPPED=0
TOTAL_FAILED=0

echo "Starting album backfill at $(date)" | tee "$LOG"

while true; do
  BATCH=$((BATCH + 1))
  RESULT=$(curl -s -X POST "$URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"type":"albums","limit":100}')

  TOTAL=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['results']['albums']['total'])" 2>/dev/null || echo "0")
  SUCCEEDED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['results']['albums']['succeeded'])" 2>/dev/null || echo "0")
  SKIPPED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['results']['albums']['skipped'])" 2>/dev/null || echo "0")
  FAILED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['results']['albums']['failed'])" 2>/dev/null || echo "0")

  TOTAL_SUCCEEDED=$((TOTAL_SUCCEEDED + SUCCEEDED))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + SKIPPED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  echo "Batch $BATCH: $TOTAL queued, $SUCCEEDED succeeded, $SKIPPED skipped, $FAILED failed" | tee -a "$LOG"

  if [ "$TOTAL" -eq 0 ]; then
    echo "" | tee -a "$LOG"
    echo "Done! No more albums to process." | tee -a "$LOG"
    break
  fi

  # If an entire batch was skipped/failed with nothing succeeded, we're likely
  # just churning through unmatchable items. Keep going — they get images rows
  # so they won't be retried.
  # But if we get an error response (e.g. Worker limit), back off.
  if echo "$RESULT" | grep -q '"error"'; then
    echo "Error response, waiting 10s before retry..." | tee -a "$LOG"
    sleep 10
    continue
  fi

  # Rate limit courtesy — 3s between batches
  sleep 3
done

echo "" | tee -a "$LOG"
echo "=== Summary ===" | tee -a "$LOG"
echo "Batches: $BATCH" | tee -a "$LOG"
echo "Succeeded: $TOTAL_SUCCEEDED" | tee -a "$LOG"
echo "Skipped: $TOTAL_SKIPPED" | tee -a "$LOG"
echo "Failed: $TOTAL_FAILED" | tee -a "$LOG"
echo "Finished at $(date)" | tee -a "$LOG"
