/**
 * Minimal Voyage AI embeddings client.
 *
 * REST-only — no SDK dep, since we're running in a Worker and the
 * Voyage npm client pulls in Node internals. `voyage-3-lite` returns
 * 512-dim embeddings which is what our Vectorize index is provisioned for.
 *
 * Docs: https://docs.voyageai.com/reference/embeddings-api
 */

export type VoyageModel =
  | 'voyage-3-lite'
  | 'voyage-3.5-lite'
  | 'voyage-3-large';
export type VoyageInputType = 'document' | 'query';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { total_tokens: number };
}

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

/**
 * Embed one or more texts in a single Voyage call.
 *
 * - `inputs` is capped by Voyage at 1000 items or 120K tokens per request;
 *   callers are responsible for batching larger sets.
 * - `inputType` affects retrieval quality: use 'document' at index time
 *   and 'query' at search time. Mixing reduces similarity scores.
 */
export async function embedWithVoyage(
  apiKey: string,
  inputs: string[],
  opts: { model?: VoyageModel; inputType?: VoyageInputType } = {}
): Promise<EmbedResult> {
  if (inputs.length === 0) return { vectors: [], tokens: 0 };

  const model = opts.model ?? 'voyage-3-lite';
  const inputType = opts.inputType ?? 'document';

  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: inputs,
      model,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voyage API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as VoyageResponse;
  // Voyage returns results in input order but .data has an explicit index
  // in case it ever reorders — sort to be defensive.
  const sorted = [...body.data].sort((a, b) => a.index - b.index);
  return {
    vectors: sorted.map((d) => d.embedding),
    tokens: body.usage.total_tokens,
  };
}
