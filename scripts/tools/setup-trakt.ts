/**
 * Trakt OAuth Device Code Setup
 *
 * One-time script to authenticate with Trakt and seed the trakt_tokens table.
 * Uses the device code flow: displays a URL and code for the user to enter
 * in their browser, then polls until approved.
 *
 * Prerequisites:
 *   1. Register a Trakt API app at https://developer.trakt.tv/apps
 *   2. .dev.vars contains TRAKT_CLIENT_ID (TRAKT_CLIENT_SECRET is optional)
 *   3. Ensure wrangler is authenticated (`npx wrangler login`)
 *
 * Usage:
 *   npx tsx scripts/tools/setup-trakt.ts
 *
 * Options:
 *   --remote    Seed tokens into the remote D1 database (default: local)
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Trakt requires sign-in flows on auth.trakt.tv from February 1, 2027.
const TRAKT_AUTH_URL = 'https://auth.trakt.tv';
const DB_NAME = 'rewind-db';
// Trakt's Cloudflare firewall rejects requests without a User-Agent.
const USER_AGENT = 'Rewind/1.0 (personal data aggregator)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvVars(): { clientId: string; clientSecret?: string } {
  const devVarsPath = resolve(process.cwd(), '.dev.vars');
  const content = readFileSync(devVarsPath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }

  if (!vars.TRAKT_CLIENT_ID) {
    throw new Error('Missing TRAKT_CLIENT_ID in .dev.vars');
  }

  // Apps created after Trakt's October 2026 auth migration are not issued a
  // client secret; Trakt treats it as optional for token exchanges.
  return {
    clientId: vars.TRAKT_CLIENT_ID,
    clientSecret: vars.TRAKT_CLIENT_SECRET || undefined,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// OAuth Device Code Flow
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
  token_type: string;
}

async function requestDeviceCode(
  clientId: string
): Promise<DeviceCodeResponse> {
  const response = await fetch(`${TRAKT_AUTH_URL}/oauth/device/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ client_id: clientId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get device code (${response.status}): ${text}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(
  clientId: string,
  clientSecret: string | undefined,
  deviceCode: string,
  interval: number,
  expiresIn: number
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollSeconds = interval;

  while (Date.now() < deadline) {
    await sleep(pollSeconds * 1000);

    const response = await fetch(`${TRAKT_AUTH_URL}/oauth/device/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': clientId,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        code: deviceCode,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (response.status === 200) {
      return response.json() as Promise<TokenResponse>;
    }

    if (response.status === 400) {
      // Pending -- user hasn't approved yet
      process.stdout.write('.');
      continue;
    }

    if (response.status === 404) {
      throw new Error('Invalid device code');
    }

    if (response.status === 409) {
      throw new Error('Code already used');
    }

    if (response.status === 410) {
      throw new Error('Code expired');
    }

    if (response.status === 418) {
      throw new Error('User denied the request');
    }

    if (response.status === 429) {
      // Slow down: keep the longer interval for the rest of the session.
      pollSeconds += 5;
      continue;
    }

    const text = await response.text();
    throw new Error(`Unexpected response (${response.status}): ${text}`);
  }

  throw new Error('Device code expired before user approved');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const remote = process.argv.includes('--remote');
  const target = remote ? 'remote' : 'local';

  console.log(`[INFO] Trakt OAuth setup (target: ${target} D1)`);

  const { clientId, clientSecret } = loadEnvVars();

  // Step 1: Get device code
  console.log('[INFO] Requesting device code from Trakt...');
  const device = await requestDeviceCode(clientId);

  console.log('');
  console.log('='.repeat(50));
  console.log(`  Go to: ${device.verification_url}`);
  console.log(`  Enter code: ${device.user_code}`);
  console.log('='.repeat(50));
  console.log('');
  console.log(
    `[INFO] Waiting for approval (expires in ${device.expires_in}s)...`
  );

  // Step 2: Poll for token
  const token = await pollForToken(
    clientId,
    clientSecret,
    device.device_code,
    device.interval,
    device.expires_in
  );

  console.log('');
  console.log('[SUCCESS] Trakt authorized');

  // Step 3: Store tokens in D1
  const expiresAt = token.created_at + token.expires_in;
  const now = new Date().toISOString();

  // trakt_tokens has no unique key on user_id, so ON CONFLICT never fires.
  // Replace the user's row outright; the Worker reads the first row it finds.
  const sql = `DELETE FROM trakt_tokens WHERE user_id = 1;
INSERT INTO trakt_tokens (user_id, access_token, refresh_token, expires_at, created_at, updated_at)
VALUES (1, '${token.access_token}', '${token.refresh_token}', ${expiresAt}, '${now}', '${now}');`;

  console.log(`[INFO] Storing tokens in ${target} D1...`);
  d1Execute(sql, remote);

  console.log(`[SUCCESS] Trakt tokens stored in ${target} D1`);
  console.log(
    `[INFO] Access token expires at: ${new Date(expiresAt * 1000).toISOString()}`
  );
}

main().catch((err) => {
  console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
