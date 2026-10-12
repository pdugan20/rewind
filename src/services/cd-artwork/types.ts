export const MODEL = 'gpt-image-2.5-sunburst-2026-09-08';
export const PROCESSOR_VERSION = 'cd-production-v1';
export type SourceKind = 'retail' | 'cover';
export interface MaterialRegion {
  inner: number;
  outer: number;
  opacity: number;
  evidence: string;
}
export interface JobInput {
  album_id: number;
  refresh_source?: boolean;
  release_id: string | null;
  medium_position: number | null;
  source_kind: SourceKind;
  image_id?: string;
  cover_url?: string;
  material?: MaterialRegion;
  test_tag?: string;
}
export type JobRequest = Omit<JobInput, 'source_kind'> & {
  source_kind: SourceKind | 'auto';
};
export interface Job {
  id: string;
  user_id: number;
  album_id: number;
  state: string;
  input: string;
  source_hash: string;
  source_key: string;
  source_mime: string;
  raw_key: string | null;
  candidate_hash: string | null;
  candidate_key: string | null;
  provenance: string;
  error_code: string | null;
  submitted_at: string | null;
  automatic: number;
  expected_active_job: string | null;
  validation_state: string | null;
  updated_at: string;
  created_at: string;
}
export interface ArtworkEnv {
  DB: D1Database;
  ARTWORK: R2Bucket;
  IMAGES: R2Bucket;
  CD_DISCOVERY: Workflow<{ checkId: number }>;
  CD_WORKFLOW: Workflow<{ jobId: string; userId: number }>;
  OPENAI_API_KEY?: string;
  ALLOWED_ORIGINS: string;
}
export const sha256 = async (bytes: Uint8Array | string) => {
  const data =
    typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)])
    );
  return value;
}
export const now = () => new Date().toISOString();
