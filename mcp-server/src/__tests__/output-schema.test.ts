/**
 * Global output-schema guards (issue #105).
 *
 * Domain-agnostic invariants over EVERY registered tool. These catch a
 * future tool added without an `outputSchema`, or one whose advertised
 * JSON Schema regresses to `$ref` / `$defs` / `additionalProperties:false`
 * -- regardless of which domain it lives in.
 *
 * The per-domain `output-schema-*.test.ts` files cover `structuredContent`
 * conformance against fixtures; this file covers the advertised schema.
 */
import { describe, it, expect } from 'vitest';
import { buildTestClient } from './helpers/build-client.js';

describe('output-schema — global guards', () => {
  it('every registered tool declares an outputSchema', async () => {
    const client = await buildTestClient();
    const { tools } = await client.listTools();
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(
      missing,
      `tools missing outputSchema: ${missing.join(', ') || '(none)'}`
    ).toEqual([]);
  });

  it('no advertised outputSchema uses $ref/$defs or closed additionalProperties', async () => {
    const client = await buildTestClient();
    const { tools } = await client.listTools();
    for (const t of tools) {
      if (!t.outputSchema) continue;
      const json = JSON.stringify(t.outputSchema);
      // $ref/$defs: older Claude Desktop builds failed to compile them --
      // shared schema fragments must be factory functions so each use
      // inlines. additionalProperties:false would reject any field the
      // Rewind API adds later -- every object schema must be .passthrough().
      expect(json, `${t.name}: $ref`).not.toContain('$ref');
      expect(json, `${t.name}: $defs`).not.toContain('$defs');
      expect(json, `${t.name}: additionalProperties:false`).not.toContain(
        '"additionalProperties":false'
      );
    }
  });
});
