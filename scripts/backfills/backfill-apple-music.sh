#!/bin/bash
#
# Backfill Apple Music URLs by hitting iTunes Search API directly.
# No Worker involved — curls iTunes from this machine, writes to D1 via wrangler.
#
# Usage:
#   ./scripts/backfills/backfill-apple-music.sh

set -euo pipefail

DB_NAME="rewind-db"
DELAY=3  # seconds between iTunes requests
WRITE_EVERY=50  # batch DB writes every N tracks
SKIPS_FILE="scripts/backfills/backfill-apple-music-skips.csv"

echo "[INFO] Fetching unenriched tracks..."

TRACKS=$(npx wrangler d1 execute "$DB_NAME" --remote --json --command="
  SELECT t.id, t.name as track, ar.name as artist, t.album_id, ar.id as artist_db_id
  FROM lastfm_tracks t
  JOIN lastfm_artists ar ON t.artist_id = ar.id
  WHERE t.itunes_enriched_at IS NULL AND t.is_filtered = 0
  ORDER BY t.id DESC
" 2>/dev/null)

TOTAL=$(echo "$TRACKS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)[0]['results']))")
echo "[INFO] $TOTAL tracks to enrich"
echo "[INFO] Estimated time: $(( TOTAL * DELAY / 60 )) minutes"
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo "[INFO] Nothing to backfill"
  exit 0
fi

echo "$TRACKS" | python3 -c "
import sys, json, urllib.parse, urllib.request, time, subprocess, os

data = json.load(sys.stdin)
tracks = data[0]['results']
total = len(tracks)

succeeded = 0
skipped = 0
failed = 0
count = 0

# Collect updates for batch writing
pending_updates = []
skips = []

def flush_updates(updates):
    if not updates:
        return
    # Build a single SQL statement with multiple UPDATEs
    stmts = []
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    for u in updates:
        if u['type'] == 'track':
            amid = u.get('apple_music_id') or 'NULL'
            aurl = u.get('apple_music_url', '').replace(\"'\", \"''\") if u.get('apple_music_url') else ''
            purl = u.get('preview_url', '').replace(\"'\", \"''\") if u.get('preview_url') else ''
            stmts.append(
                f\"UPDATE lastfm_tracks SET apple_music_id = {amid}, \"
                f\"apple_music_url = '{aurl}', \"
                f\"preview_url = '{purl}', \"
                f\"itunes_enriched_at = '{now}' \"
                f\"WHERE id = {u['id']}\"
            )
        elif u['type'] == 'track_skip':
            stmts.append(
                f\"UPDATE lastfm_tracks SET itunes_enriched_at = '{now}' WHERE id = {u['id']}\"
            )
        elif u['type'] == 'artist':
            amid = u.get('apple_music_id') or 'NULL'
            aurl = u.get('apple_music_url', '').replace(\"'\", \"''\")
            stmts.append(
                f\"UPDATE lastfm_artists SET apple_music_id = {amid}, \"
                f\"apple_music_url = '{aurl}', \"
                f\"itunes_enriched_at = '{now}' \"
                f\"WHERE id = {u['id']} AND itunes_enriched_at IS NULL\"
            )
        elif u['type'] == 'album':
            amid = u.get('apple_music_id') or 'NULL'
            aurl = u.get('apple_music_url', '').replace(\"'\", \"''\")
            stmts.append(
                f\"UPDATE lastfm_albums SET apple_music_id = {amid}, \"
                f\"apple_music_url = '{aurl}', \"
                f\"itunes_enriched_at = '{now}' \"
                f\"WHERE id = {u['id']} AND itunes_enriched_at IS NULL\"
            )

    sql = '; '.join(stmts)
    try:
        subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', '$DB_NAME', '--remote', '--command', sql],
            capture_output=True, timeout=30
        )
    except Exception as e:
        print(f'[ERROR] DB write failed: {e}')

for t in tracks:
    count += 1
    artist_clean = t['artist'].split(' feat')[0].split(' ft.')[0].split(' featuring ')[0].strip()
    term = f\"{artist_clean} {t['track']}\"
    url = f'https://itunes.apple.com/search?term={urllib.parse.quote(term)}&entity=song&media=music&limit=5'

    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'RewindAPI/1.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            results = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print(f'[WARN] Rate limited at {count}/{total}, pausing 60s...')
            time.sleep(60)
            failed += 1
            continue
        failed += 1
        continue
    except Exception:
        failed += 1
        continue

    # Find validated match
    matched = None
    req_artist = artist_clean.lower()
    if req_artist.startswith('the '):
        req_artist = req_artist[4:]

    for r in results.get('results', []):
        ret_artist = r.get('artistName', '').lower()
        if ret_artist.startswith('the '):
            ret_artist = ret_artist[4:]
        # Returned must start with requested at word boundary
        if ret_artist == req_artist:
            matched = r
            break
        if ret_artist.startswith(req_artist) and (len(ret_artist) == len(req_artist) or ret_artist[len(req_artist)] == ' '):
            matched = r
            break

    if matched:
        succeeded += 1
        pending_updates.append({'type': 'track', 'id': t['id'],
            'apple_music_id': matched.get('trackId'),
            'apple_music_url': matched.get('trackViewUrl'),
            'preview_url': matched.get('previewUrl')})
        if matched.get('artistId') and matched.get('artistViewUrl'):
            pending_updates.append({'type': 'artist', 'id': t['artist_db_id'],
                'apple_music_id': matched['artistId'],
                'apple_music_url': matched['artistViewUrl']})
        if t['album_id'] and matched.get('collectionId') and matched.get('collectionViewUrl'):
            pending_updates.append({'type': 'album', 'id': t['album_id'],
                'apple_music_id': matched['collectionId'],
                'apple_music_url': matched['collectionViewUrl']})
    else:
        skipped += 1
        skips.append(f\"{t['id']}|{t['artist']}|{t['track']}\")
        pending_updates.append({'type': 'track_skip', 'id': t['id']})

    # Flush writes every WRITE_EVERY tracks
    if count % $WRITE_EVERY == 0:
        flush_updates(pending_updates)
        pending_updates = []
        pct = count * 100 // total
        eta_min = (total - count) * $DELAY // 60
        print(f'[INFO] {count}/{total} ({pct}%) | ok={succeeded} skip={skipped} fail={failed} | ETA: {eta_min}m')

    time.sleep($DELAY)

# Final flush
flush_updates(pending_updates)

print()
print('=========================================')
print(f'  Enrichment complete')
print(f'  Total:     {count}')
print(f'  Succeeded: {succeeded}')
print(f'  Skipped:   {skipped}')
print(f'  Failed:    {failed}')
print('=========================================')

# Write skips
with open('$SKIPS_FILE', 'w') as f:
    f.write('id|artist|track\n')
    for s in skips:
        f.write(s + '\n')
print(f'[INFO] {len(skips)} skipped tracks written to $SKIPS_FILE')
"
