import type { ArtworkEnv } from './types.js';
import { now } from './types.js';
import { ArtworkError, resolveSource } from './sources.js';
import { ownedAlbum, enqueue, dispatch, getPendingAutomatic } from './store.js';
import { selectAutomaticSource } from './selection.js';

export interface DiscoveryCheck {
  id: number;
  user_id: number;
  album_id: number;
  release_id: string;
  medium_position: number;
}
const WEEK = 7 * 86400000;

/** Dispatch a bounded durable outbox; never search the album library. */
export async function dispatchListeningChecks(env: ArtworkEnv) {
  if (
    !(
      await env.DB.prepare(
        'SELECT enabled FROM cd_artwork_control WHERE id=1'
      ).first<{ enabled: number }>()
    )?.enabled
  )
    return;
  const rows = await env.DB.prepare(
    'SELECT id FROM cd_artwork_checks WHERE dispatched_at IS NULL AND completed_at IS NULL ORDER BY id LIMIT 20'
  ).all<{ id: number }>();
  for (const row of rows.results) {
    const id = `cd-discovery-${row.id}`;
    try {
      try {
        await env.CD_DISCOVERY.create({ id, params: { checkId: row.id } });
      } catch {
        // Stable IDs close the create-response-lost window and overlapping drains.
        const existing = await env.CD_DISCOVERY.get(id);
        await existing.status(); // get alone does not prove existence.
      }
      await env.DB.prepare(
        'UPDATE cd_artwork_checks SET dispatched_at=? WHERE id=? AND dispatched_at IS NULL'
      )
        .bind(now(), row.id)
        .run();
    } catch {
      console.log('[ERROR] CD artwork discovery dispatch unavailable');
      // The next sync/recovery can dispatch the already admitted event.
      break;
    }
  }
}

/** Typed failures let the Workflow honor provider Retry-After. */
export async function checkListeningArtwork(env: ArtworkEnv, checkId: number) {
  const row = await env.DB.prepare(
    'SELECT * FROM cd_artwork_checks WHERE id=? AND completed_at IS NULL'
  )
    .bind(checkId)
    .first<DiscoveryCheck>();
  if (!row) return { outcome: 'cancelled', retryAfter: 0 };
  const eligible = await env.DB.prepare(
    "SELECT c.album_id FROM cd_artwork_albums c JOIN lastfm_albums a ON a.id=c.album_id AND a.user_id=c.user_id JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id WHERE c.user_id=? AND c.album_id=? AND c.release_id=? AND c.medium_position=? AND c.pinned=0 AND c.review_hold=0 AND a.is_filtered=0 AND r.is_filtered=0 AND (SELECT enabled FROM cd_artwork_control WHERE id=1)=1 AND NOT (COALESCE(j.state,'')='accepted' AND COALESCE(json_extract(j.input,'$.source_kind'),'')='retail')"
  )
    .bind(row.user_id, row.album_id, row.release_id, row.medium_position)
    .first();
  if (!eligible) {
    await finishCheck(env, row, 'cancelled');
    return { outcome: 'cancelled', retryAfter: 0 };
  }
  let outcome: string,
    evidence: unknown,
    retryAfter = 0;
  try {
    const album = await ownedAlbum(env, row.album_id, row.user_id);
    const control = await env.DB.prepare(
      'SELECT automatic_enabled FROM cd_artwork_control WHERE id=1'
    ).first<{ automatic_enabled: number }>();
    if (
      control?.automatic_enabled &&
      row.user_id === 1 &&
      (await getPendingAutomatic(env, row.album_id, row.user_id))
    ) {
      outcome = 'generation_pending';
      evidence = { outcome };
      retryAfter = 3600;
    } else if (control?.automatic_enabled && row.user_id === 1) {
      const active = await env.DB.prepare(
        "SELECT c.active_job,j.state,json_extract(j.input,'$.source_kind') AS source_kind FROM cd_artwork_albums c LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id WHERE c.user_id=? AND c.album_id=?"
      )
        .bind(row.user_id, row.album_id)
        .first<{
          active_job: string | null;
          state: string | null;
          source_kind: string | null;
        }>();
      const selected = await selectAutomaticSource(
        env,
        row.album_id,
        row.user_id,
        album,
        row.release_id,
        row.medium_position,
        false,
        active?.source_kind === 'cover'
      );
      if (active?.state === 'accepted' && selected.sourceKind === 'cover') {
        outcome = 'cover_reused';
      } else {
        const result = await enqueue(
          env,
          selected.request,
          row.user_id,
          false,
          {
            source: selected,
            expectedActiveJob: active?.active_job ?? null,
            catalogIdentity: album,
          }
        );
        await dispatch(env, result.job);
        outcome =
          'blocked' in result && result.blocked
            ? 'generation_pending'
            : 'generation_queued';
        if (outcome === 'generation_pending') retryAfter = 3600;
      }
      evidence = selected.discovery;
      retryAfter = Math.max(retryAfter, selected.retailRetryAfter ?? 0);
    } else {
      const result = await resolveSource(
        env,
        {
          album_id: row.album_id,
          release_id: row.release_id,
          medium_position: row.medium_position,
          source_kind: 'cover',
        },
        album,
        true
      );
      outcome = result.discovery.outcome;
      evidence = result.discovery;
    }
  } catch (error) {
    outcome =
      error instanceof ArtworkError && error.code === 'catalog_identity_changed'
        ? 'catalog_changed'
        : error instanceof ArtworkError &&
            [
              'edition_identity_mismatch',
              'catalog_identity_unresolved',
              'cover_identity_unverified',
              'cover_identity_ambiguous',
              'cover_track_mismatch',
            ].includes(error.code)
          ? 'identity_required'
          : error instanceof ArtworkError && error.status === 422
            ? 'source_unavailable'
            : 'error';
    evidence = {
      outcome,
      code: error instanceof ArtworkError ? error.code : 'provider_unavailable',
    };
    if (outcome === 'catalog_changed') retryAfter = 60;
    if (outcome === 'error')
      retryAfter = error instanceof ArtworkError ? error.retryAfter : 3600;
  }
  // Record completion of this admitted check. Selection can bind a previously
  // unknown release; active artwork is changed only by conditional publication.
  await env.DB.prepare(
    'UPDATE cd_artwork_albums SET discovery_outcome=?,discovery_evidence=?,last_checked_at=?,next_check=? WHERE user_id=? AND album_id=? AND EXISTS(SELECT 1 FROM cd_artwork_checks WHERE id=? AND completed_at IS NULL)'
  )
    .bind(
      outcome,
      JSON.stringify(evidence),
      now(),
      new Date(Date.now() + Math.max(WEEK, retryAfter * 1000)).toISOString(),
      row.user_id,
      row.album_id,
      row.id
    )
    .run();
  if (!retryAfter) await finishCheck(env, row, outcome);
  return { outcome, retryAfter };
}
export async function finishCheck(
  env: ArtworkEnv,
  row: Pick<DiscoveryCheck, 'id' | 'user_id' | 'album_id'>,
  outcome: string
) {
  if (outcome === 'error') {
    const cooldown = new Date(Date.now() + WEEK).toISOString();
    await env.DB.prepare(
      'UPDATE cd_artwork_albums SET next_check=CASE WHEN last_checked_at IS NULL THEN ? ELSE MAX(next_check,?) END,last_checked_at=? WHERE user_id=? AND album_id=? AND release_id=(SELECT release_id FROM cd_artwork_checks WHERE id=?) AND medium_position=(SELECT medium_position FROM cd_artwork_checks WHERE id=?)'
    )
      .bind(
        cooldown,
        cooldown,
        now(),
        row.user_id,
        row.album_id,
        row.id,
        row.id
      )
      .run();
  }
  await env.DB.prepare(
    'UPDATE cd_artwork_checks SET completed_at=?,outcome=? WHERE id=? AND user_id=? AND album_id=? AND completed_at IS NULL'
  )
    .bind(now(), outcome, row.id, row.user_id, row.album_id)
    .run();
}

/** Only interrupted admitted work is inspected; this is not an album scan. */
export async function recoverListeningChecks(env: ArtworkEnv) {
  await dispatchListeningChecks(env);
  if (
    !(
      await env.DB.prepare(
        'SELECT enabled FROM cd_artwork_control WHERE id=1'
      ).first<{ enabled: number }>()
    )?.enabled
  )
    return;

  const rows = await env.DB.prepare(
    'SELECT id,user_id,album_id,recoveries FROM cd_artwork_checks WHERE dispatched_at IS NOT NULL AND completed_at IS NULL ORDER BY id LIMIT 20'
  ).all<DiscoveryCheck & { recoveries: number }>();
  for (const row of rows.results) {
    try {
      let instance, status;
      try {
        instance = await env.CD_DISCOVERY.get(`cd-discovery-${row.id}`);
        status = await instance.status();
      } catch {
        // Missing/expired instance: create with the SAME ID. If status failed
        // transiently and an instance still exists, create safely rejects.
        await env.CD_DISCOVERY.create({
          id: `cd-discovery-${row.id}`,
          params: { checkId: row.id },
        });
        continue;
      }
      if (status.status === 'terminated') {
        await finishCheck(env, row, 'cancelled');
        continue;
      }
      if (status.status === 'complete') {
        await finishCheck(env, row, 'error');
        continue;
      }
      if (status.status !== 'errored') continue;
      if (row.recoveries >= 2) {
        await finishCheck(env, row, 'error');
        continue;
      }
      const claimed = await env.DB.prepare(
        'UPDATE cd_artwork_checks SET recoveries=recoveries+1 WHERE id=? AND recoveries=? AND completed_at IS NULL RETURNING id'
      )
        .bind(row.id, row.recoveries)
        .first();
      if (claimed) await instance.restart();
    } catch {
      console.log('[ERROR] CD artwork discovery recovery unavailable');
    }
  }
}
