import { z } from 'zod';
import type { ArtworkEnv, Job } from './types.js';
import { now } from './types.js';
import { ArtworkError } from './sources.js';
import { getJob } from './store.js';

export const feedbackSchema = z
  .object({
    status: z.enum(['good', 'needs_revision']),
    reason: z
      .enum([
        'lettering',
        'wrong_artwork',
        'crop_geometry',
        'material',
        'other',
      ])
      .nullable()
      .default(null),
    note: z.string().trim().max(1000).default(''),
  })
  .strict();
type Feedback = z.infer<typeof feedbackSchema>;

/** Recompute inside the same transaction as a human decision. */
export function refreshReviewHold(
  env: ArtworkEnv,
  userId: number,
  albumId: number
) {
  return env.DB.prepare(
    "UPDATE cd_artwork_albums SET review_hold=CASE WHEN hidden_job IS NOT NULL OR EXISTS(SELECT 1 FROM cd_artwork_jobs j WHERE j.user_id=cd_artwork_albums.user_id AND j.album_id=cd_artwork_albums.album_id AND j.feedback_status='needs_revision') THEN 1 ELSE 0 END WHERE user_id=? AND album_id=?"
  ).bind(userId, albumId);
}

export async function saveFeedback(
  env: ArtworkEnv,
  id: string,
  userId: number,
  feedback: Feedback,
  reviewer: string
) {
  const job = await getJob(env, id, userId);
  if (!job) throw new ArtworkError('job_not_found', 404);
  if (!job.candidate_key && !job.raw_key)
    throw new ArtworkError('image_not_generated', 409);
  const stamp = now();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE cd_artwork_jobs SET feedback_status=?,feedback_reason=?,feedback_note=?,feedback_updated_at=? WHERE id=? AND user_id=?'
    ).bind(feedback.status, feedback.reason, feedback.note, stamp, id, userId),
    env.DB.prepare(
      'INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at,details) VALUES(?,?,?,?,?,?,?)'
    ).bind(
      userId,
      job.album_id,
      id,
      'feedback',
      reviewer,
      stamp,
      JSON.stringify(feedback)
    ),
    refreshReviewHold(env, userId, job.album_id),
  ]);
}

/** A stale card must never hide a newer replacement. Public immutable URLs
 * remain valid; this removes only the selected artwork from album responses. */
export async function hideArtwork(
  env: ArtworkEnv,
  id: string,
  userId: number,
  reviewer: string
) {
  const job = await getJob(env, id, userId);
  if (!job) throw new ArtworkError('job_not_found', 404);
  const album = await env.DB.prepare(
    'SELECT pinned FROM cd_artwork_albums WHERE user_id=? AND album_id=?'
  )
    .bind(userId, job.album_id)
    .first<{ pinned: number }>();
  if (album?.pinned) throw new ArtworkError('pinned_artwork_preserved', 409);
  const [changed] = await env.DB.batch([
    env.DB.prepare(
      'UPDATE cd_artwork_albums SET active_job=NULL,hidden_job=?,review_hold=1 WHERE user_id=? AND album_id=? AND active_job=? AND pinned=0 RETURNING album_id'
    ).bind(id, userId, job.album_id, id),
    env.DB.prepare(
      "INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at) SELECT ?,?,?,'hidden-from-player',?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM cd_artwork_albums WHERE user_id=? AND album_id=? AND active_job IS NULL AND hidden_job=?)"
    ).bind(userId, job.album_id, id, reviewer, now(), userId, job.album_id, id),
  ]);
  if (!changed.results.length)
    throw new ArtworkError('active_artwork_changed', 409);
}

export const galleryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
  filter: z
    .enum(['all', 'published', 'needs_attention', 'held'])
    .default('all'),
  album_id: z.coerce.number().int().positive().optional(),
  job_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type GalleryQuery = z.infer<typeof galleryQuerySchema>;
type GalleryJob = Job & {
  album_name: string;
  artist_name: string;
  active_job: string | null;
  hidden_job: string | null;
  review_hold: number;
  pinned: number;
  feedback_status: string;
  feedback_reason: string | null;
  feedback_note: string;
  feedback_updated_at: string | null;
};
export function galleryItem(job: GalleryJob) {
  return {
    id: job.id,
    album_id: job.album_id,
    album: job.album_name,
    artist: job.artist_name,
    state: job.state,
    source_kind: JSON.parse(job.input).source_kind as string,
    created_at: job.created_at,
    active: job.active_job === job.id && job.state === 'accepted',
    hidden: job.hidden_job === job.id,
    review_hold: !!job.review_hold,
    pinned: !!job.pinned,
    active_job_id: job.active_job,
    has_source: !!job.source_key,
    has_candidate: !!job.candidate_key,
    has_raw: !!job.raw_key,
    error_code: job.error_code,
    feedback: {
      status: job.feedback_status,
      reason: job.feedback_reason,
      note: job.feedback_note,
      updated_at: job.feedback_updated_at,
    },
  };
}
export async function galleryList(
  env: ArtworkEnv,
  userId: number,
  query: GalleryQuery
) {
  let where =
    'j.user_id=? AND (j.raw_key IS NOT NULL OR j.candidate_key IS NOT NULL)';
  const params: (string | number)[] = [userId];
  if (query.filter === 'published')
    where += " AND j.state='accepted' AND c.active_job=j.id";
  if (query.filter === 'held')
    where += " AND j.state NOT IN ('accepted','rejected')";
  if (query.filter === 'needs_attention')
    where +=
      " AND (j.feedback_status='needs_revision' OR c.hidden_job=j.id OR j.state NOT IN ('accepted','rejected'))";
  if (query.album_id) {
    where += ' AND j.album_id=?';
    params.push(query.album_id);
  }
  if (query.job_id) {
    where += ' AND j.id=?';
    params.push(query.job_id);
  }
  const from =
    'FROM cd_artwork_jobs j JOIN lastfm_albums a ON a.id=j.album_id AND a.user_id=j.user_id JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id LEFT JOIN cd_artwork_albums c ON c.album_id=j.album_id AND c.user_id=j.user_id';
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${where}`).bind(
      ...params
    ),
    env.DB.prepare(
      `SELECT j.*,a.name AS album_name,r.name AS artist_name,c.active_job,c.hidden_job,c.review_hold,c.pinned ${from} WHERE ${where} ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?`
    ).bind(...params, query.limit, (query.page - 1) * query.limit),
  ]);
  const total = (count.results[0] as { total: number }).total;
  return {
    data: (rows.results as GalleryJob[]).map(galleryItem),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.ceil(total / query.limit),
    },
  };
}

export async function feedbackHistory(
  env: ArtworkEnv,
  id: string,
  userId: number
) {
  const job = await getJob(env, id, userId);
  if (!job) throw new ArtworkError('job_not_found', 404);
  const rows = await env.DB.prepare(
    'SELECT action,created_at,details FROM cd_artwork_events WHERE user_id=? AND job_id=? ORDER BY id DESC LIMIT 30'
  )
    .bind(userId, id)
    .all<{ action: string; created_at: string; details: string | null }>();
  return {
    data: rows.results.map((row) => ({
      action: row.action,
      created_at: row.created_at,
      feedback:
        row.action === 'feedback' && row.details
          ? feedbackSchema.parse(JSON.parse(row.details))
          : null,
    })),
  };
}
