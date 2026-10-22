import {
  automaticEligible,
  processAutomaticRaw,
  deferStaleAutomatic,
} from './automatic.js';
import guide from './assets/geometry-reference.png';
import { artworkMetadata } from './metadata.js';
import type { ArtworkEnv, JobInput } from './types.js';
import { MODEL, now, sha256 } from './types.js';
import { boundedBytes, ArtworkError } from './sources.js';
import { getJob, claimGenerationSubmission } from './store.js';
import { prepareCandidate } from './registration.js';
import { normalizeRetail, RENDER_STRATEGY } from './rendering.js';
import {
  readProviderFailure,
  syncGenerationStatus,
} from './provider-failure.js';

const rawKey = (userId: number, id: string) => `jobs/${userId}/${id}/raw.png`;
export async function generateOnce(
  env: ArtworkEnv,
  id: string,
  userId: number
): Promise<{ rawKey: string | null; retryAfter?: number }> {
  const job = await getJob(env, id, userId);
  if (!job) throw Error('job_not_found');
  if (job.automatic) {
    const control = await env.DB.prepare(
      'SELECT enabled,automatic_enabled FROM cd_artwork_control WHERE id=1'
    ).first<{ enabled: number; automatic_enabled: number }>();
    if (!control?.enabled || !control.automatic_enabled)
      return { rawKey: null };
    let eligible = false;
    try {
      eligible = await automaticEligible(env, job);
    } catch (error) {
      if (
        !(error instanceof ArtworkError) ||
        !['catalog_identity_unresolved', 'album_not_found'].includes(error.code)
      )
        throw error;
    }
    if (!eligible) {
      await deferStaleAutomatic(env, job);
      return { rawKey: null };
    }
  }
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
        const p = JSON.parse(job.provenance);
        p.reusedRawFrom = prior.id;
        p.rawHash = await sha256(new Uint8Array(bytes));
        p.calculatedUsd = 0;
        const priorRendering = JSON.parse(prior.provenance).nativeRendering;
        if (priorRendering) p.nativeRendering = priorRendering;
        await env.DB.prepare(
          'UPDATE cd_artwork_jobs SET provenance=?,updated_at=? WHERE id=? AND user_id=?'
        )
          .bind(JSON.stringify(p), now(), id, userId)
          .run();
        await env.ARTWORK.put(key, bytes, {
          httpMetadata: { contentType: 'image/png' },
          onlyIf: { etagDoesNotMatch: '*' },
        });
        await env.DB.prepare(
          'UPDATE cd_artwork_jobs SET raw_key=?,updated_at=? WHERE id=? AND user_id=?'
        )
          .bind(key, now(), id, userId)
          .run();
        return { rawKey: key };
      }
    }
  }
  if (job.state !== 'queued') return { rawKey: null };
  const source = await env.ARTWORK.get(job.source_key);
  if (!source) throw Error('source_missing');
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  if ((await sha256(sourceBytes)) !== job.source_hash)
    throw Error('source_integrity_failed');
  const provenance = JSON.parse(job.provenance);
  const retryAt = Date.parse(provenance.providerFailure?.retry_at ?? '');
  if (job.state === 'queued' && retryAt > Date.now())
    return {
      rawKey: null,
      retryAfter: Math.ceil((retryAt - Date.now()) / 1000),
    };
  if (
    job.automatic &&
    !provenance.renderRetry &&
    (JSON.parse(job.input) as JobInput).source_kind === 'retail'
  ) {
    let native;
    try {
      native = normalizeRetail(sourceBytes);
    } catch {
      native = null;
    }
    if (native) {
      // This is deterministic local processing. It neither calls the image
      // provider nor claims/decrements the paid-submission ledger.
      const hash = await sha256(native.bytes);
      provenance.nativeRendering = {
        strategy: RENDER_STRATEGY,
        sourceHash: job.source_hash,
        rawHash: hash,
        verification: native.verification,
      };
      provenance.rawHash = hash;
      provenance.calculatedUsd = 0;
      provenance.model = null;
      // Persist the interpretation before the object. A stopped write sequence
      // must never make an already-normalized source look like provider output.
      const saved = await env.DB.prepare(
        "UPDATE cd_artwork_jobs SET provenance=?,error_code=NULL,updated_at=? WHERE id=? AND user_id=? AND state='queued' AND candidate_hash IS NULL"
      )
        .bind(JSON.stringify(provenance), now(), id, userId)
        .run();
      if (saved.meta.changes !== 1) return { rawKey: null };
      await env.ARTWORK.put(key, native.bytes, {
        httpMetadata: { contentType: 'image/png' },
        onlyIf: { etagDoesNotMatch: '*' },
      });
      await env.DB.prepare(
        "UPDATE cd_artwork_jobs SET raw_key=?,updated_at=? WHERE id=? AND user_id=? AND state='queued' AND candidate_hash IS NULL"
      )
        .bind(key, now(), id, userId)
        .run();
      return { rawKey: key };
    }
  }
  if (!env.OPENAI_API_KEY) return { rawKey: null };
  const form = new FormData();
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
  const claim = await claimGenerationSubmission(env, job);
  if (!claim) return { rawKey: null };
  provenance.providerAttempts = claim.attempt;
  const control = await env.DB.prepare(
    'SELECT enabled FROM cd_artwork_control WHERE id=1'
  ).first<{ enabled: number }>();
  if (!control?.enabled) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE cd_artwork_jobs SET state='queued',submitted_at=NULL,provenance=json_set(provenance,'$.providerAttempts',MAX(0,COALESCE(json_extract(provenance,'$.providerAttempts'),1)-1)),updated_at=? WHERE id=? AND user_id=? AND state='submitted' AND submission_claim=?"
      ).bind(now(), id, userId, claim.token),
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
      const { private_message, ...failure } = await readProviderFailure(
        r,
        provenance.providerAttempts,
        Date.now(),
        { secret: env.OPENAI_API_KEY, prompt: provenance.prompt }
      );
      provenance.providerFailure = failure;
      provenance.providerDiagnosticMessage = private_message;
      const state = failure.retry_at
        ? 'queued'
        : r.status >= 500 || r.status === 408
          ? 'provider_unknown'
          : 'provider_failed';
      await env.DB.prepare(
        "UPDATE cd_artwork_jobs SET state=?,error_code=?,provenance=?,updated_at=? WHERE id=? AND user_id=? AND state='submitted' AND submission_claim=?"
      )
        .bind(
          state,
          `provider_http_${r.status}`,
          JSON.stringify(provenance),
          now(),
          id,
          userId,
          claim.token
        )
        .run();
      await syncGenerationStatus(env, id, userId);
      return {
        rawKey: null,
        ...(failure.retry_at
          ? {
              retryAfter: Math.max(
                1,
                Math.ceil((Date.parse(failure.retry_at) - Date.now()) / 1000)
              ),
            }
          : {}),
      };
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
    provenance.providerFailure = null;
    provenance.providerDiagnosticMessage = null;
    provenance.rawHash = await sha256(bytes);
    provenance.usage = usage ?? null;
    provenance.calculatedUsd = cost;
    provenance.model = MODEL;
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET raw_key=?,provenance=?,error_code=NULL,updated_at=? WHERE id=? AND user_id=? AND state='submitted' AND submission_claim=?"
    )
      .bind(key, JSON.stringify(provenance), now(), id, userId, claim.token)
      .run();
    return { rawKey: key };
  } catch {
    // A network/storage timeout cannot establish whether OpenAI charged. Keep
    // the existing submission claimed; recovering never pays a duplicate.
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='provider_unknown',error_code='provider_outcome_unknown',updated_at=? WHERE id=? AND user_id=? AND state='submitted' AND submission_claim=?"
    )
      .bind(now(), id, userId, claim.token)
      .run();
    await syncGenerationStatus(env, id, userId);
    return { rawKey: (await env.ARTWORK.head(key)) ? key : null };
  }
}
export async function processRaw(env: ArtworkEnv, id: string, userId: number) {
  const job = await getJob(env, id, userId);
  if (!job) throw Error('job_not_found');
  if (job.automatic) return processAutomaticRaw(env, id, userId);
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
