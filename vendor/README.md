# Zod 3 bounds backport

Mintlify's locked scraping and validation packages require Zod 3.24.0. Zod 4
changes their schema AST and enum-record behavior, so replacing their dependency
with a different major would break documentation tooling. The application and MCP
package retain their patched Zod 4 dependencies.

`zod3-bounds.patch` backports the upper-bound short circuit from the
[upstream fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)
to Zod 3's CommonJS, ES module and UMD runtimes. Oversized `.max()`, `.length()`
arrays, `.max()`/`.size()` sets, and tuples without a rest schema fail before
iterating or parsing elements. Issue codes, paths, messages and the public Zod 3
API/types stay intact; aggregate issues and outer refinements intentionally stop
on that invalid oversized value. Lower bounds and valid inputs keep their behavior.

This is not a global input or issue limit. Unbounded schemas, maps/records without
an upper-bound API, user preprocessors and hostile JavaScript getters are not
made resource-safe by this patch. The fix addresses the constrained-collection
behavior in [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## Installation and verification

The root `postinstall` script checks every installed Zod 3 copy before modifying
any file. Only exact source digests from the pinned upstream tarball, or the exact
patched digests in `zod3-backport.json`, are accepted. Writes use adjacent temporary
files and atomic rename. Repeated or interrupted applications are safe to resume.
Package names, versions, licenses, exports, types and registry lockfile integrity
remain unchanged. No dependency is renamed or marked private to hide an advisory.

`npm ci` applies the patch. After an explicit `npm ci --ignore-scripts`, run
`npm run deps:patch` before using the documentation tools. The `docs:dev`,
`docs:validate` and `docs:links` commands refuse to start if any copy is unpatched
or has unrecognized contents. Use those commands rather than a raw Mint command.
CI independently checks the digests and exercises all six installed runtime
entry points, including sparse-array iterator traps, sync/async bounds, valid
transforms, enum records, error paths and patch lifecycle failures. CI also runs
Mintlify validation, broken-link checks and the existing application/doc tests.

Production-only installs that explicitly omit development dependencies skip the
patch only when both Mintlify consumers and every Zod 3 copy are absent. Partial
installs still fail, and documentation commands always require the patched tools.

`npm audit` and Dependabot can continue to flag version 3.24.0. This repository
keeps that advisory metadata visible: the source-level backport is not a published
upstream release, and no alert is dismissed. Retire it when Mintlify adopts an
upstream version with the fix, after running the same compatibility checks.

## Rebuild the provenance

Obtain the exact official `zod@3.24.0` archive with `npm pack zod@3.24.0
--ignore-scripts`, then run:

```bash
npm run vendor:zod3 -- /absolute/path/to/zod-3.24.0.tgz
npm run deps:patch
npm run test:zod3-backport
npm run docs:validate
npm run docs:links
```

The builder rejects an archive unless its SHA-256 matches the pinned source. It
regenerates the reviewable diff and file digests, confirms only the three runtime
files change, and preserves the upstream MIT-licensed files. Rebuilding does not
fetch arbitrary code, publish a package or change any live service.
