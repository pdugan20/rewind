# Documentation site maintenance

The Scalar-to-Mintlify migration and initial OpenAPI cleanup are complete. Current docs live in `docs-mintlify/`; the Astro landing and policy pages live in `docs-site/`.

Use the [maintenance guide](../../MAINTENANCE.md) for local commands, sources of truth, and CI checks. The old setup/configuration copy and endpoint-name inventory were removed because they contradicted the live configuration; their history remains in Git.

## Remaining work

- Decide whether to resume landing branding, metadata, favicon, and sitemap work.
- Review the landing policy pages when providers, data use, or access behavior changes.
- Treat a status page as a separate product decision, not an unfinished docs migration task.

The [landing proposal](LANDING-SITE.md) is historical design input. Inspect the current site before reusing its code snippets. The [original tracker](TRACKER.md) preserves completion and open follow-up evidence; it is not a fresh execution plan.
