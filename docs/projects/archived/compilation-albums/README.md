# Compilation Album Dedup -- Fix Soundtrack/Compilation Fragmentation

## Motivation

Compilation albums (soundtracks, tributes, "Various Artists" releases) create one album row per artist in the database because the `lastfm_albums` unique constraint is `(name, artist_id)`. Last.fm scrobbles attribute each track to its own artist, so "Reservoir Dogs OST" ends up with 9+ album rows -- one per contributing artist.

This causes:

- Year-in-review top albums showing the same soundtrack 9 times (issue #6)
- Browse albums listing duplicates
- Inflated unique album counts in stats
- Fragmented playcount data across duplicate rows

## Scope

108 compilation album names affected, totaling 829 album rows that should be collapsed. Detection heuristic: same album name with 3+ distinct artist IDs.

## Approach

1. **Migration**: Merge duplicate album rows per compilation -- pick a winner, reparent tracks, merge playcounts, clean up
2. **Schema**: Add `is_compilation` flag to `lastfm_albums` for fast lookup during sync
3. **Sync fix**: Update `upsertAlbum` to check for existing compilation albums by name before creating new rows
4. **No query changes needed**: Once the data is clean, all endpoints work correctly with existing `groupBy(albumId)` logic

## Files

| File                     | Description                          |
| ------------------------ | ------------------------------------ |
| [TRACKER.md](TRACKER.md) | Phase/task tracker with progress     |
| [DESIGN.md](DESIGN.md)   | Migration SQL, sync changes, testing |
