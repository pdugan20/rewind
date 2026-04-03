/**
 * GitHub OAuth helpers for upstream authentication delegation.
 * The MCP server uses GitHub as the identity provider -- users authenticate
 * with GitHub, and we map their GitHub user ID to a Rewind user_id.
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

/**
 * Build the GitHub OAuth authorization URL.
 * Redirects the user to GitHub to authenticate.
 */
export function getGitHubAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange a GitHub authorization code for an access token,
 * then fetch the authenticated user's profile.
 */
export async function exchangeGitHubCode(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<GitHubUser> {
  // Exchange code for token
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    throw new Error(
      `GitHub OAuth error: ${tokenData.error_description ?? tokenData.error ?? 'no access token'}`
    );
  }

  // Fetch user profile
  const userRes = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rewind-mcp-server',
    },
  });

  if (!userRes.ok) {
    throw new Error(`GitHub user fetch failed: ${userRes.status}`);
  }

  return (await userRes.json()) as GitHubUser;
}
