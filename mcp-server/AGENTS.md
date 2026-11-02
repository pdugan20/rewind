# MCP server package

Rules for `mcp-server/`: the `rewind-mcp-server` npm package and the Worker at
`mcp.rewind.rest`. The root [AGENTS.md](../AGENTS.md) covers the API Worker, approvals, and
repository-wide conventions.

## Node and npm support

- The published package supports Node 22 and 24 (`engines: >=22.0.0`), and CI builds and
  tests on both. The root Worker supports only Node 24, so don't use APIs or syntax here that
  Node 22 lacks, and don't raise this package's `engines` floor as part of a root change.
- CI pins npm 11.5.2 for both packages. Install with `npm ci` inside `mcp-server/`; it has its
  own lockfile.

## Commands

Run from `mcp-server/`, or from the root with `npm --prefix mcp-server run <script>`.

```bash
npm run build        # tsc into dist/
npm test             # Vitest
npm run check:web    # verify the inlined UI bundles are current; build:web regenerates them
npm run mcp:update   # refresh the manifest snapshot after changing tools, prompts, or resources
npm run check:docs   # every registered tool, prompt, and resource has a reference page
npm pack --dry-run   # confirm the published files
```

## Rules

- Registrations live in `src/tools/`, `src/prompts.ts`, and `src/resources/`. When one changes,
  update `mcp-manifest.snapshot.json` with `npm run mcp:update` and regenerate the reference
  pages with `npm run docs:gen-mcp` at the root, in the same change. See
  [docs/MAINTENANCE.md](../docs/MAINTENANCE.md).
- Don't bump `version` in `package.json` by hand. release-please opens the release PR and
  updates it with `.release-please-manifest.json`; CI fails on drift between the two.
- Publishing to npm and deploying the Worker (`npm run deploy`) need explicit approval, as the
  root guide requires for every deployment and release.
- The package reads `REWIND_API_KEY` and `REWIND_API_URL`. Never put a real key in code,
  fixtures, docs, or test output.
