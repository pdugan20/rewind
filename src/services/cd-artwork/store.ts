import { verifiedCover, type SelectedSource } from './selection.js';
import type { ArtworkEnv, Job, JobInput, JobRequest } from './types.js';
import { MODEL, PROCESSOR_VERSION, sha256, stable, now } from './types.js';
import { ArtworkError, downloadImage, resolveSource } from './sources.js';
import { readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
import template from './assets/cover-template.png';
import guide from './assets/geometry-reference.png';
import { PROCESSOR_HASH } from './processor-version.js';
import { RENDER_STRATEGY } from './rendering.js';

export const getJob = (env: ArtworkEnv, id: string, userId: number) =>
  env.DB.prepare('SELECT * FROM cd_artwork_jobs WHERE id=? AND user_id=?')
    .bind(id, userId)
    .first<Job>();
export const getPendingAutomatic = (
  env: ArtworkEnv,
  albumId: number,
  userId: number
) =>
  env.DB.prepare(
    "SELECT * FROM cd_artwork_jobs WHERE user_id=? AND album_id=? AND automatic=1 AND (state IN ('queued','submitted','provider_unknown','pending') OR (state='needs_registration' AND COALESCE(validation_state,'') IN ('','claimed','passed'))) LIMIT 1"
  )
    .bind(userId, albumId)
    .first<Job>();
export async function ownedAlbum(env: ArtworkEnv, id: number, userId: number) {
  const album = await env.DB.prepare(
    'SELECT a.name,a.mbid,a.identity_conflict,a.apple_music_id,r.name AS artist,r.mbid AS artist_mbid,r.identity_conflict AS artist_identity_conflict FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id WHERE a.id=? AND a.user_id=?'
  )
    .bind(id, userId)
    .first<{
      name: string;
      artist: string;
      mbid: string | null;
      identity_conflict: number;
      artist_identity_conflict: number;
      artist_mbid: string | null;
      apple_music_id: number | null;
    }>();
  if (!album) throw new ArtworkError('album_not_found', 404);
  if (album.identity_conflict || album.artist_identity_conflict)
    throw new ArtworkError('catalog_identity_unresolved');
  return album;
}
export async function enqueue(
  env: ArtworkEnv,
  request: JobRequest,
  userId: number,
  prepared = false,
  automatic?: {
    source: SelectedSource;
    expectedActiveJob: string | null;
    catalogIdentity: Awaited<ReturnType<typeof ownedAlbum>>;
  }
) {
  const album = await ownedAlbum(env, request.album_id, userId);
  if (
    automatic &&
    JSON.stringify(automatic.catalogIdentity) !== JSON.stringify(album)
  )
    throw new ArtworkError('catalog_identity_changed');
  // Repeated identical requests avoid even source/provider reads. Changed bytes
  // can be explicitly rechecked; their content changes the final fingerprint.
  const { refresh_source, ...identityInput } = request;
  const requestKey = await sha256(
    JSON.stringify(
      stable({
        input: identityInput,
        prepared,
        renderRetry: automatic?.source.renderRetry ?? null,
        catalogIdentity: album,
        automatic: !!automatic,
        ...(automatic?.source.preparedBytes
          ? { selectedSourceHash: await sha256(automatic.source.preparedBytes) }
          : {}),
        expectedActiveJob: automatic?.expectedActiveJob ?? null,
      })
    )
  );
  const existing = await env.DB.prepare(
    "SELECT * FROM cd_artwork_jobs WHERE user_id=? AND album_id=? AND json_extract(provenance,'$.requestKey')=? AND json_extract(provenance,'$.processorHash')=? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userId, request.album_id, requestKey, PROCESSOR_HASH)
    .first<Job>();
  if (existing && !refresh_source) return { job: existing, reused: true };
  if (automatic) {
    const pending = await getPendingAutomatic(env, request.album_id, userId);
    if (pending) return { job: pending, reused: true, blocked: true };
  }
  const source =
    automatic?.source ??
    (request.release_id
      ? await resolveSource(env, request, album)
      : await verifiedCover(env, request.album_id, userId, album));
  if (
    !request.release_id &&
    request.cover_url &&
    request.cover_url !== source.sourceUrl
  )
    throw new ArtworkError('cover_identity_unverified');
  const input: JobInput = { ...request, source_kind: source.sourceKind };
  const { bytes, mime } =
    automatic?.source.preparedBytes && automatic.source.preparedMime
      ? {
          bytes: automatic.source.preparedBytes,
          mime: automatic.source.preparedMime,
        }
      : await downloadImage(source.sourceUrl);
  const pixels = readPixels(bytes);
  if (Math.max(pixels.width, pixels.height) < 660)
    throw new ArtworkError('needs_better_source');
  if (pixels.width * pixels.height > 12_000_000)
    throw new ArtworkError('source_dimensions_too_large');
  const sourceHash = await sha256(bytes),
    templateHash = await sha256(new Uint8Array(template)),
    guideHash = await sha256(new Uint8Array(guide));
  const renderRetry = automatic?.source.renderRetry;
  const materialInstructions = automatic
    ? `Return a PNG with genuine alpha outside the physical disc and through the spindle hole. Keep printed ink and opaque metal opaque, including white/silver printing. Preserve existing source alpha and physical detail without invented material effects. ${input.source_kind === 'cover' ? 'The reserved hub from radius60 to88 must be unprinted and neutral gray, not white or transparent: use a plain opaque gray placeholder so its spindle boundary remains measurable. The renderer replaces that placeholder with clear plastic; do not draw rings or hub decoration.' : 'Preserve photographed hub tones and boundaries, including any existing source transparency. Do not guess a translucent region, erase printing or metal, or enlarge the hole. Material identification and clear-plastic alpha are handled separately by the renderer.'} Do not bake a white matte, checkerboard, shadow, scene or reflection into the disc.`
    : 'For cover-based designs render the printed artwork without painting a physical rim; hub material is supplied separately by the processing template. Use an otherwise perfectly plain white background including through the hole; no cast shadow, checkerboard, annotations, dimension labels, hands or perspective tilt.';
  const prompt = `Image 1 is the edit target: ${album.artist} — ${album.name}. It is the authority for artwork, lettering, color and layout.\nImage 2 is a flat geometry guide only, not a material or style reference. Output a square front-on orthographic disc centered at (512,512) on a 1024x1024 canvas, outer diameter 960 pixels and concentric spindle hole diameter 120 pixels. Leave 32 pixels of margin. A real CD is 120 mm across with a 15 mm hole. Do not confuse the larger hub ring with the hole.\n${input.source_kind === 'retail' ? 'Restore this existing CD scan to a complete front-facing disc. Correct slight perspective, reconstruct only missing rim and immediately adjacent cropped artwork, and remove the surrounding scan background. Keep the original printed face and material. Do not redesign the disc or replace its authentic face with the album cover.' : 'Make an explicitly cover-based CD design, not an imitation of an unknown retail disc. Apply the album cover to the printable face. Preserve recognizable artwork and existing lettering; reposition/scale the cover as one unit if needed to keep important content away from the hole and rim. Extend only the existing background into unused space. Reserve the center from radius60 to88 for an unprinted clear-plastic hub: the finishing renderer supplies its material. Keep important artwork and lettering outside this reserved hub and inside radius470. Add no text.'}\nPreserve all existing lettering, logos, fine linework, relative placement and orientation. Do not invent track names, labels, catalog numbers or new branding. Do not redraw recognizable artwork into a different design.\nPreserve the source appearance without adding decorative materials. Do not invent iridescent/rainbow/chrome rims, colored reflections, metallic borders, glow or specular glints. For retail scans retain only physical rim and material details actually visible in image 1. For cover-based designs render the printed artwork without an invented decorative rim. ${materialInstructions} ${automatic ? 'The shared renderer supplies the final outer edge: it replaces only the outermost 10 pixels with plain silver-gray disc material after centering. Do not draw or invent an outer border for it. Preserve the source artwork through that area; let the renderer create the consistent finish. This rule applies to both retail restorations and cover-based designs.' : ''} No annotations, dimension labels, hands or perspective tilt.${renderRetry ? `\nThis is the single controlled regeneration after a ${renderRetry.reason} failure. ${renderRetry.reason === 'geometry' ? 'Prioritize one physically coherent front-on disc: rim, spindle and all printed hub rings share one center and are circular. Do not repair only the silhouette while leaving eccentric printed rings.' : 'Prioritize fidelity to image 1. Preserve its existing lettering and recognizable details without interpretation; avoid synthesized text, smears and duplicate elements.'} Work from the authoritative source again; do not carry defects from the failed render forward.` : ''}`;
  const settings = {
    model: MODEL,
    quality: 'high',
    size: '1024x1024',
    background: automatic ? 'transparent' : 'opaque',
    output_format: 'png',
    n: 1,
  };
  const generationKey = await sha256(
    JSON.stringify(
      stable({
        sourceHash,
        prompt,
        settings,
        guideHash,
        ...(automatic
          ? { renderStrategy: RENDER_STRATEGY, rendererHash: PROCESSOR_HASH }
          : {}),
      })
    )
  );
  const provenance = {
    generationKey,
    requestKey,
    renderRetry: renderRetry ?? null,
    catalogIdentity: album,
    automatic: !!automatic,
    expectedActiveJob: automatic?.expectedActiveJob ?? null,
    prepared,
    sourceUrl: source.sourceUrl,
    sourceHash,
    sourceDimensions: [pixels.width, pixels.height],
    identityType: source.identityType,
    selectedImageId: source.selectedImageId,
    sourceKind: input.source_kind,
    sourceIdentityEvidence: source.discovery,
    releaseId: input.release_id,
    mediumPosition: input.medium_position,
    processorVersion: PROCESSOR_VERSION,
    processorHash: PROCESSOR_HASH,
    templateHash: input.source_kind === 'cover' ? templateHash : null,
    guideHash,
    prompt,
    promptHash: await sha256(prompt),
    settings,
    material: input.material ?? null,
  };
  const id = await sha256(
      JSON.stringify(stable({ userId, albumId: input.album_id, ...provenance }))
    ),
    sourceKey = `sources/${userId}/${sourceHash}`;
  await env.ARTWORK.put(sourceKey, bytes, {
    httpMetadata: { contentType: mime },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const cached = await getJob(env, id, userId);
  if (cached) return { job: cached, reused: true };
  const timestamp = now(),
    state = prepared
      ? 'needs_registration'
      : input.source_kind === 'retail' && !input.material && !automatic
        ? 'needs_material_review'
        : 'queued';
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,updated_at,created_at,automatic,expected_active_job) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      id,
      userId,
      input.album_id,
      state,
      JSON.stringify(input),
      sourceHash,
      sourceKey,
      mime,
      JSON.stringify(provenance),
      timestamp,
      timestamp,
      Number(!!automatic),
      automatic?.expectedActiveJob ?? null
    ),
    env.DB.prepare(
      "INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,album_id) DO UPDATE SET release_id=CASE WHEN excluded.release_id<>'' THEN excluded.release_id ELSE cd_artwork_albums.release_id END,medium_position=CASE WHEN excluded.release_id<>'' THEN excluded.medium_position ELSE cd_artwork_albums.medium_position END,next_check=excluded.next_check,discovery_outcome=excluded.discovery_outcome,discovery_evidence=excluded.discovery_evidence WHERE cd_artwork_albums.active_job IS NULL AND cd_artwork_albums.pinned=0"
    ).bind(
      userId,
      input.album_id,
      input.release_id ?? '',
      input.medium_position ?? 1,
      new Date(Date.now() + (automatic ? 7 : 30) * 86400000).toISOString(),
      source.discovery.outcome,
      JSON.stringify(source.discovery)
    ),
  ]);
  const job = await getJob(env, id, userId);
  if (!job) {
    if (automatic) {
      const pending = await getPendingAutomatic(env, request.album_id, userId);
      if (pending) return { job: pending, reused: true, blocked: true };
    }
    throw new ArtworkError('job_storage_failed', 503);
  }
  return { job, reused: false };
}
export async function dispatch(env: ArtworkEnv, job: Job, recover = false) {
  if (
    job.state !== 'queued' &&
    !(
      recover &&
      job.automatic &&
      [
        'submitted',
        'provider_unknown',
        'needs_registration',
        'pending',
      ].includes(job.state)
    )
  )
    return;
  try {
    await env.CD_WORKFLOW.create({
      id: job.id,
      params: { jobId: job.id, userId: job.user_id },
    });
  } catch {
    // An identical Workflow id is already dispatched, or deployment briefly
    // unavailable. Confirm it exists; cron can recover undispatched queued rows.
    try {
      const instance = await env.CD_WORKFLOW.get(job.id);
      const status = await instance.status();
      if (status.status === 'complete' || status.status === 'errored')
        await instance.restart();
    } catch {
      throw new ArtworkError('workflow_dispatch_unavailable', 503);
    }
  }
}
export async function claimGenerationSubmission(
  env: ArtworkEnv,
  job: Job
): Promise<{ token: string; attempt: number } | null> {
  const token = crypto.randomUUID();
  const stamp = new Date(Date.now()).toISOString();
  const day = stamp.slice(0, 10);
  // D1 batches are transactional. The unique token makes the usage statement
  // depend on this attempt's successful claim, even for simultaneous retries.
  // Usage is accounting only: there is no daily generation allowance.
  // Sync cannot introduce a conflict between identity validation and reservation.
  const [claimed, usage] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='submitted',submitted_at=?,updated_at=?,submission_claim=?,provenance=json_set(provenance,'$.providerAttempts',COALESCE(json_extract(provenance,'$.providerAttempts'),0)+1) WHERE id=? AND user_id=? AND state='queued' AND COALESCE(json_extract(provenance,'$.providerAttempts'),0)<3 AND COALESCE(json_extract(provenance,'$.providerFailure.retry_at'),'')<=? AND EXISTS(SELECT 1 FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id WHERE a.id=cd_artwork_jobs.album_id AND a.user_id=cd_artwork_jobs.user_id AND a.identity_conflict=0 AND r.identity_conflict=0 AND (automatic=0 OR (a.is_filtered=0 AND r.is_filtered=0 AND a.name=json_extract(provenance,'$.catalogIdentity.name') AND r.name=json_extract(provenance,'$.catalogIdentity.artist') AND a.mbid IS json_extract(provenance,'$.catalogIdentity.mbid') AND r.mbid IS json_extract(provenance,'$.catalogIdentity.artist_mbid') AND a.apple_music_id IS json_extract(provenance,'$.catalogIdentity.apple_music_id') AND EXISTS(SELECT 1 FROM cd_artwork_albums c WHERE c.user_id=cd_artwork_jobs.user_id AND c.album_id=cd_artwork_jobs.album_id AND c.pinned=0 AND c.review_hold=0 AND c.active_job IS cd_artwork_jobs.expected_active_job AND NOT EXISTS(SELECT 1 FROM cd_artwork_jobs prior WHERE prior.id=c.active_job AND prior.user_id=c.user_id AND prior.album_id=c.album_id AND prior.state='accepted' AND json_extract(prior.input,'$.source_kind')='retail')) AND (SELECT automatic_enabled FROM cd_artwork_control WHERE id=1)=1))) RETURNING id,provenance"
    ).bind(stamp, stamp, token, job.id, job.user_id, stamp),
    env.DB.prepare(
      "UPDATE cd_artwork_control SET budget_day=?,submitted_count=CASE WHEN budget_day=? THEN submitted_count+1 ELSE 1 END WHERE id=1 AND enabled=1 AND EXISTS(SELECT 1 FROM cd_artwork_jobs WHERE id=? AND user_id=? AND state='submitted' AND submission_claim=?) RETURNING id"
    ).bind(day, day, job.id, job.user_id, token),
  ]);
  if (!claimed.results.length) return null;
  if (!usage.results.length) {
    await env.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='queued',submitted_at=NULL,submission_claim=NULL,provenance=json_set(provenance,'$.providerAttempts',MAX(0,COALESCE(json_extract(provenance,'$.providerAttempts'),1)-1)),updated_at=? WHERE id=? AND user_id=? AND state='submitted' AND submission_claim=?"
    )
      .bind(now(), job.id, job.user_id, token)
      .run();
    return null;
  }
  const claimedRow = claimed.results[0] as { provenance: string };
  return { token, attempt: JSON.parse(claimedRow.provenance).providerAttempts };
}
export async function claimSubmission(env: ArtworkEnv, job: Job) {
  return !!(await claimGenerationSubmission(env, job));
}
export function publicJob(job: Job) {
  const provenance = JSON.parse(job.provenance) as Record<string, unknown>;
  return {
    id: job.id,
    album_id: job.album_id,
    state: job.state,
    source_kind: JSON.parse(job.input).source_kind,
    source_hash: job.source_hash,
    candidate_hash: job.candidate_hash,
    error_code: job.error_code,
    provider_error: provenance.providerFailure ?? null,
    submitted_at: job.submitted_at,
    updated_at: job.updated_at,
    model:
      (provenance.settings as { model?: string } | undefined)?.model ?? null,
    usage: provenance.usage ?? null,
    calculated_usd: provenance.calculatedUsd ?? null,
    verification: provenance.verification ?? null,
  };
}
export async function approvedArtwork(
  env: ArtworkEnv,
  albumIds: number[],
  userId: number
) {
  return (await artworkSnapshot(env, albumIds, userId)).data;
}
export async function artworkSnapshot(
  env: ArtworkEnv,
  albumIds: number[],
  userId: number
) {
  if (!albumIds.length) return { data: [], withdrawals: [] };
  const rows = await env.DB.prepare(
    `SELECT j.*,a.album_id AS snapshot_album_id,a.visibility_revision,a.hidden_job FROM cd_artwork_albums a JOIN lastfm_albums l ON l.id=a.album_id AND l.user_id=a.user_id LEFT JOIN cd_artwork_jobs j ON j.id=a.active_job AND j.user_id=a.user_id AND j.album_id=a.album_id AND j.state='accepted' WHERE a.user_id=? AND a.album_id IN (${albumIds.map(() => '?').join(',')})`
  )
    .bind(userId, ...albumIds)
    .all<
      Job & {
        snapshot_album_id: number;
        visibility_revision: number;
        hidden_job: string | null;
      }
    >();
  const withdrawals = rows.results
    .filter((row) => row.hidden_job && !row.id)
    .map((row) => ({
      album_id: row.snapshot_album_id,
      revision: row.visibility_revision,
    }));
  const data = rows.results
    .filter((row) => row.id)
    .map((j) => {
      const i = JSON.parse(j.input) as {
        source_kind: JobInput['source_kind'];
        release_id: string | null;
        medium_position: number | null;
      };
      return {
        album_id: j.album_id,
        revision: j.visibility_revision,
        asset_id: j.id,
        sha256: j.candidate_hash,
        image_url: `https://api.rewind.rest/v1/listening/cd-artwork/assets/${j.candidate_hash}.png`,
        source_kind: i.source_kind,
        identity_type:
          JSON.parse(j.provenance).identityType ?? 'representative_release',
        release_id: i.release_id,
        medium_position: i.medium_position,
        source: JSON.parse(j.provenance).sourceUrl,
        geometry: {
          canvas: 1024,
          center: 512,
          outer_radius: 480,
          hole_radius: 60,
        },
        alpha: 'material',
        ...(JSON.parse(j.provenance).metadata ?? {
          thumbhash: null,
          dominant_color: null,
          accent_color: null,
        }),
        review: 'accepted',
      };
    });
  return { data, withdrawals };
}

/** A material change is an immutable new revision, with reusable paid raw bytes. */
export async function materialRevision(
  env: ArtworkEnv,
  job: Job,
  material: NonNullable<JobInput['material']>
) {
  const input = { ...JSON.parse(job.input), material } as JobInput;
  const { refresh_source: _refresh, ...identityInput } = input;
  const provenance = {
    ...JSON.parse(job.provenance),
    requestKey: await sha256(
      JSON.stringify(stable({ input: identityInput, prepared: false }))
    ),
    processorHash: PROCESSOR_HASH,
    material,
    reusedRawFrom: job.raw_key ? job.id : null,
    calculatedUsd: job.raw_key ? 0 : null,
  };
  delete provenance.verification;
  const id = await sha256(
    JSON.stringify(
      stable({ userId: job.user_id, albumId: job.album_id, ...provenance })
    )
  );
  const existing = await getJob(env, id, job.user_id);
  if (existing) return existing;
  await env.DB.prepare(
    'INSERT OR IGNORE INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,raw_key,provenance,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  )
    .bind(
      id,
      job.user_id,
      job.album_id,
      job.raw_key ? 'needs_registration' : 'queued',
      JSON.stringify(input),
      job.source_hash,
      job.source_key,
      job.source_mime,
      job.raw_key,
      JSON.stringify(provenance),
      now(),
      now()
    )
    .run();
  const revision = await getJob(env, id, job.user_id);
  if (!revision) throw new ArtworkError('revision_storage_failed', 503);
  return revision;
}
