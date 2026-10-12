import guide from './assets/geometry-reference.png';
import { artworkMetadata } from './metadata.js';
import type { ArtworkEnv, JobInput } from './types.js';
import { MODEL, now, sha256 } from './types.js';
import { boundedBytes } from './sources.js';
import { getJob, claimSubmission } from './store.js';
import { prepareCandidate } from './registration.js';

const rawKey = (userId: number, id: string) => `jobs/${userId}/${id}/raw.png`;
export async function generateOnce(
  env: ArtworkEnv,
  id: string,
  userId: number
) {
  const job = await getJob(env, id, userId);
  if (!job) throw Error('job_not_found');
  const key = rawKey(userId, id);
  if (await env.ARTWORK.head(key)) return { rawKey: key };
  if (['pending', 'accepted', 'rejected'].includes(job.state))
    return { rawKey: job.raw_key };
  if (job.state === 'submitted' || job.state === 'provider_unknown') {
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='provider_unknown',error_code='provider_outcome_unknown',updated_at=? WHERE id=? AND user_id=? AND state IN ('submitted','provider_unknown')"
    )
      .bind(now(), id, userId)
      .run();
    return { rawKey: null };
  }
  const generationKey = JSON.parse(job.provenance).generationKey;
  if (generationKey) {
    const prior = await env.DB.prepare(
      "SELECT raw_key,id,provenance FROM cd_artwork_jobs WHERE user_id=? AND album_id=? AND id<>? AND raw_key IS NOT NULL AND json_extract(provenance,'$.generationKey')=? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(userId, job.album_id, id, generationKey)
      .first<{ raw_key: string; id: string; provenance: string }>();
    if (prior) {
      const raw = await env.ARTWORK.get(prior.raw_key);
      if (raw) {
        const bytes = await raw.arrayBuffer();
        await env.ARTWORK.put(key, bytes, {
          httpMetadata: { contentType: 'image/png' },
          onlyIf: { etagDoesNotMatch: '*' },
        });
        const p = JSON.parse(job.provenance);
        p.reusedRawFrom = prior.id;
        p.rawHash = await sha256(new Uint8Array(bytes));
        p.calculatedUsd = 0;
        await env.DB.prepare(
          'UPDATE cd_artwork_jobs SET raw_key=?,provenance=?,updated_at=? WHERE id=? AND user_id=?'
        )
          .bind(key, JSON.stringify(p), now(), id, userId)
          .run();
        return { rawKey: key };
      }
    }
  }
  if (!env.OPENAI_API_KEY || job.state !== 'queued') return { rawKey: null };
  const source = await env.ARTWORK.get(job.source_key);
  if (!source) throw Error('source_missing');
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  if ((await sha256(sourceBytes)) !== job.source_hash)
    throw Error('source_integrity_failed');
  const form = new FormData();
  const provenance = JSON.parse(job.provenance);
  for (const [k, v] of Object.entries(provenance.settings))
    form.append(k, String(v));
  form.append('prompt', provenance.prompt);
  form.append(
    'image[]',
    new File(
      [sourceBytes],
      'source.' + (job.source_mime === 'image/jpeg' ? 'jpg' : 'png'),
      { type: job.source_mime }
    )
  );
  form.append(
    'image[]',
    new File([guide], 'geometry-reference.png', { type: 'image/png' })
  );
  if (!(await claimSubmission(env, job))) return { rawKey: null };
  const control = await env.DB.prepare(
    'SELECT enabled FROM cd_artwork_control WHERE id=1'
  ).first<{ enabled: number }>();
  if (!control?.enabled) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE cd_artwork_jobs SET state='queued',submitted_at=NULL,updated_at=? WHERE id=? AND user_id=? AND state='submitted'"
      ).bind(now(), id, userId),
      env.DB.prepare(
        'UPDATE cd_artwork_control SET submitted_count=MAX(0,submitted_count-1) WHERE id=1 AND budget_day=?'
      ).bind(now().slice(0, 10)),
    ]);
    return { rawKey: null };
  }
  try {
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'X-Client-Request-Id': id,
      },
      body: form,
      signal: AbortSignal.timeout(240000),
    });
    if (!r.ok) {
      await env.DB.prepare(
        "UPDATE cd_artwork_jobs SET state=?,error_code=?,updated_at=? WHERE id=? AND user_id=? AND state='submitted'"
      )
        .bind(
          r.status >= 500 ? 'provider_unknown' : 'provider_failed',
          `provider_http_${r.status}`,
          now(),
          id,
          userId
        )
        .run();
      return { rawKey: null };
    }
    const response = JSON.parse(
      new TextDecoder().decode(await boundedBytes(r, 24 * 1024 * 1024))
    ) as {
      data: Array<{ b64_json: string }>;
      usage?: {
        output_tokens?: number;
        input_tokens_details?: { text_tokens?: number; image_tokens?: number };
      };
    };
    if (response.data?.length !== 1 || !response.data[0].b64_json)
      throw Error('provider_output_invalid');
    const binary = atob(response.data[0].b64_json);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (bytes.length > 12 * 1024 * 1024) throw Error('output_too_large');
    // Persist raw evidence before registration, so processor failures and engine
    // restart can recover without making another paid provider request.
    await env.ARTWORK.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    const usage = response.usage,
      detail = usage?.input_tokens_details;
    const cost =
      detail?.text_tokens !== undefined &&
      detail.image_tokens !== undefined &&
      usage?.output_tokens !== undefined
        ? (detail.text_tokens * 5 +
            detail.image_tokens * 8 +
            usage.output_tokens * 30) /
          1e6
        : null;
    provenance.providerRequestId = r.headers.get('x-request-id');
    provenance.rawHash = await sha256(bytes);
    provenance.usage = usage ?? null;
    provenance.calculatedUsd = cost;
    provenance.model = MODEL;
    await env.DB.prepare(
      'UPDATE cd_artwork_jobs SET raw_key=?,provenance=?,error_code=NULL,updated_at=? WHERE id=? AND user_id=?'
    )
      .bind(key, JSON.stringify(provenance), now(), id, userId)
      .run();
    return { rawKey: key };
  } catch {
    // A network/storage timeout cannot establish whether OpenAI charged. Keep
    // the existing submission claimed; recovering never pays a duplicate.
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='provider_unknown',error_code='provider_outcome_unknown',updated_at=? WHERE id=? AND user_id=? AND state='submitted'"
    )
      .bind(now(), id, userId)
      .run();
    return { rawKey: (await env.ARTWORK.head(key)) ? key : null };
  }
}
export async function processRaw(env: ArtworkEnv, id: string, userId: number) {
  const job = await getJob(env, id, userId);
  if (!job) throw Error('job_not_found');
  if (job.candidate_key && (await env.ARTWORK.head(job.candidate_key)))
    return { state: job.state, candidateHash: job.candidate_hash };
  const key = job.raw_key ?? rawKey(userId, id),
    raw = await env.ARTWORK.get(key);
  if (!raw) return { state: job.state, candidateHash: null };
  try {
    const rawBytes = new Uint8Array(await raw.arrayBuffer()),
      input = JSON.parse(job.input) as JobInput,
      result = prepareCandidate(rawBytes, input);
    const h = await sha256(result.bytes),
      candidateKey = `candidates/${userId}/${h}.png`;
    await env.ARTWORK.put(candidateKey, result.bytes, {
      httpMetadata: { contentType: 'image/png' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    const provenance = JSON.parse(job.provenance);
    provenance.verification = result.verification;
    provenance.metadata = artworkMetadata(result.bytes);
    provenance.rawHash = await sha256(rawBytes);
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='pending',candidate_hash=?,candidate_key=?,raw_key=?,provenance=?,error_code=NULL,updated_at=? WHERE id=? AND user_id=? AND state IN ('queued','submitted','provider_unknown','needs_registration','needs_material_review') AND candidate_hash IS NULL"
    )
      .bind(h, candidateKey, key, JSON.stringify(provenance), now(), id, userId)
      .run();
    const persisted = await getJob(env, id, userId);
    return {
      state: persisted?.state ?? 'needs_registration',
      candidateHash: persisted?.candidate_hash ?? null,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'processing_failed';
    const state =
      code === 'material_review_required'
        ? 'needs_material_review'
        : 'needs_registration';
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state=?,raw_key=?,error_code=?,updated_at=? WHERE id=? AND user_id=? AND state IN ('queued','submitted','provider_unknown','needs_registration','needs_material_review') AND candidate_hash IS NULL"
    )
      .bind(
        state,
        key,
        [
          'material_review_required',
          'rim_uncertain',
          'hole_uncertain',
          'hole_connected_to_background',
          'registration_geometry_failed',
          'output_dimensions_invalid',
        ].includes(code)
          ? code
          : 'processing_failed',
        now(),
        id,
        userId
      )
      .run();
    return { state, candidateHash: null };
  }
}
