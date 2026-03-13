# Date Filtering -- Consistent Temporal Queries Across All Domains

## Motivation

The API has inconsistent date filtering support across domains. Some endpoints accept `from`/`to` ranges (listening history, running pace trends), some accept only `year` (running activities, watching movies), some accept `period` presets (top lists), and many accept no date params at all (all `/recent` endpoints, feed, collecting lists).

This creates two problems:

1. **Portfolio site gaps**: Features like "click a heatmap day to see that day's activity" or "compare this year to last year" can't be built without client-side workarounds or multiple redundant API calls.
2. **Inconsistent developer experience**: Every domain has different filtering capabilities with no shared convention. A consumer has to learn each endpoint's quirks individually.

## Goals

- Establish a consistent date filtering convention (`date`, `from`, `to`) across all domains
- Enable the heatmap click-through feature (issue #3) for all domains, not just listening
- Close the parity gaps between domains (e.g., collecting has no calendar endpoint)
- Fix existing bugs (dead `year` param on `/watching/movies`)
- Update all documentation (domain docs, OpenAPI spec, docs website) to reflect changes

## Date Parameter Convention

All date-filterable endpoints will support these optional query params:

| Param  | Type         | Description                                                                                                                      |
| ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `date` | `YYYY-MM-DD` | Single-day shorthand. Expands to `from=YYYY-MM-DDT00:00:00Z` / `to=YYYY-MM-{DD+1}T00:00:00Z`. Takes precedence over `from`/`to`. |
| `from` | ISO 8601     | Range start (inclusive).                                                                                                         |
| `to`   | ISO 8601     | Range end (inclusive).                                                                                                           |

When `date` is provided, `from` and `to` are ignored. When only `from` is provided, results include everything from that point forward. When only `to` is provided, results include everything up to that point.

Existing `year` params on endpoints that already have them (calendar, year-in-review, running activities) remain as-is. `from`/`to` takes precedence over `year` when both are provided.

## Scope

### In scope

- Phase 1: `date`/`from`/`to` on all `/recent` endpoints + fix `/watching/movies` year bug
- Phase 2: `from`/`to` on feed, running activities, new collecting calendar endpoint
- Phase 3: Date-scoped stats, watching trends parity, collecting list filtering
- Phase 4: "On this day" endpoint, first-seen dates on detail endpoints
- Phase 5: Documentation updates, issue cleanup, OpenAPI spec refresh

### Deferred

- **Date filtering on `/search`**: The FTS5 `search_index` table doesn't store timestamps. Adding date support requires either joining FTS results back to source tables (slow) or adding a date column to the index (migration + backfill + sync logic changes). Tracked separately.

## Files

| File                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| [TRACKER.md](TRACKER.md) | Phase/task tracker with progress                 |
| [DESIGN.md](DESIGN.md)   | Implementation patterns and per-endpoint details |
