import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { traktTokens } from '../../db/schema/trakt.js';
import type { Env } from '../../types/env.js';

const TOKEN_URL = 'https://api.trakt.tv/oauth/token';
const EXPIRY_BUFFER_SECONDS = 300; // 5 minutes

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

/**
 * Get a valid Trakt access token. Refreshes if within 5 minutes of expiry.
 * Persists new tokens to D1 (Trakt may rotate refresh tokens).
 */
export async function getAccessToken(env: Env, db: Database): Promise<string> {
  const [stored] = await db
    .select()
    .from(traktTokens)
    .where(eq(traktTokens.userId, 1))
    .limit(1);

  if (stored && Date.now() / 1000 < stored.expiresAt - EXPIRY_BUFFER_SECONDS) {
    return stored.accessToken;
  }

  const refreshToken = stored?.refreshToken;
  if (!refreshToken) {
    throw new Error(
      '[ERROR] No refresh token available. Run scripts/setup-trakt.ts to seed trakt_tokens.'
    );
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
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Rewind/1.0 (personal data aggregator)',
    },
    body: JSON.stringify({
      client_id: env.TRAKT_CLIENT_ID,
      client_secret: env.TRAKT_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[ERROR] Trakt token refresh failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as TokenResponse;
  const expiresAt = data.created_at + data.expires_in;

  if (existingId) {
    await db
      .update(traktTokens)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(traktTokens.id, existingId));
  } else {
    await db.insert(traktTokens).values({
      userId: 1,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    });
  }

  console.log('[INFO] Trakt token refreshed successfully');
  return data.access_token;
}
