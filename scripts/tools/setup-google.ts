/**
 * Google OAuth Setup
 *
 * One-time script to authenticate with a personal Google account and seed
 * the google_tokens table. Uses the OAuth Authorization Code flow with a
 * localhost loopback redirect (Desktop app credentials).
 *
 * Prerequisites:
 *   1. GCP project created with Calendar API + Gmail API enabled.
 *   2. OAuth consent screen configured AND PUBLISHED to "In production".
 *      (Leaving it in "Testing" expires refresh tokens after 7 days.)
 *      Personal-use apps under 100 users can publish without verification —
 *      Google will show an "unverified app" warning during consent.
 *   3. OAuth Client ID created with type "Desktop app".
 *   4. .dev.vars contains GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
 *   5. wrangler is authenticated (`npx wrangler login`).
 *
 * Usage:
 *   npx tsx scripts/tools/setup-google.ts          # local D1
 *   npx tsx scripts/tools/setup-google.ts --remote # remote D1
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { AddressInfo } from 'node:net';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const DB_NAME = 'rewind-db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvVars(): { clientId: string; clientSecret: string } {
  const devVarsPath = resolve(process.cwd(), '.dev.vars');
  const content = readFileSync(devVarsPath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }

  if (!vars.GOOGLE_CLIENT_ID || !vars.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .dev.vars'
    );
  }

  return {
    clientId: vars.GOOGLE_CLIENT_ID,
    clientSecret: vars.GOOGLE_CLIENT_SECRET,
  };
}

function d1Execute(sql: string, remote: boolean): string {
  const flag = remote ? '--remote' : '--local';
  const escaped = sql.replace(/'/g, "'\\''");
  return execSync(
    `npx wrangler d1 execute ${DB_NAME} ${flag} --command '${escaped}' --json`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch {
    // Fallthrough: user opens the URL by hand.
  }
}

// ---------------------------------------------------------------------------
// OAuth Authorization Code Flow with localhost loopback
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function captureAuthCode(): Promise<{
  code: string;
  redirectUri: string;
}> {
  return new Promise((resolveCode, rejectCode) => {
    let capturedRedirectUri = '';
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`
        );
        server.close();
        rejectCode(new Error(`Google authorization failed: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing code</h1></body></html>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authorization complete</h1><p>You can close this tab.</p></body></html>'
      );
      // Capture the redirect URI BEFORE close — server.address() returns
      // null after close().
      const redirectUri = capturedRedirectUri;
      server.close();
      resolveCode({ code, redirectUri });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      capturedRedirectUri = `http://127.0.0.1:${port}`;
      const params = new URLSearchParams({
        client_id: clientIdGlobal,
        redirect_uri: capturedRedirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
      });
      const consentUrl = `${AUTH_URL}?${params.toString()}`;
      console.log('');
      console.log('='.repeat(70));
      console.log('  Opening browser to Google consent screen...');
      console.log('  If it does not open automatically, visit:');
      console.log('  ' + consentUrl);
      console.log('='.repeat(70));
      console.log('');
      openBrowser(consentUrl);
    });
  });
}

async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to exchange code for token (${response.status}): ${text}`
    );
  }

  return response.json() as Promise<TokenResponse>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let clientIdGlobal = '';

async function main(): Promise<void> {
  const remote = process.argv.includes('--remote');
  const target = remote ? 'remote' : 'local';

  console.log(`[INFO] Google OAuth setup (target: ${target} D1)`);

  const { clientId, clientSecret } = loadEnvVars();
  clientIdGlobal = clientId;

  // Step 1: capture auth code via loopback redirect
  const { code, redirectUri } = await captureAuthCode();
  console.log('[INFO] Authorization code captured');

  // Step 2: exchange code for tokens
  const token = await exchangeCodeForToken(
    clientId,
    clientSecret,
    code,
    redirectUri
  );

  if (!token.refresh_token) {
    throw new Error(
      'No refresh_token returned. Add `prompt=consent` to the auth URL or revoke prior consent at https://myaccount.google.com/permissions and retry.'
    );
  }

  // Step 3: verify scopes
  const granted = token.scope.split(' ').filter(Boolean);
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    throw new Error(`Token missing required scopes: ${missing.join(', ')}`);
  }

  console.log('[SUCCESS] Google authorized');

  // Step 4: store tokens in D1
  const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
  const now = new Date().toISOString();

  // Upsert by user_id=1 — there should only ever be one row for the
  // single-user assumption. Delete-then-insert keeps the SQL simple.
  const sql = `DELETE FROM google_tokens WHERE user_id = 1;
INSERT INTO google_tokens (user_id, access_token, refresh_token, expires_at, scopes, created_at, updated_at)
VALUES (1, '${token.access_token}', '${token.refresh_token}', ${expiresAt}, '${token.scope}', '${now}', '${now}');`;

  console.log(`[INFO] Storing tokens in ${target} D1...`);
  d1Execute(sql, remote);

  console.log(`[SUCCESS] Google tokens stored in ${target} D1`);
  console.log(
    `[INFO] Access token expires at: ${new Date(expiresAt * 1000).toISOString()}`
  );
  console.log(`[INFO] Granted scopes: ${token.scope}`);
}

main().catch((err) => {
  console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
