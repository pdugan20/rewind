# Compilation Album Dedup -- Design

## Schema Change

Add `is_compilation` column to `lastfm_albums`:

```sql
ALTER TABLE lastfm_albums ADD COLUMN is_compilation INTEGER DEFAULT 0;
```

This flag enables `upsertAlbum` to quickly check if an album name is a known compilation without scanning for duplicate rows on every insert.

## Migration Strategy

The migration follows the same pattern as the feat. artist merge (migration 0016).

### Step 1: Identify compilations

Albums with the same name and 3+ distinct artists are compilations. The threshold of 3 avoids false positives from legitimate same-name albums by different artists (e.g., two different "Greatest Hits" albums that happen to share a name but have only 2 artist associations).

```sql
CREATE TABLE _compilation_map (
  album_name TEXT,
  winner_id INTEGER,
  loser_id INTEGER
);

-- For each compilation album name, pick the lowest ID as the winner
INSERT INTO _compilation_map (album_name, winner_id, loser_id)
SELECT a.name, w.winner_id, a.id
FROM lastfm_albums a
INNER JOIN (
  SELECT LOWER(name) as lname, MIN(id) as winner_id
  FROM lastfm_albums
  GROUP BY LOWER(name)
  HAVING COUNT(DISTINCT artist_id) >= 3
) w ON LOWER(a.name) = w.lname
WHERE a.id != w.winner_id;
```

### Step 2: Clean up dependent tables

```sql
-- Remove top_albums entries for loser albums
DELETE FROM lastfm_top_albums
WHERE album_id IN (SELECT loser_id FROM _compilation_map);

-- Remove search_index entries for loser albums
DELETE FROM search_index
WHERE domain = 'listening' AND entity_type = 'album'
  AND CAST(entity_id AS INTEGER) IN (SELECT loser_id FROM _compilation_map);

-- Move image records from losers to winner (if winner doesn't have one)
-- Skip this -- images are keyed by entity_id, winner keeps its own
-- Just delete loser image records
DELETE FROM images
WHERE domain = 'listening' AND entity_type = 'albums'
  AND CAST(entity_id AS INTEGER) IN (SELECT loser_id FROM _compilation_map);
```

### Step 3: Reparent tracks

```sql
-- Point all tracks from loser albums to winner albums
UPDATE lastfm_tracks SET album_id = (
  SELECT winner_id FROM _compilation_map WHERE loser_id = lastfm_tracks.album_id
)
WHERE album_id IN (SELECT loser_id FROM _compilation_map);
```

### Step 4: Merge playcounts and flag winner

```sql
-- Sum playcounts from all rows into the winner
UPDATE lastfm_albums SET
  playcount = playcount + COALESCE(
    (SELECT SUM(loser.playcount)
     FROM lastfm_albums loser
     INNER JOIN _compilation_map m ON loser.id = m.loser_id
     WHERE m.winner_id = lastfm_albums.id),
    0
  ),
  is_compilation = 1
WHERE id IN (SELECT DISTINCT winner_id FROM _compilation_map);
```

### Step 5: Delete losers and clean up

```sql
DELETE FROM lastfm_albums
WHERE id IN (SELECT loser_id FROM _compilation_map);

DROP TABLE _compilation_map;
```

## Sync Fix: `upsertAlbum`

Current behavior:

```typescript
// Looks up by (name, artistId) -- misses compilation matches
const [existing] = await db
  .select({ id: lastfmAlbums.id })
  .from(lastfmAlbums)
  .where(and(eq(lastfmAlbums.name, name), eq(lastfmAlbums.artistId, artistId)))
  .limit(1);
```

New behavior -- add a compilation fallback:

```typescript
// 1. Try exact match (name + artist) -- handles normal albums
const [existing] = await db
  .select({ id: lastfmAlbums.id })
  .from(lastfmAlbums)
  .where(and(eq(lastfmAlbums.name, name), eq(lastfmAlbums.artistId, artistId)))
  .limit(1);

if (existing) {
  // update mbid if needed, return existing
  return { id: existing.id, isNew: false };
}

// 2. Check if this album name is a known compilation
const [compilation] = await db
  .select({ id: lastfmAlbums.id })
  .from(lastfmAlbums)
  .where(and(eq(lastfmAlbums.name, name), eq(lastfmAlbums.isCompilation, 1)))
  .limit(1);

if (compilation) {
  // Reuse the compilation album row -- don't create a new one
  return { id: compilation.id, isNew: false };
}

// 3. No match -- create new album row (normal path)
```

This prevents new compilation entries from fragmenting again. When a new track arrives for a compilation album, it routes to the existing winner row.

### Detecting new compilations

For albums not yet flagged as compilations, a new compilation forms when the same album name gets a 3rd distinct artist. This is rare during incremental sync (usually 0-5 new artists per sync). We can handle this with a periodic check:

- During `syncTopLists` or a dedicated maintenance task, query for unflagged albums with 3+ artists and flag + merge them
- Or simply: when `upsertAlbum` creates a new row, check if there are now 3+ rows with that name and trigger a merge

The simpler approach: just run the merge migration periodically or on-demand via admin endpoint. New compilations are rare -- most form during initial backfill, which is already done.

## Testing

- **Migration**: Verify track reparenting, playcount merging, loser deletion on seeded compilation data
- **upsertAlbum**: Test that compilation fallback finds existing compilation row, test that non-compilation albums with same name but different artists still create separate rows
- **Year-in-review**: Verify Reservoir Dogs appears once with aggregated scrobble count
- **Browse albums**: Verify no duplicate album names in paginated list
