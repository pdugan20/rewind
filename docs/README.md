# Rewind documentation

## Documentation surfaces

| Surface                                          | Source                                            | Purpose                                                                          |
| ------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Public documentation](https://docs.rewind.rest) | [`docs-mintlify/`](../docs-mintlify/)             | Guides, API reference, MCP setup, and public changelog                           |
| [Landing site](https://rewind.rest)              | [`docs-site/`](../docs-site/)                     | Landing page and policy pages                                                    |
| Internal documentation                           | `docs/`                                           | Architecture, domain implementation, project decisions, and operational evidence |
| MCP package                                      | [`mcp-server/README.md`](../mcp-server/README.md) | Package installation and usage                                                   |

Use the [maintenance guide](MAINTENANCE.md) for sources of truth, regeneration, and checks.

## Architecture and domains

| Document                                                 | Purpose                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| [Architecture](ARCHITECTURE.md)                          | System design, storage, caching, sync, and deployment                 |
| [Listening](domains/listening.md)                        | Last.fm and Apple Music                                               |
| [Running](domains/running.md)                            | Strava                                                                |
| [Watching](domains/watching.md)                          | Plex, Letterboxd, and TMDB                                            |
| [Collecting](domains/collecting.md)                      | Discogs and Trakt                                                     |
| [Reading](domains/reading.md)                            | Instapaper                                                            |
| [Images](domains/images.md)                              | Artwork sources, storage, colors, and CDN                             |
| [Attending project](projects/attending-domain/README.md) | Calendar and Gmail ingestion, sports enrichment, and domain decisions |

## Current work and project history

This inventory includes shipped work with open verification or follow-up items. Directory placement alone does not mean a project is unfinished. Read its tracker before starting or archiving work; old problem statements and counts describe the original investigation, not current production state.

| Project                                                                 | Scope and status                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [CD artwork](projects/cd-artwork/PRODUCTION-RUNBOOK.md)                 | Accepted disc artwork, automatic discovery, review, and delivery; current operational work.                       |
| [Instapaper backfill](projects/instapaper-backfill/PLAN.md)             | Historical bulk-import plan and completion evidence; do not replay live-data steps without a new bounded request. |
| [Prepared Lately snapshot](projects/lately/README.md)                   | Prepared music/movie API and portfolio integration; release and verification notes.                               |
| [Album attribution repair](projects/album-attribution-repair/README.md) | Repair history with remaining reindex, schema, and close-out items; reconcile with later identity fixes.          |
| [Docs site improvements](projects/docs-site-improvements/README.md)     | Mintlify migration is complete; landing metadata, branding, and status-page work remain.                          |
| [Attending deep stats](projects/attending-deep-stats/README.md)         | Filters and MLB player aggregates shipped; Phase 4 real-client checkpoint precedes expansion.                     |
| [Sports box-score parity](projects/sports-boxscore-parity/README.md)    | Proposed non-MLB player stats; gated on the attending checkpoint.                                                 |
| [Attending domain](projects/attending-domain/README.md)                 | Implemented domain with historical ingestion, verification, and follow-up checklists.                             |
| [Reading search recall](projects/reading-search-recall/README.md)       | Full-body and chunked retrieval work with its own validation checklist.                                           |
| [Single-entity cards](projects/single-entity-cards/README.md)           | Article, artist, athlete, and track views; selection and smoke-test close-out remain in the tracker.              |
| [MCP server follow-ups](projects/mcp-server/DEFERRED.md)                | Output-schema decisions, title audit, and deferred work supplement the archived launch project.                   |

## Archived projects

| Project                                                                               | Record                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [apple-music-enrichment](projects/archived/apple-music-enrichment/README.md)          | Historical implementation and decisions                                            |
| [artist-genres](projects/archived/artist-genres/README.md)                            | Historical implementation and decisions                                            |
| [compilation-albums](projects/archived/compilation-albums/README.md)                  | Historical implementation and decisions                                            |
| [date-filtering](projects/archived/date-filtering/README.md)                          | Historical implementation and decisions                                            |
| [mcp-server](projects/archived/mcp-server/README.md)                                  | Historical implementation and decisions                                            |
| [public-api-docs](projects/archived/public-api-docs/README.md)                        | Historical implementation and decisions                                            |
| [reading-domain](projects/archived/reading-domain/README.md)                          | Historical implementation and decisions                                            |
| [reliability-improvements](projects/archived/reliability-improvements/README.md)      | Historical implementation and decisions                                            |
| [Apple Music enrichment](projects/archived/apple-music-enrichment-recovery/README.md) | Recovery and backfill shipped; two historical cron observations remain unverified. |
| [MCP Apps](projects/archived/mcp-apps/README.md)                                      | Poster-grid implementation and client verification history.                        |
| [MCP richness](projects/archived/mcp-richness/README.md)                              | Shipped rich responses and remaining client verification or deferred capabilities. |
| [Reading and music cards](projects/archived/reading-music-cards/README.md)            | Implemented article and music cards; retain client verification evidence.          |
| [Reading search](projects/archived/reading-search/README.md)                          | Shipped search foundation; later work lives in reading-search-recall.              |

## Maintenance review

See the [October 13, 2026 review](maintenance/2026-10-13-docs-and-branches.md) for documentation corrections, branch cleanup evidence, and unresolved next-step decisions.

See the [October 13 CD artwork reconciliation](maintenance/2026-10-13-cd-artwork-reconciliation.md) for recovered runtime source, deployment restoration, review fixes, and the remaining release boundary.

See the [October 13 maintenance closeout](maintenance/2026-10-13-closeout.md) for deployment safeguards, reviewed branch dispositions, and preserved unfinished local work.
