/**
 * Quick test script to explore the Instapaper API response format.
 * Exchanges credentials for a token, fetches one bookmark, and prints all fields.
 *
 * Usage: npx tsx scripts/tools/instapaper-test.ts
 */

import crypto from 'crypto';
import https from 'https';
import querystring from 'querystring';

const CONSUMER_KEY = process.env.INSTAPAPER_CONSUMER_KEY!;
const CONSUMER_SECRET = process.env.INSTAPAPER_CONSUMER_SECRET!;
const USERNAME = process.env.INSTAPAPER_USERNAME!;
const PASSWORD = process.env.INSTAPAPER_PASSWORD!;

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.log(
    'Set INSTAPAPER_CONSUMER_KEY and INSTAPAPER_CONSUMER_SECRET in .dev.vars or env'
  );
  process.exit(1);
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string = ''
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;

  return crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');
}

async function oauthRequest(
  method: string,
  url: string,
  body: Record<string, string>,
  token?: string,
  tokenSecret?: string
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: generateTimestamp(),
    oauth_version: '1.0',
  };

  if (token) {
    oauthParams.oauth_token = token;
  }

  const allParams = { ...oauthParams, ...body };
  const signature = generateSignature(
    method,
    url,
    allParams,
    CONSUMER_SECRET,
    tokenSecret || ''
  );
  oauthParams.oauth_signature = signature;

  const authHeader =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ');

  const postBody = querystring.stringify(body);

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        method,
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postBody);
    req.end();
  });
}

async function main() {
  console.log('[INFO] Exchanging credentials for access token...');

  const tokenResponse = await oauthRequest(
    'POST',
    'https://www.instapaper.com/api/1/oauth/access_token',
    {
      x_auth_username: USERNAME,
      x_auth_password: PASSWORD,
      x_auth_mode: 'client_auth',
    }
  );

  const tokenParams = querystring.parse(tokenResponse);
  const accessToken = tokenParams.oauth_token as string;
  const accessTokenSecret = tokenParams.oauth_token_secret as string;

  console.log('[INFO] Got access token');
  console.log(`  oauth_token=${accessToken}`);
  console.log(`  oauth_token_secret=${accessTokenSecret}`);

  console.log('\n[INFO] Fetching bookmarks (limit 3)...');

  const bookmarksResponse = await oauthRequest(
    'POST',
    'https://www.instapaper.com/api/1/bookmarks/list',
    { limit: '3' },
    accessToken,
    accessTokenSecret
  );

  const bookmarks = JSON.parse(bookmarksResponse);

  console.log('\n[INFO] Raw response (ALL fields):');
  console.log(JSON.stringify(bookmarks, null, 2));

  // Highlight just the bookmark objects
  for (const item of bookmarks) {
    if (item.type === 'bookmark') {
      console.log(`\n[INFO] Bookmark fields for "${item.title}":`);
      console.log('  Keys:', Object.keys(item).join(', '));
    }
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
