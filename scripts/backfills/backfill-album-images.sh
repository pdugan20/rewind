#!/bin/bash
#
# Backfill album images by hitting the on-demand image endpoint.
# Each request triggers the full pipeline: source resolution, R2 upload,
# thumbhash generation, and color extraction.
#
# Progress logged every 50 albums. Skipped albums (no valid match from
# any source) written to scripts/backfills/backfill-album-skips.csv for manual review.
#
# Usage:
#   ./scripts/backfills/backfill-album-images.sh

set -euo pipefail

API_KEY="rw_admin_4a70c8d41d5f0688e1a26d07b8425bbf"
API_BASE="https://api.rewind.rest"
DB_NAME="rewind-db"
SKIPS_FILE="scripts/backfills/backfill-album-skips.csv"

echo "[INFO] Fetching albums missing images..."

MISSING=$(npx wrangler d1 execute "$DB_NAME" --remote --command="
  SELECT a.id, a.name, ar.name as artist_name, a.mbid, a.playcount
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

# Initialize skips file with header
echo "id|artist|album|mbid|playcount" > "$SKIPS_FILE"

echo "$MISSING" | jq -c '.[0].results[]' | while IFS= read -r ROW; do
  ID=$(echo "$ROW" | jq -r '.id')
  ALBUM=$(echo "$ROW" | jq -r '.name')
  ARTIST=$(echo "$ROW" | jq -r '.artist_name')
  MBID=$(echo "$ROW" | jq -r '.mbid // ""')
  PLAYCOUNT=$(echo "$ROW" | jq -r '.playcount // 0')

  COUNT=$((COUNT + 1))

  ENCODED_ARTIST=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$ARTIST")
  ENCODED_ALBUM=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$ALBUM")

  QUERY="artist_name=${ENCODED_ARTIST}&album_name=${ENCODED_ALBUM}"
  if [ -n "$MBID" ] && [ "$MBID" != "null" ]; then
    QUERY="${QUERY}&mbid=${MBID}"
  fi

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "${API_BASE}/v1/images/listening/albums/${ID}/medium?${QUERY}" \
    -H "Authorization: Bearer ${API_KEY}" \
    --max-time 30 2>/dev/null || echo "000")

  if [ "$STATUS" = "302" ]; then
    SUCCEEDED=$((SUCCEEDED + 1))
  elif [ "$STATUS" = "404" ]; then
    SKIPPED=$((SKIPPED + 1))
    echo "$ID|$ARTIST|$ALBUM|$MBID|$PLAYCOUNT" >> "$SKIPS_FILE"
  else
    FAILED=$((FAILED + 1))
    echo "[ERROR] Album $ID ($ARTIST - $ALBUM): HTTP $STATUS"
  fi

  if [ $((COUNT % 50)) -eq 0 ]; then
    echo "[INFO] Progress: $COUNT/$TOTAL | ok=$SUCCEEDED skip=$SKIPPED fail=$FAILED"
  fi

  sleep 0.5
done

echo ""
echo "========================================="
echo "  Backfill complete"
echo "  Succeeded: $SUCCEEDED"
echo "  Skipped:   $SKIPPED (see $SKIPS_FILE)"
echo "  Failed:    $FAILED"
echo "========================================="

SKIP_COUNT=$(tail -n +2 "$SKIPS_FILE" | wc -l | tr -d ' ')
if [ "$SKIP_COUNT" -gt 0 ]; then
  echo ""
  echo "Top skipped albums by playcount:"
  head -21 "$SKIPS_FILE" | tail -20 | while IFS='|' read -r SID SARTIST SALBUM SMBID SPC; do
    echo "  $SARTIST - $SALBUM (id=$SID, plays=$SPC)"
  done
fi
