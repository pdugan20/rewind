# Documentation and branch maintenance review

Reviewed October 13, 2026 against `origin/main` at `9d2e220` after fetching and pruning remote-tracking refs. Changes are prepared locally; this review does not publish either site, delete local branches, or reconcile unrelated uncommitted work.

## Result

- Added native OpenAPI pages and navigation for six missing operations: recent albums, listening years, related articles, highlight detail, attended-player stats, and Lately. All 100 non-hidden operations in the main API snapshot now have reference bindings. The separate CD artwork Worker is outside that OpenAPI document; its read surface is described in the Images guide.
- Corrected API-key format and scopes, public auth exceptions, per-key rate limits, key caching, CDN transforms, sparkline periods, the MCP period example, and hosted OAuth setup. Updated source-owned sparkline descriptions so the generated API reference agrees with the guide.
- Added October release entries for Lately and CD artwork, based on merged PRs #277, #299, #306, #309, and #315 and the WebP release evidence in #317. Historical changelog entries remain historical; this is not a rewritten release history.
- Rebuilt the internal docs index around all existing project directories and archives. Corrected README technology links and agent-facing domain/auth facts.
- Retained project directories and their evidence. Old unchecked tasks are not reliable proof that a shipped feature remains unimplemented, and a merged feature is not proof that its operational follow-ups are complete.

## Public documentation review

The original navigation had 120 pages: 18 hand-authored guides/changelog pages, 94 API bindings, seven generated MCP reference pages, and one webhook overview. The six new API bindings bring it to 126.

Reviewed hand-authored content in two navigation-ordered batches: introduction through troubleshooting (12 pages), then changelog and the five MCP pages (six pages). Checked the API bindings as a complete set against the snapshot and MCP reference freshness through the generator. This was a source-fidelity and maintenance pass, not a full visual/accessibility or third-party-client certification.

| Surface                           | Findings and disposition                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introduction                      | Domain coverage is current. Single-user intent is clear; avoid describing future multi-tenant support as implemented isolation.                                                                      |
| Quickstart and authentication     | Corrected key requests, token prefixes, scope semantics, public endpoints, and rate-limit claims.                                                                                                    |
| OpenAPI guide                     | Corrected reference landing link and redirect advice.                                                                                                                                                |
| Listening                         | Added missing discovery links and corrected sync cadence and sparkline coverage.                                                                                                                     |
| Running and watching              | No material guide changes in this pass.                                                                                                                                                              |
| Reading                           | Linked related articles to its newly exposed reference page.                                                                                                                                         |
| Collecting                        | No material guide changes in this pass.                                                                                                                                                              |
| Attending                         | Added existing team filters and player stats; corrected the W/L example.                                                                                                                             |
| Images and troubleshooting        | Documented accepted CD artwork and optional WebP; corrected transform URL syntax and auth-cache advice.                                                                                              |
| Changelog                         | Latest previous entry was May 15; added October capabilities from release evidence.                                                                                                                  |
| MCP overview and local connection | Corrected the reference-content description and documented the package's Node minimum.                                                                                                               |
| MCP remote connection             | Removed unsupported direct REST-key authentication. Explained that advertised OAuth domain scopes do not isolate tools in the current Worker and that its configured server key selects the archive. |
| MCP rich responses                | Corrected `12m` to the actual `12month` enum.                                                                                                                                                        |
| MCP resources and prompts         | Retained existing resource and prompt documentation.                                                                                                                                                 |

### Navigation decision

Keep the current Guides / API Reference / MCP split for this corrective pass. The dedicated MCP tab already separates setup, capabilities, and generated tools. Prerequisites exist in the API quickstart and local MCP setup; a separate requirements page would mostly duplicate them.

For a future editorial pass, choose between retaining the domain-based reference groups (recommended until reader feedback shows a problem) and splitting the longest groups into browse/history/statistics subgroups. Several reference groups and the seven-item Domains/Tools groups exceed the review rubric's roughly five-item guideline. No theme, branding, or navigation taxonomy redesign is included here.

## Internal project cleanup

Recommended order:

1. Reconcile historical trackers with merged code and existing release evidence before moving directories. Prioritize reading-search, reading-music-cards, MCP richness/apps, Apple Music enrichment, and attending-domain. Keep a short close-out note linking the evidence and any remaining follow-up.
2. Keep attending-deep-stats open at its Phase 4 real-client checkpoint. Sports box-score parity remains gated on that decision; do not start it from the stale backlog alone.
3. Keep single-entity-cards open until its selection and client-smoke-test notes are reconciled.
4. Review album-attribution-repair against the newer album identity work before undertaking its old schema/reindex checklist. Do not replay historical data repair commands.
5. Keep current CD artwork work separate from this docs pass. There are active uncommitted artwork changes in another checkout.
6. The archived Apple Music enrichment project is an earlier phase than the unarchived enrichment project; do not deduplicate by directory name alone.

The internal architecture and domain documents remain implementation notes with historical examples and counts, not a certification of current production data. The index now states that distinction.

## Branch cleanup evidence

There are 40 local branches: **29 cleanup candidates**, **eight requiring investigation**, **two with active uncommitted work**, and `main`. No local branch has been deleted. Remote-tracking pruning removed only refs already deleted on GitHub.

Candidate means either the commit is an ancestor of current main, or the local tip exactly matches the head of a merged PR. Squash merges need the latter check. Before a later deletion batch, recheck branch tips and worktree use. The eight investigation branches are not authorized for force deletion by this report.

| Branch                                         | Recommendation                | Evidence                                            |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| `agent/codex-review-automation-20260812`       | Review before removal         | No merged PR matched; unique commits require review |
| `ci/group-security-updates`                    | Review before removal         | PR #285 merged, but local tip differs               |
| `ci/mcp-build-web-on-ship`                     | Keep: active uncommitted work | PR #141 merged, but local tip differs               |
| `codex/agent-workflow-migration`               | Cleanup candidate             | Exact merged PR #182 head                           |
| `codex/docs-almond-theme`                      | Cleanup candidate             | Ancestor of current main                            |
| `codex/listening-track-artwork`                | Review before removal         | No merged PR matched; unique commits require review |
| `codex/normalize-release-deployments`          | Review before removal         | No merged PR matched; unique commits require review |
| `codex/recent-listening-albums`                | Cleanup candidate             | Ancestor of current main                            |
| `codex/refresh-rewind-119`                     | Review before removal         | No merged PR matched; unique commits require review |
| `codex/rewind-dependency-automation-hardening` | Cleanup candidate             | Exact merged PR #175 head                           |
| `codex/rewind-toolchain-security-bridge`       | Review before removal         | PR #174 merged, but local tip differs               |
| `codex/rewind-workers-test-toolchain`          | Cleanup candidate             | Ancestor of current main                            |
| `codex/watching-image-transforms`              | Cleanup candidate             | Ancestor of current main                            |
| `docs/correct-album-audit-report`              | Cleanup candidate             | Exact merged PR #305 head                           |
| `docs/discman-webp-release-evidence`           | Cleanup candidate             | Exact merged PR #317 head                           |
| `docs/maple-theme`                             | Cleanup candidate             | Exact merged PR #134 head                           |
| `feat/artwork-review-gallery`                  | Cleanup candidate             | Exact merged PR #314 head                           |
| `feat/automatic-cd-artwork`                    | Cleanup candidate             | Exact merged PR #309 head                           |
| `feat/cd-art-audiodb`                          | Keep: active uncommitted work | Ancestor of current main                            |
| `feat/cd-artwork-listen-events`                | Cleanup candidate             | Exact merged PR #303 head                           |
| `feat/cd-artwork-pipeline`                     | Cleanup candidate             | Exact merged PR #299 head                           |
| `feat/prepared-lately`                         | Cleanup candidate             | Exact merged PR #277 head                           |
| `fix/album-event-query`                        | Cleanup candidate             | Exact merged PR #308 head                           |
| `fix/album-identity-matching`                  | Cleanup candidate             | Exact merged PR #304 head                           |
| `fix/apex-security-updates`                    | Review before removal         | PR #283 merged, but local tip differs               |
| `fix/apple-cd-catalog`                         | Cleanup candidate             | Exact merged PR #311 head                           |
| `fix/cd-artwork-accepted-coverage`             | Cleanup candidate             | Exact merged PR #301 head                           |
| `fix/cd-artwork-preflight-test`                | Cleanup candidate             | Exact merged PR #302 head                           |
| `fix/cd-catalog-redirect`                      | Cleanup candidate             | Exact merged PR #312 head                           |
| `fix/cd-retail-candidates`                     | Cleanup candidate             | Exact merged PR #313 head                           |
| `fix/cd-source-confidence`                     | Cleanup candidate             | Exact merged PR #310 head                           |
| `fix/discman-artwork-delivery`                 | Cleanup candidate             | Exact merged PR #315 head                           |
| `fix/docs-security-updates`                    | Cleanup candidate             | Exact merged PR #279 head                           |
| `fix/docs-site-deps`                           | Cleanup candidate             | Exact merged PR #139 head                           |
| `fix/mcp-reported-version`                     | Cleanup candidate             | Exact merged PR #307 head                           |
| `fix/mcp-security-updates`                     | Review before removal         | PR #282 merged, but local tip differs               |
| `fix/mcp-server-deps-hono-qs`                  | Cleanup candidate             | Exact merged PR #138 head                           |
| `fix/preserve-album-identity`                  | Cleanup candidate             | Exact merged PR #306 head                           |
| `fix/root-security-updates`                    | Cleanup candidate             | Exact merged PR #281 head                           |
| `main`                                         | Keep: main                    | Ancestor of current main                            |

The primary checkout is on `ci/mcp-build-web-on-ship`, with extensive uncommitted changes and 127 commits behind current main plus three divergent commits. Local `main` is 91 commits behind its remote. Preserve and reconcile that work before switching/resetting the primary checkout. `feat/cd-art-audiodb` is checked out with active artwork work despite its committed tip matching main. A separate detached `lately-release` checkout is clean but older; confirm it is no longer needed before archiving it.

The only open PRs at review time were dependency updates: [#295](https://github.com/pdugan20/rewind/pull/295), [#297](https://github.com/pdugan20/rewind/pull/297), and [#300](https://github.com/pdugan20/rewind/pull/300). Their remote branches must remain intact while those PRs are active.

## Remaining decisions and limitations

- **Publication:** local corrections need a separate commit/push/PR decision before the hosted docs can receive them. No publishing action was taken.
- **Landing policies:** the follow-up cleanup corrected unsupported technical claims about export endpoints, account isolation, OAuth storage, and logging, and documented Voyage/OpenAI processing. Existing operator commitments on retention, request handling, breach notification, and termination were preserved. This is a source-fidelity correction, not legal certification.
- **Landing polish:** the layout still lacks favicon links, canonical/social metadata, a sitemap, and a link to the existing DPA page. Existing assets and the desired brand treatment should be agreed before resuming the old polish project.
- **Hosted verification:** direct HTTPS reads returned 200 for the docs homepage, changelog, and `llms.txt`; the new Lately reference URL returned 404 before publication. Reads of the landing site and public API spec returned 403 from this environment, so their deployed contents were not verified. A 403 here is not evidence that the sites are down.
- **Release readiness:** authenticated quickstart execution, OAuth login, live data, client card rendering, mobile layouts, contrast, and deployment integration were not exercised. They are outside this maintenance pass.
- **Preventing recurrence:** implemented in the follow-up batch below. See [the maintenance guide](../MAINTENANCE.md) for the single-source rules and local commands.

## Verification

| Check                                  | Result                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Mintlify validation                    | Passed after corrections                                                                       |
| Mintlify links, anchors, and redirects | Passed, no broken links reported                                                               |
| API navigation coverage                | All 100 non-hidden snapshot operations have navigable bindings; all 126 navigation files exist |
| OpenAPI snapshot test                  | Passed after regeneration; root and Mintlify snapshots are identical                           |
| Spectral OpenAPI lint                  | Passed, no errors                                                                              |
| Generated MCP reference freshness      | Passed without changes                                                                         |
| Astro landing build                    | Passed, all four routes built after a fresh dependency install                                 |
| Agent instruction lint                 | Passed                                                                                         |
| Changed-file formatting and whitespace | Passed                                                                                         |
| New internal index/review links        | All relative targets resolve                                                                   |

Checks used Node 24.19.0. The root checks reused an existing installed dependency tree; the landing package used a fresh `npm ci --ignore-scripts`. No production writes or authenticated data requests were made. The source edit changes only OpenAPI descriptions and a comment, so the focused contract test was used rather than the full product test suite. The initial documentation pass had no reviewer agents. The follow-up tooling/CI changes received one fresh-context `gpt-6-luna` review at medium effort, with no actionable findings. Dollar cost was not available from the runtime.

## Follow-up cleanup and drift prevention

The owner authorized further fixes and removal of obsolete portions. This batch:

- Removed completed Mintlify migration/setup recipes and the obsolete OpenAPI naming inventory. Replaced the project overview with current maintenance links and the remaining landing-site decisions.
- Removed duplicated endpoint, response-type, and environment tables from internal domain notes. Retained unique integration decisions and historical operational evidence.
- Shortened agent instructions and architecture documentation to link to the source-owned schedules, cache presets, schemas, and configuration instead of copying them.
- Added `docs/MAINTENANCE.md` and a PR documentation prompt. Updated the project index to include the previously missed Instapaper backfill plan; the new checker caught this omission.
- Added read-only API/MCP coverage, snapshot, navigation, and project-index checks with ten adversarial regression tests. A public route is not considered documented merely because a file exists: its binding must be navigable.
- Added those checks, Mintlify validation, anchors/redirect checks, and the landing build to the existing required Docs Links CI job. Extended automation-policy tests to reject removed or optional docs steps. The stable CI job name and publication permissions are unchanged.
- Corrected technical data-handling claims in the privacy and DPA pages while preserving existing operator commitments.

Verification: ten docs-check tests and 81 automation/deployment-policy tests passed. `npm run docs:check` passed, including generated MCP freshness. A single tooling reviewer independently reran the targeted checks and reported no actionable findings. Final Mintlify validation, link checks, landing build, agent-instruction lint, and changed-file formatting also passed. No branch deletion, commit, push, PR, or publication was performed.
