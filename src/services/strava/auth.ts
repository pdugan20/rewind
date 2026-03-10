import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { stravaTokens } from '../../db/schema/strava.js';
import type { Env } from '../../types/env.js';

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const EXPIRY_BUFFER_SECONDS = 300; // 5 minutes

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

/**
 * Get a valid Strava access token. Refreshes if within 5 minutes of expiry.
 * Persists new tokens to D1 (Strava may rotate refresh tokens).
 */
export async function getAccessToken(env: Env, db: Database): Promise<string> {
  const [stored] = await db
    .select()
    .from(stravaTokens)
    .where(eq(stravaTokens.userId, 1))
    .limit(1);

  if (stored && Date.now() / 1000 < stored.expiresAt - EXPIRY_BUFFER_SECONDS) {
    return stored.accessToken;
  }

  const refreshToken = stored?.refreshToken;
  if (!refreshToken) {
    throw new Error('[ERROR] No refresh token available. Seed strava_tokens.');
  }

  return refreshAccessToken(env, db, refreshToken, stored?.id);
}

/**
 * Refresh the access token using the refresh token.
 */
export async function refreshAccessToken(
  env: Env,
  db: Database,
  refreshToken: string,
  existingId?: number
): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[ERROR] Strava token refresh failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as TokenResponse;

  if (existingId) {
    await db
      .update(stravaTokens)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(stravaTokens.id, existingId));
  } else {
    await db.insert(stravaTokens).values({
      userId: 1,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
    });
  }

  console.log('[INFO] Strava token refreshed successfully');
  return data.access_token;
}
