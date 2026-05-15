/**
 * Shared output-schema fragments reused across tool domains.
 *
 * Part of the `outputSchema` work scoped in
 * docs/projects/mcp-server/outputschema-scope.md (issue #105). Spike
 * stage: only the pieces the listening spike needs are defined here.
 *
 * Object schemas use `.passthrough()` so the JSON Schema advertised to
 * clients is `additionalProperties: true` -- a field added by the
 * Rewind API later does not break a client validating against it.
 */
import { z } from 'zod';

/**
 * Image reference attached to listening / watching / collecting
 * entities. Every key is optional and nullable -- the API omits keys it
 * has no value for, and the whole object is null when there is no image.
 */
export const imageSchema = z
  .object({
    cdn_url: z.string().nullish(),
    url: z.string().nullish(),
    thumbhash: z.string().nullish(),
    dominant_color: z.string().nullish(),
    accent_color: z.string().nullish(),
  })
  .passthrough()
  .nullable();
