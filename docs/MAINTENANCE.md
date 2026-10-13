# Keeping documentation current

Update documentation in the same change as the behavior it describes. Prefer deleting a duplicate fact and linking to its owner over maintaining another copy.

## Sources of truth

| Information                                       | Owner                                                | Documentation                                                                   |
| ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| API paths, parameters, response schemas, examples | Route definitions in `src/routes/`                   | Tested OpenAPI snapshots; Mintlify renders native endpoint bindings             |
| API page coverage and stable URLs                 | `docs-mintlify/api-reference/` and `docs.json`       | Every non-hidden snapshot operation must have a navigable binding               |
| MCP tools and parameters                          | Registrations in `mcp-server/src/`                   | Tested manifest, then generated per-domain reference                            |
| MCP resource and prompt inventory                 | MCP registrations                                    | Existing MCP runtime docs check                                                 |
| Cron schedules, bindings, environment types       | Worker configuration and `src/types/env.ts`          | Link to source; do not copy inventories into agent instructions                 |
| Cache presets and image URL construction          | `src/lib/cache.ts`, `src/services/images/presets.ts` | Explain the contract and exceptions; avoid copied constant tables               |
| Reader workflows and explanations                 | `docs-mintlify/` guides                              | Reviewed against implementation when behavior changes                           |
| Project decisions and evidence                    | `docs/projects/`                                     | Indexed in `docs/README.md`; completed plans are historical                     |
| Data handling and operator commitments            | Landing policy pages and operator review             | Reconcile with providers and access behavior; tests cannot certify legal claims |

The main OpenAPI snapshot does not cover the separate CD artwork Worker. Its runbook and Images guide must be reviewed when that Worker changes; passing API coverage checks is not proof that this separate surface is documented.

## Local checks

Use the Node/npm versions specified by the root package and install dependencies with `npm ci`. Install landing-site dependencies with `npm ci --prefix docs-site --ignore-scripts` before building that package.

```bash
npm run test:docs
npm run docs:check
npm run docs:validate
npm run docs:links
npm run www:build
```

`docs:check` is read-only. It checks matching OpenAPI snapshots, public-operation coverage, stale/hidden/duplicate bindings, navigation targets, MCP tool coverage, and project-index completeness. It then checks generated MCP page freshness. Missing or malformed required inputs fail the command.

The Docs Links CI job runs these checks on every PR and main push, including the landing build and assertions that all policy pages render their title, heading, and update date. Policy-route regressions verify that the apex serves those pages without forwarding client credentials. It remains part of the required CI Gate. Automation-policy tests reject removal or conditional/continue-on-error bypass of the new docs steps. Existing product tests independently compare the runtime OpenAPI spec and MCP manifest with their snapshots.

## When an API changes

1. Update the route's source schema, description, and safe examples. Do not edit the generated JSON as the primary fix.
2. Run `npm run spec:update` to regenerate both OpenAPI snapshots. Review the diff.
3. For a new public operation, add a small MDX file with `openapi: get /v1/...` frontmatter and add its stable path to `docs-mintlify/docs.json`. Reuse existing URLs for renamed summaries; do not regenerate all slugs.
4. For a removed operation, remove its binding and navigation entry, then fix links or add an appropriate redirect. Hidden operations must not have public bindings.
5. Run the focused snapshot test without update mode, `npm run lint:api`, and the docs checks above. Review affected guides and changelog separately.

## When MCP changes

```bash
npm --prefix mcp-server run mcp:update
npm run docs:gen-mcp
npm run docs:check
npm --prefix mcp-server run check:docs
```

Install the MCP package's dependencies before these commands. A new tool domain needs a generator grouping as well as registration; coverage checks catch tools silently omitted from generated pages. Changes to resources, prompts, authentication, client requirements, or cards also require their hand-authored guides to be reviewed.

## When a project changes status

Add each new project folder to `docs/README.md`, including projects whose entry point is `PLAN.md` or a runbook rather than `README.md`. Before archiving, record what shipped, the evidence, and which follow-ups remain. Keep unique decisions and release evidence. Delete superseded configuration examples and duplicate endpoint/type inventories; Git retains them if needed.

Do not replay an old deployment, migration, backfill, or deletion checklist simply because its box is unchecked. A historical plan is not current authorization.

## What still needs judgment

Automation catches missing pages, stale generated content, invalid builds, and broken links. It cannot prove that an English claim matches behavior, that a release reached production, or that a client's UI works.

For a behavior change, review the affected guide in the same PR and state which page changed or why no documentation change is needed. Authentication, providers, storage, logging, retention, export, and data-sharing changes also require a policy review. Avoid precise limits or security guarantees unless there is a maintained source and evidence for them.

Local validation does not publish either site. Deployments, pushes, and PRs still follow the repository's authorization rules. Hosted drift requires comparing the deployed site/version after an authorized release; this pass adds no scheduler or background automation.

## Policy publication

The public apex is served by `apex-worker`, which owns the small homepage and transparent icons. Public policy content is built from `docs-site` and deployed to the `rewind-www` Cloudflare Pages project on its production `main` branch. The apex proxies only `/privacy/`, `/terms/`, and `/dpa/` to that Pages origin; other deep links still redirect to Mintlify. Do not assume publishing Pages changes the apex routing code.

After an authorized publication, verify all three policy paths on `rewind.rest` in a browser, including their headings and dates. Publish the Pages content before deploying a routing change that depends on it. The built-policy check also rejects new root-relative stylesheet/script assets until the apex has a route for them.

## Deployment source drift

Documentation contract checks cannot establish which runtime source is deployed. Use `npm run deployment:check` from a clean checkout on committed main to inspect API/artwork version lineage. The guarded `deploy:worker` and `deploy:artwork` commands verify source before uploading and attach a Git commit tag. API-only edits do not redeploy artwork; shared runtime inputs conservatively affect both. See the [October 13 closeout](maintenance/2026-10-13-closeout.md) for the bootstrap versions, scope, and recovery procedure. Unknown live versions require source reconciliation, not an automatic overwrite. Production operations still need their existing authorization.
