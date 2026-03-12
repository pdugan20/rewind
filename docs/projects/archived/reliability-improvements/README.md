# Project: Reliability & Architecture Improvements

Systematic pass to fix data integrity issues, improve performance, normalize the API surface, and tighten the schema -- identified during a full codebase audit (March 2026).

## Documents

| File                                     | Purpose                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| [TRACKER.md](TRACKER.md)                 | Master task tracker with 9 phases and all discrete tasks                   |
| [MOVIE-DEDUP.md](MOVIE-DEDUP.md)         | Design notes for Phase 1: movie deduplication across Plex/Letterboxd/Trakt |
| [CRON-STAGGERING.md](CRON-STAGGERING.md) | Design notes for Phase 2: cron schedule changes and retry logic            |
| [AUTH-CACHING.md](AUTH-CACHING.md)       | Design notes for Phase 5: auth caching and rate limit enforcement          |

## Phase Summary

| Phase | Focus                      | Risk Level | Scope                                                                |
| ----- | -------------------------- | ---------- | -------------------------------------------------------------------- |
| 1     | Movie deduplication        | High       | Data integrity -- prevents duplicate records across watching sources |
| 2     | Cron staggering + retry    | High       | Reliability -- eliminates D1 write contention, adds failure recovery |
| 3     | Strava stats optimization  | Medium     | Performance -- incremental recomputation instead of full table scan  |
| 4     | Admin endpoint consistency | Low        | API hygiene -- normalize paths, add missing admin operations         |
| 5     | Auth caching + rate limits | Medium     | Performance + security -- reduce D1 reads, enforce rate limits       |
| 6     | Missing API endpoints      | Low        | Feature completeness -- browse, ratings, year-in-review              |
| 7     | Database integrity         | Medium     | Schema -- indexes, FK cascades, multi-user scoping                   |
| 8     | Image pipeline performance | Low        | Performance -- batch processing, deduplicate redundant runs          |
| 9     | Cleanup + documentation    | Low        | Hygiene -- consistent response shapes, updated docs                  |

## Sequencing Notes

- Phase 1 must complete before any other phase -- it establishes the single-source-of-truth for movies that other work builds on
- Phases 2-5 are independent and can be done in any order
- Phase 6 (new endpoints) should come after Phase 4 (path normalization) to avoid building on deprecated paths
- Phase 7 (schema changes) generates migrations that should be batched and tested carefully since D1 requires table recreation for FK changes
- Phase 9 must be last since it documents everything else
