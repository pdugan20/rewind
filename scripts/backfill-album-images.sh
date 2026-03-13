#!/bin/bash
#
# Backfill album images by hitting the on-demand image endpoint.
# Each request triggers the full pipeline: source resolution, R2 upload,
# thumbhash generation, and color extraction.
#
# Usage:
#   ./scripts/backfill-album-images.sh

set -euo pipefail

API_KEY="rw_admin_4a70c8d41d5f0688e1a26d07b8425bbf"
API_BASE="https://api.rewind.rest"
DB_NAME="rewind-db"

echo "[INFO] Fetching albums missing images..."

MISSING=$(npx wrangler d1 execute "$DB_NAME" --remote --command="
  SELECT a.id, a.name, ar.name as artist_name
  FROM lastfm_albums a
  JOIN lastfm_artists ar ON a.artist_id = ar.id
  WHERE a.is_filtered = 0
    AND a.id NOT IN (
      SELECT CAST(entity_id AS INTEGER) FROM images
      WHERE domain = 'listening' AND entity_type = 'albums'
    )
  ORDER BY a.playcount DESC
" --json 2>/dev/null)

TOTAL=$(echo "$MISSING" | jq '.[0].results | length')
echo "[INFO] $TOTAL albums need images"

if [ "$TOTAL" -eq 0 ]; then
  echo "[INFO] Nothing to backfill"
  exit 0
fi

SUCCEEDED=0
FAILED=0
SKIPPED=0
COUNT=0

echo "$MISSING" | jq -c '.[0].results[]' | while IFS= read -r ROW; do
  ID=$(echo "$ROW" | jq -r '.id')
  ALBUM=$(echo "$ROW" | jq -r '.name')
  ARTIST=$(echo "$ROW" | jq -r '.artist_name')

  COUNT=$((COUNT + 1))

  ENCODED_ARTIST=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$ARTIST")
  ENCODED_ALBUM=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$ALBUM")

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "${API_BASE}/v1/images/listening/albums/${ID}/medium?artist_name=${ENCODED_ARTIST}&album_name=${ENCODED_ALBUM}" \
    -H "Authorization: Bearer ${API_KEY}" \
    --max-time 30 2>/dev/null || echo "000")

  if [ "$STATUS" = "302" ]; then
    SUCCEEDED=$((SUCCEEDED + 1))
  elif [ "$STATUS" = "404" ]; then
    SKIPPED=$((SKIPPED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "[ERROR] Album $ID ($ARTIST - $ALBUM): HTTP $STATUS"
  fi

  if [ $((COUNT % 50)) -eq 0 ]; then
    echo "[INFO] Progress: $COUNT/$TOTAL (succeeded: $SUCCEEDED, skipped: $SKIPPED, failed: $FAILED)"
  fi

  sleep 0.3
done

echo "[SUCCESS] Backfill complete"
