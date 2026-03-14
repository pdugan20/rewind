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
BATCH_SIZE=50
SKIPS_FILE="scripts/backfill-apple-music-skips.csv"

SUCCEEDED=0
SKIPPED=0
FAILED=0
BATCH=0

# Get total unenriched count
REMAINING=$(npx wrangler d1 execute "$DB_NAME" --remote --json --command="
  SELECT COUNT(*) as cnt FROM lastfm_tracks
  WHERE itunes_enriched_at IS NULL AND is_filtered = 0
" 2>/dev/null | jq '.[0].results[0].cnt')

echo "[INFO] Starting Apple Music enrichment"
echo "[INFO] $REMAINING tracks to enrich (batch size: $BATCH_SIZE)"
echo ""

while true; do
  BATCH=$((BATCH + 1))

  RESULT=$(curl -s -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    "${API_BASE}/v1/listening/admin/listening/enrich-apple-music?limit=${BATCH_SIZE}" \
    --max-time 120 2>/dev/null)

  if [ -z "$RESULT" ]; then
    echo "[ERROR] Empty response on batch $BATCH, retrying in 10s..."
    sleep 10
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
    echo "[ERROR] Parse failed on batch $BATCH: $PARSED"
    echo "[ERROR] Raw: $(echo "$RESULT" | head -c 200)"
    break
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

npx wrangler d1 execute "$DB_NAME" --remote --json --command="
  SELECT
    (SELECT COUNT(*) FROM lastfm_tracks WHERE itunes_enriched_at IS NOT NULL AND apple_music_url IS NOT NULL AND is_filtered = 0) as tracks_enriched,
    (SELECT COUNT(*) FROM lastfm_tracks WHERE itunes_enriched_at IS NOT NULL AND apple_music_url IS NULL AND is_filtered = 0) as tracks_no_match,
    (SELECT COUNT(*) FROM lastfm_tracks WHERE itunes_enriched_at IS NULL AND is_filtered = 0) as tracks_remaining,
    (SELECT COUNT(*) FROM lastfm_artists WHERE apple_music_url IS NOT NULL) as artists_enriched,
    (SELECT COUNT(*) FROM lastfm_albums WHERE apple_music_url IS NOT NULL) as albums_enriched
" 2>/dev/null | python3 -c "
import sys, json
r = json.load(sys.stdin)[0]['results'][0]
print(f'Tracks with Apple Music URL: {r[\"tracks_enriched\"]}')
print(f'Tracks with no match:        {r[\"tracks_no_match\"]}')
print(f'Tracks not yet processed:    {r[\"tracks_remaining\"]}')
print(f'Artists enriched:            {r[\"artists_enriched\"]}')
print(f'Albums enriched:             {r[\"albums_enriched\"]}')
"

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
data = json.load(sys.stdin)
rows = data[0]['results']
with open('$SKIPS_FILE', 'w') as f:
    f.write('id|artist|track|album\n')
    for r in rows:
        f.write(f\"{r['id']}|{r['artist']}|{r['track']}|{r.get('album') or ''}\n\")
print(f'[INFO] {len(rows)} unenriched tracks written to $SKIPS_FILE')
"
