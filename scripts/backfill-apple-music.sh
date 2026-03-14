#!/bin/bash
#
# Backfill Apple Music URLs and preview audio via the admin enrichment endpoint.
# Processes tracks in batches of 50 with 3 concurrent iTunes lookups per batch.
#
# Progress logged every batch. At completion, queries for unenriched tracks
# and writes them to scripts/backfill-apple-music-skips.csv.
#
# Usage:
#   ./scripts/backfill-apple-music.sh

set -euo pipefail

API_KEY="rw_admin_4a70c8d41d5f0688e1a26d07b8425bbf"
API_BASE="https://api.rewind.rest"
DB_NAME="rewind-db"
BATCH_SIZE=30
SKIPS_FILE="scripts/backfill-apple-music-skips.csv"

SUCCEEDED=0
SKIPPED=0
FAILED=0
BATCH=0

# Get total unenriched count (best-effort, don't fail if query errors)
REMAINING=$(npx wrangler d1 execute "$DB_NAME" --remote --json --command="
  SELECT COUNT(*) as cnt FROM lastfm_tracks
  WHERE itunes_enriched_at IS NULL AND is_filtered = 0
" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['cnt'])" 2>/dev/null || echo "unknown")

echo "[INFO] Starting Apple Music enrichment"
echo "[INFO] $REMAINING tracks to enrich (batch size: $BATCH_SIZE)"
echo ""

while true; do
  BATCH=$((BATCH + 1))

  RESULT=$(curl -s -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    "${API_BASE}/v1/listening/admin/listening/enrich-apple-music?limit=${BATCH_SIZE}" \
    --max-time 180 2>/dev/null || true)

  if [ -z "$RESULT" ] || [[ "$RESULT" == *"error"* && "$RESULT" != *"success"* ]]; then
    echo "[WARN] Bad response on batch $BATCH, retrying in 15s..."
    sleep 15
    continue
  fi

  PARSED=$(echo "$RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    r = d['results']
    print(f\"{r['succeeded']}|{r['skipped']}|{r['failed']}|{r['total']}\")
except Exception as e:
    print(f'ERROR|{e}')
" 2>/dev/null)

  if [[ "$PARSED" == ERROR* ]]; then
    echo "[WARN] Parse failed on batch $BATCH (retrying in 15s): $(echo "$RESULT" | head -c 100)"
    sleep 15
    continue
  fi

  IFS='|' read -r BS BK BF BT <<< "$PARSED"

  SUCCEEDED=$((SUCCEEDED + BS))
  SKIPPED=$((SKIPPED + BK))
  FAILED=$((FAILED + BF))

  echo "[BATCH $BATCH] total=$BT ok=$BS skip=$BK fail=$BF | RUNNING: ok=$SUCCEEDED skip=$SKIPPED fail=$FAILED"

  if [ "$BT" -eq 0 ]; then
    echo ""
    echo "[DONE] No more tracks to process"
    break
  fi

  # If we're getting rate limited (failures), slow down
  if [ "$BF" -gt 0 ]; then
    echo "[WARN] Failures detected, slowing down..."
    sleep 10
  else
    sleep 2
  fi
done

echo ""
echo "========================================="
echo "  Enrichment complete"
echo "  Succeeded: $SUCCEEDED"
echo "  Skipped:   $SKIPPED"
echo "  Failed:    $FAILED"
echo "========================================="

# Collect coverage stats
echo ""
echo "[INFO] Checking enrichment coverage..."

npx wrangler d1 execute "$DB_NAME" --remote --command="
  SELECT
    SUM(CASE WHEN itunes_enriched_at IS NOT NULL AND apple_music_url IS NOT NULL THEN 1 ELSE 0 END) as enriched,
    SUM(CASE WHEN itunes_enriched_at IS NOT NULL AND apple_music_url IS NULL THEN 1 ELSE 0 END) as no_match,
    SUM(CASE WHEN itunes_enriched_at IS NULL THEN 1 ELSE 0 END) as remaining
  FROM lastfm_tracks WHERE is_filtered = 0
" 2>&1 | grep -E "enriched|no_match|remaining" || echo "[WARN] Coverage query failed"

npx wrangler d1 execute "$DB_NAME" --remote --command="
  SELECT COUNT(*) as cnt FROM lastfm_artists WHERE apple_music_url IS NOT NULL
" 2>&1 | grep "cnt" || true

npx wrangler d1 execute "$DB_NAME" --remote --command="
  SELECT COUNT(*) as cnt FROM lastfm_albums WHERE apple_music_url IS NOT NULL
" 2>&1 | grep "cnt" || true

# Write skipped tracks to CSV
echo ""
echo "[INFO] Writing unenriched tracks to $SKIPS_FILE..."

npx wrangler d1 execute "$DB_NAME" --remote --json --command="
  SELECT t.id, ar.name as artist, t.name as track, a.name as album
  FROM lastfm_tracks t
  JOIN lastfm_artists ar ON t.artist_id = ar.id
  LEFT JOIN lastfm_albums a ON t.album_id = a.id
  WHERE t.itunes_enriched_at IS NOT NULL
    AND t.apple_music_url IS NULL
    AND t.is_filtered = 0
  ORDER BY ar.name, t.name
" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    rows = data[0]['results']
    with open('scripts/backfill-apple-music-skips.csv', 'w') as f:
        f.write('id|artist|track|album\n')
        for r in rows:
            f.write(f\"{r['id']}|{r['artist']}|{r['track']}|{r.get('album') or ''}\n\")
    print(f'[INFO] {len(rows)} unenriched tracks written to scripts/backfill-apple-music-skips.csv')
except Exception as e:
    print(f'[WARN] Failed to write skips CSV: {e}')
"
