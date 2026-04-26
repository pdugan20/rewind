import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { googleTokens } from '../../db/schema/google.js';
import type { Env } from '../../types/env.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EXPIRY_BUFFER_SECONDS = 60;

// Required for the attending domain's Calendar + Gmail extractors. If the
// refresh response comes back missing either, we bail rather than silently
// running with a less-privileged token.
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/**
 * Get a valid Google access token. Refreshes if within the expiry buffer.
 * Persists the new access_token + expires_at; refresh_token does not
 * rotate on Google's side, so it stays untouched.
 */
export async function getGoogleAccessToken(
  db: Database,
  env: Env
): Promise<string> {
  const [stored] = await db
    .select()
    .from(googleTokens)
    .where(eq(googleTokens.userId, 1))
    .limit(1);

  if (!stored) {
    throw new Error(
      '[ERROR] No Google refresh token found. Run scripts/tools/setup-google.ts to seed google_tokens.'
    );
  }

  if (Date.now() / 1000 < stored.expiresAt - EXPIRY_BUFFER_SECONDS) {
    return stored.accessToken;
  }

  return refreshAccessToken(db, env, stored.refreshToken, stored.id);
}

/**
 * Refresh the access token using the refresh token. Verifies the response
 * carries the scopes we asked for; bails loudly if scope drift happened
 * (e.g. user revoked Gmail read access via Google account permissions UI).
 */
export async function refreshAccessToken(
  db: Database,
  env: Env,
  refreshToken: string,
  existingId: number
): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[ERROR] Google token refresh failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as TokenResponse;
  const grantedScopes = (data.scope ?? '').split(' ').filter(Boolean);
  const missing = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `[ERROR] Google token missing required scopes: ${missing.join(', ')}. Re-run setup-google.ts to re-consent.`
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in;

  await db
    .update(googleTokens)
    .set({
      accessToken: data.access_token,
      expiresAt,
      scopes: data.scope,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(googleTokens.id, existingId));

  console.log('[INFO] Google token refreshed successfully');
  return data.access_token;
}
