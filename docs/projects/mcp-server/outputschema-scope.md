# Scope — `outputSchema` for MCP server tools

Scoping doc for GitHub issue
[#105](https://github.com/pdugan20/rewind/issues/105). Companion to
[`tool-titles-audit.md`](./tool-titles-audit.md), which covered the
`register*` API migration that this work builds on.

## Goal

Declare an `outputSchema` on every one of the ~48 MCP tools. Each tool
already returns a rich `structuredContent` object; `outputSchema` makes that
return shape an explicit, validated contract.

Value:

- **The model** gets a typed description of what a tool returns, rather than
  inferring shape from one sample response.
- **The SDK validates** every returned `structuredContent` against the schema
  at runtime — drift between handler and declared shape becomes a hard error
  instead of a silent contract break.
- **Clients** can rely on the declared shape.

## SDK mechanics

`registerTool`'s config accepts `outputSchema` alongside `inputSchema`. Like
`inputSchema`, it takes a `ZodRawShape` — the shape of an **object** — which
matches the MCP rule that `structuredContent` is a JSON object.

The important behavior: **once `outputSchema` is declared, the SDK validates
`structuredContent` against it on every call.** A mismatch throws. This is the
whole reason #105 is a separate effort from the title migration — it is not a
mechanical wrap; each schema has to actually match what its handler returns.

## Current-state analysis

A catalog of all tool `structuredContent` returns (see issue #105 for the full
table) shows the shapes fall into four groups:

| Group                  | Count (approx) | Shape                                                                                 | Schema difficulty                          |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| **List tools**         | ~22            | `{ items: T[] }`, `{ items: T[], pagination }`, or `{ data: T[], pagination }`        | Low — one element schema + shared wrappers |
| **Stats / flat tools** | ~14            | Flat object of scalars (raw API response, spread)                                     | Low — flat object schema                   |
| **Detail tools**       | ~9             | A named-type object (`MovieDetail`, `AlbumDetail`, `ActivityDetail`, …)               | Low–medium                                 |
| **Design-transformed** | 3              | Hand-built nested shapes — `get_artist_details`, `get_article`, `get_attended_player` | High — bespoke schemas                     |

Two findings that make this **easier than the issue body implied**:

1. **"Varies by branch" is mostly benign.** Many handlers have an empty-state
   branch (`{ items: [] }`) and a populated branch (`{ items: data }`). Both
   satisfy the _same_ schema — `z.array(...)` accepts an empty array. Only a
   handful of tools change top-level keys by branch; those need a union or a
   widened schema.
2. **~25 tools already reuse a named TypeScript `type`/`interface`** for their
   return element (`Scrobble`, `Activity`, `RecentWatch`, `Player`, …). Those
   types are the starting point for the Zod schemas.

Harder spots, flagged so they're not a surprise mid-phase:

- **Opaque sub-objects** — MLB stat lines (`batting_line`, `pitching_line`,
  `season_stats.hitter/pitcher`) are raw upstream API objects with dynamic
  keys. Model as `z.record(z.unknown())`; full typing is out of scope.
- **Nullable nested objects** — `season_attended_summary`, `career`, `splits`
  can be `null`; needs `.nullable()` throughout `get_attended_player`.
- **The 3 design-transformed tools** don't mirror an input type — their
  schemas must be written by hand against the output shape.

## Approach

### 1. Zod as the source of truth

There is no runtime TS-type → Zod conversion. Rather than maintain a hand-
written `type` _and_ a parallel Zod schema, **define the Zod schema and derive
the TypeScript type from it** with `z.infer`. Where a tool file already has a
hand-written `type Scrobble = {...}`, replace it with
`type Scrobble = z.infer<typeof scrobbleSchema>`. One source, no drift.

### 2. Shared schemas

Several shapes repeat across domains. Define them once:

- `paginationSchema` — `{ page, limit, total, total_pages }`
- `imageRefSchema` — `{ cdn_url?, url?, thumbhash?, dominant_color?, accent_color? }`
- `sparklineSchema` — used by listening top-lists

### 3. Strictness policy

Use `.passthrough()` (not `.strict()`) on object schemas. If the Rewind API
adds a field, a passthrough schema keeps validating; a strict schema would
throw. Forward-compatibility matters more than rejecting extra keys here.

### 4. File organization

The tool files are already large (`listening.ts` ~30 KB). Put schemas in a new
`mcp-server/src/tools/schemas/` directory — one file per domain plus
`shared.ts`. Tool files import their schemas. Keeps handlers readable.

## Phasing

Ship as one PR per phase so each is independently reviewable.

| Phase | Work                                                                                                                   | Est.                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0     | `schemas/shared.ts` (pagination, image, sparkline); Zod-as-source-of-truth wiring; pick a conformance-test pattern     | 0.5 day                |
| 1     | **Pilot: listening** (~10 tools). Establishes the per-domain pattern and the test harness                              | 1 day                  |
| 2–7   | Remaining domains — running, watching, reading, attending, collecting, cross-domain (+ `get_health`, `ui_hello_debug`) | ~0.5 day each, ~3 days |

**Total: ~4.5 focused days, ~7 PRs.** The pilot is deliberately first and
slowest — it sets conventions the rest copy.

## Test strategy

Add a conformance test per domain: for each tool, run its handler against a
mocked client response (fixtures already exist in the test suite) and assert
the returned `structuredContent` parses against the tool's `outputSchema`.
This catches handler/schema drift in CI, independent of the SDK's own runtime
validation.

## Open decisions

1. **Zod as source of truth** — recommended above (replace hand-written types
   with `z.infer`). Alternative: keep both in sync manually. Pick before
   Phase 0.
2. **Passthrough vs strict** — recommended `.passthrough()`. Confirm.
3. **Opaque MLB stat objects** — recommended `z.record(z.unknown())`. Accept
   the loss of type depth there, or defer `get_attended_player` to last and
   decide then.

## Out of scope

- Fully typing the MLB Stats API stat-line objects.
- Changing any `structuredContent` _shape_ — this work describes what tools
  already return; it does not redesign returns. If a schema reveals a return
  shape that should change, that's a separate ticket.
