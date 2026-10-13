# MCP Richness -- Design

Canonical response shapes, helper utilities, and policies every domain phase follows. If a domain phase deviates from this doc, update the doc first.

## Target client (important)

Design responses to be spec-compliant per MCP 2025-06-18 and assume **Claude Desktop (macOS) / Claude iOS** as the primary client. Those clients render image and resource_link content blocks as first-class UI and respect `structuredContent`.

**Do not optimize for Claude Code CLI.** We verified with a live stdio e2e test (`src/__tests__/stdio-e2e.live.ts`) that the Rewind MCP server emits correct `content` arrays including base64 image blocks. Claude Code's UI appears to suppress `content` blocks when `structuredContent` is present, and does not render image blocks inline regardless. Those are client limitations -- not reasons to change the server contract.

## Content block vocabulary

Per MCP 2025-06-18:

- `text` -- Markdown-friendly prose. Always include exactly one at the top.
- `image` -- base64 `data` + `mimeType`. Counts against `MAX_MCP_OUTPUT_TOKENS`.
- `resource_link` -- URI reference. Does not inline content. Ideal for external platform URLs.
- `embedded_resource` -- Inline full resource (URI + content). Use for small derived artifacts; prefer `resource_link` for external.
- `structuredContent` -- JSON object field on the tool result, parallel to `content`.

## Canonical shapes per tool class

### Single-entity detail tool (e.g. `get_movie_details`, `get_album_details`, `get_activity_details`)

```ts
{
  content: [
    { type: 'text', text: <human summary> },
    { type: 'image', data: <primary artwork bytes>, mimeType: 'image/jpeg' },   // optional, see image policy
    { type: 'resource_link', uri: <external URL>, name: <platform>, mimeType: 'text/html' }, // one per platform
  ],
  structuredContent: <full API response as JSON>,
}
```

### List / browse tool (e.g. `get_recent_watches`, `get_vinyl_collection`, `browse_movies`)

```ts
{
  content: [
    { type: 'text', text: <table-style summary> },
    // images ONLY on the top N items per image policy below
    ...topN.map(item => ({ type: 'image', data: ..., mimeType: 'image/jpeg' })),
  ],
  structuredContent: { items, pagination },
}
```

### Stats / aggregate tool (e.g. `get_listening_stats`, `get_watching_stats`, `get_running_streaks`)

```ts
{
  content: [
    { type: 'text', text: <human summary with key numbers> },
  ],
  structuredContent: <raw aggregate shape mirroring the API>,
}
```

No image content on stats tools.

### Search / feed / on-this-day (cross-domain)

```ts
{
  content: [
    { type: 'text', text: <summary> },
    ...matches.map(m => ({ type: 'resource_link', uri: m.rewindEntityUri, name: m.title, mimeType: 'application/json' })),
  ],
  structuredContent: { items },
}
```

Resource URIs point at the entity resources defined in each domain's phase (e.g. `rewind://movie/123`).

## Image policy

1. Detail tools may return one image (the primary artwork).
2. List tools may return images for the first N items, N = 5 by default. Configurable per tool if the use case justifies more.
3. Stats tools never return images.
4. Image fetch: pass the entity's `image` attachment object directly to `imageBlock(client, image)`. The helper pulls the public CDN URL from `image.cdn_url` (with `image.url` fallback), fetches it without auth headers, and base64-encodes the body. `mimeType` comes from the CDN response's `content-type` header.
5. **Do not route image fetches through `/v1/images/...`.** That endpoint requires a Bearer token and 302-redirects cross-origin to `cdn.rewind.rest`; the redirect hop was unreliable (auth forwarding, runtime differences) and failures were silent. The public CDN URL is already in every entity's `image.cdn_url` field, needs no auth, and returns the bytes directly.
6. On fetch failure, omit the image and proceed -- never fail the tool because of an image.
7. Every tool that can return images must be reachable without them via a `include_images: false` input option, default `true`. Keeps token budgets predictable for callers that don't need pixels.

## `resource_link` conventions

- `name` -- short, platform-recognizable ("Letterboxd review", "Strava activity", "Discogs release", "Original article").
- `mimeType` -- `text/html` for external web URLs, `application/json` for internal `rewind://` entity resources.
- `description` (optional) -- one short sentence when the name alone is ambiguous.
- Always check the source field is non-null before emitting the block. Never emit `resource_link` with an empty URI.

## `structuredContent` conventions

- Shape mirrors the corresponding API response as closely as possible so Claude can reason over the same types that power the docs site.
- Include pagination metadata verbatim from the API for list responses.
- Do not duplicate raw URL strings that are also emitted as `resource_link` -- once each, no more.
- Text summary and structured content must agree. If they diverge, fix the text.

## Helper utilities

Add to `mcp-server/src/tools/helpers.ts`:

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      mimeType?: string;
      description?: string;
    };

type ToolResult<S = unknown> = {
  content: ContentBlock[];
  structuredContent?: S;
  isError?: boolean;
};

// Builders
function text(text: string): ContentBlock;
function resourceLink(
  uri: string,
  name: string,
  opts?: { mimeType?: string; description?: string }
): ContentBlock | null;
async function imageBlock(
  client: RewindClient,
  image: ImageAttachment
): Promise<ContentBlock | null>;

// Wrapper replacing `withErrorHandling` for rich responses
async function withRichResponse<S>(
  fn: () => Promise<ToolResult<S>>
): Promise<ToolResult<S>>;
```

`resourceLink` and `imageBlock` return `null` when the source is missing or the fetch fails; callers filter nulls before returning. `withRichResponse` catches exceptions and returns `{ content: [text("Error: ...")], isError: true }`.

`withErrorHandling` stays as-is for any tool that legitimately returns only text, to avoid churn.

## `server.instructions`

A single string registered at server init, under 2KB (Claude Code truncates above that). Draft:

```text
Rewind is a personal data archive covering music listening (Last.fm + Apple Music),
running (Strava), watching (Plex + Letterboxd + manual movie entries), collecting
(vinyl via Discogs, physical media), and reading (Instapaper articles and
highlights). Use these tools when the user asks about their own listening, running,
watching, reading, or collecting history, stats, streaks, top lists, or
cross-domain feeds like "what did I do on <date>" or "on this day in past years".
Tools return human-readable text plus structured JSON and, for entity details,
cover art or posters as image content. External platform URLs (Letterboxd, Strava,
Discogs, Apple Music) are returned as clickable resource links.
```

## SDK bump

- **Done:** Bumped `@modelcontextprotocol/sdk` 1.12.1 -> 1.29.0 at Phase 0 start.
- `tsc` built clean and all 40 existing tests passed without code changes.
- Legacy registration methods (`server.tool`, `server.resource`, `server.prompt`) remain supported. The modern API is `server.registerTool`, `server.registerResource`, `server.registerPrompt` -- use the modern form for any _new_ tool added in this project, but there is no need to migrate existing tool files en masse.
- Image, resource_link, and structuredContent content types are supported by the current `McpServer` tool result shape. The helpers below rely on this without a separate migration step.
- 2.0.0-alpha is out but introduces breaking changes (error semantics via JSON-RPC codes, removal of deprecated method signatures, StandardSchema support). **Pin below 2.0.0** for now. Reassess once 2.0.0 stabilizes.

## Elicitation

Reserved for Phase 2+ only if a concrete case appears. Canonical example if used:

- `browse_movies` returns >1 exact-title match for an otherwise unambiguous query -- elicit a pick from the matches instead of returning a list and asking the user to re-query.

Any elicitation usage must be justified per-tool in its phase section of TRACKER.md.
