/**
 * Shared output-schema fragments reused across tool domains.
 *
 * Part of the `outputSchema` work scoped in
 * docs/projects/mcp-server/outputschema-scope.md (issue #105).
 *
 * Fragments are exposed as **factory functions**, not shared constants.
 * The JSON Schema converter emits a `$ref` whenever it sees the *same
 * schema object* more than once in a single conversion -- so a tool that
 * uses `imageSchema` several times (e.g. an artist card with images on
 * the artist, its top tracks, and its top albums) would serialise with
 * `$ref`s, which older Claude Desktop builds failed to compile. Calling a
 * factory yields a fresh object per use, so every occurrence inlines.
 *
 * Object schemas use `.passthrough()` so the advertised JSON Schema is
 * `additionalProperties`-open -- a field the Rewind API adds later does
 * not break a client validating against it.
 */
import { z } from 'zod';

/**
 * Image reference attached to listening / watching / collecting
 * entities. Every key is optional and nullable -- the API omits keys it
 * has no value for, and the whole object is null when there is no image.
 */
export function imageSchema() {
  return z
    .object({
      cdn_url: z.string().nullish(),
      url: z.string().nullish(),
      thumbhash: z.string().nullish(),
      dominant_color: z.string().nullish(),
      accent_color: z.string().nullish(),
    })
    .passthrough()
    .nullable();
}

/**
 * Pagination block on list endpoints -- the `pagination` field of a
 * `{ data: [...], pagination: {...} }` response. Always present on a
 * paginated response (never null).
 */
export function paginationSchema() {
  return z
    .object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      total_pages: z.number(),
    })
    .passthrough();
}
