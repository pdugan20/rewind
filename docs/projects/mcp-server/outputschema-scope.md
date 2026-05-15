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
  at runtime — drift between handler and declared shape becomes a hard error.
- **Clients** can rely on, and render against, the declared shape.

## Prior art — clickwheel

The sibling `clickwheel` MCP server already did this (its issue #17, branch
`feat/mcp-output-schemas`). clickwheel is **Python / FastMCP**: it declares a
Pydantic model per tool and annotates the return type (`-> dict` becomes
`-> LibraryStats`); FastMCP **auto-derives** the `outputSchema` from the
annotation. That made it a ~2-line change per tool.

**Rewind cannot copy that cheaply.** TypeScript types are erased at runtime, so
there is no auto-derivation — every schema is hand-authored in Zod and passed
explicitly. The effort estimate below reflects that; clickwheel is the design
reference, not an effort comparison.

## SDK mechanics (verified from the installed SDK source)

`registerTool`'s config accepts `outputSchema`. It takes either a `ZodRawShape`
or a full Zod object schema — including `z.object(...).passthrough()` and
`z.union(...)`.

`validateToolOutput` behavior:

- No `outputSchema` → no validation.
- `outputSchema` declared **but `structuredContent` missing → throws**. Once
  declared, every non-error path _must_ return `structuredContent`.
- `result.isError === true` → validation **skipped**. Error branches (e.g.
  `withRichResponse`'s catch, which returns `isError` and no
  `structuredContent`) are safe.
- Otherwise `structuredContent` is `safeParseAsync`'d against the schema; a
  failure throws `McpError`. The schema is also converted to JSON Schema and
  advertised in `tools/list`.

## Spike results

A spike (branch `spike/mcp-output-schema`) added `outputSchema` to two
listening tools — `get_recent_listens` (list shape) and `get_listening_stats`
(flat shape) — with schemas in a new `src/tools/schemas/` directory, plus an
end-to-end test (`output-schema-spike.test.ts`). Verified:

- ✅ Declaring `outputSchema` round-trips through the SDK with no validation
  error, on both the populated and empty-state branches.
- ✅ The curated `content` text summary is unaffected — `structuredContent` is
  validated independently and passes through untouched.
- ✅ Advertised as JSON Schema with top-level `type: "object"`.
- ✅ **No `$ref` / `$defs`.** Even though `imageSchema` is imported and shared
  across files, the SDK's converter fully inlines it. The historical Claude
  Desktop `$defs` compile bug (mcpb #174, since closed) is moot here.
- ✅ `tsc` clean, full suite 103/103.

**Finding that changed the approach:** the converter emits
`"additionalProperties": false` for a plain `z.object`. That makes the
_advertised_ schema reject any field the Rewind API adds later, even though
server-side Zod validation would tolerate it. Fix: `.passthrough()` on every
object schema → advertised schema becomes forward-compatible. (`.passthrough()`
costs nothing and `tsc` stays clean.)

**Not verifiable in the spike — needs a manual check:** whether Claude Desktop
/ iOS still render the curated text summary once `outputSchema` is present, vs
surfacing the raw structured object. Some clients prioritize `structuredContent`
display. Point a local `rewind-local` build of the spike branch at the client
and eyeball one tool before committing to the full rollout.

## Approach

### 1. Zod as the source of truth

No runtime TS → Zod conversion exists. Define the Zod schema and derive the
TypeScript type from it (`type Scrobble = z.infer<typeof scrobbleSchema>`),
replacing the hand-written `type`. One source, no drift.

### 2. Shared schemas — as factory functions

Repeated shapes live in `schemas/shared.ts` as **factory functions**
(`imageSchema()`, not a shared `imageSchema` constant). Phase 1 found that the
JSON Schema converter emits a `$ref` whenever it sees the _same schema object_
twice in one conversion — `get_artist_details` uses an image schema four times
and serialised with `$ref`s. A factory yields a fresh object per call, so every
occurrence inlines. The conformance test asserts no `$ref` reaches the
advertised schema, so this can't regress.

### 3. `.passthrough()` everywhere

Every object schema gets `.passthrough()` — confirmed by the spike to keep the
advertised JSON Schema `additionalProperties`-open and forward-compatible.

### 4. File organization

Schemas live in `mcp-server/src/tools/schemas/` — one file per domain plus
`shared.ts` (directory created in the spike). Tool files import their schemas.

### 5. Schema value form

Pass a full `z.object(...).passthrough()` as `outputSchema` (not a bare
`ZodRawShape`) so the top-level object is also passthrough. The spike confirmed
the SDK and `tsc` accept this.

## Status — complete

All phases shipped on branch `spike/mcp-output-schema` (PR #109):

| Phase | Work                                                                 | Status |
| ----- | -------------------------------------------------------------------- | ------ |
| 0     | `schemas/shared.ts`, conformance-test pattern                        | ✅     |
| 1     | listening — 10 tools, the `$ref` factory finding                     | ✅     |
| 2–7   | running, watching, reading, attending, collecting, cross-domain      | ✅     |
| —     | `get_health` (gained `structuredContent` + schema)                   | ✅     |
| —     | Consolidation — centralized pagination factories, global guard tests | ✅     |

**All 47 shipping tools declare an `outputSchema`.** `ui_hello_debug` was
removed rather than schema'd — it was a throwaway debug tool. tsc clean,
162 tests pass.

## Test strategy

Two layers:

- **Per-domain conformance** (`output-schema-<domain>.test.ts`): build the
  server with a mocked client, `callTool` each tool against a fixture, assert
  it resolves — a validation failure throws — and `structuredContent` matches.
- **Global guards** (`output-schema.test.ts`): over _every_ registered tool —
  each declares an `outputSchema`, and no advertised schema uses `$ref` /
  `$defs` / `additionalProperties:false`. Catches a future tool regressing
  regardless of domain.

The conformance fixtures are hand-authored, so a schema can still drift from
the real API. The durable fix — cross-checking against the API's OpenAPI spec
— is tracked as issue #110.

## Resolved decisions

1. **Zod as source of truth** — adopted. Hand-written `type`s that match a
   tool's structuredContent are now `z.infer` of the schema.
2. **Opaque MLB stat objects** — `get_attended_player`'s stat lines are
   `z.record(z.unknown())`.
3. **Proceed** — confirmed: the spike's `get_recent_listens` rendered cleanly
   in Claude Desktop with `outputSchema` present.

## Follow-ups (not blocking)

- An `obj()` helper wrapping `z.object(...).passthrough()` — ergonomic only;
  the global guard test already catches a forgotten `.passthrough()`.
- Converting the per-domain test files to the shared `buildTestClient` helper.
- Issue #110 — OpenAPI cross-check.

## Out of scope

- Fully typing the MLB Stats API stat-line objects.
- Changing any `structuredContent` _shape_. This work describes what tools
  already return; a shape that should change is a separate ticket.
