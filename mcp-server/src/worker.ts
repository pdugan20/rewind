/**
 * Cloudflare Worker entry point for remote MCP access (Claude iOS, claude.ai).
 * Deployed at mcp.rewind.rest.
 *
 * Uses @cloudflare/workers-oauth-provider for OAuth 2.1 with GitHub as the
 * upstream identity provider. The OAuth layer is only for the remote transport;
 * local stdio transport (Claude Desktop, Claude Code) uses REWIND_API_KEY directly.
 */

import {
  OAuthProvider,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { RewindClient } from './client.js';
import { createServer } from './server.js';
import { renderConsentPage } from './consent.js';
import { getGitHubAuthorizeUrl, exchangeGitHubCode } from './github-auth.js';

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  REWIND_API_URL: string;
  REWIND_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** JSON map of GitHub user ID -> Rewind user_id, e.g. {"12345": 1} */
  USER_ALLOWLIST: string;
}

/** Props stored with each OAuth grant (accessible via ctx.props in API handler) */
interface GrantProps {
  rewindUserId: number;
  rewindApiKey: string;
  gitHubLogin: string;
}

// Per-isolate rate limiting
const rateLimitWindows = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_RPM = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(key: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitWindows.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimitWindows.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, remaining: RATE_LIMIT_RPM - 1 };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_RPM) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: RATE_LIMIT_RPM - entry.count };
}

/**
 * MCP API handler -- receives authenticated requests after OAuth.
 * ctx.props contains the GrantProps set during authorization.
 */
const mcpHandler: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    // Rate limit by IP
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const rateResult = checkRateLimit(ip);
    if (!rateResult.allowed) {
      return Response.json(
        { error: 'Too Many Requests' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }

    // Get user props from OAuth context
    const props = (request as Request & { props?: GrantProps }).props;
    if (!props?.rewindApiKey) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiUrl = env.REWIND_API_URL || 'https://api.rewind.rest';
    const client = new RewindClient(apiUrl, props.rewindApiKey);
    const server = createServer(client);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

/**
 * Default handler -- serves the authorize page and GitHub callback.
 * All non-API, non-OAuth-infrastructure requests go here.
 */
const defaultHandler: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'rewind-mcp-server' });
    }

    // Authorization page -- user sees consent screen, clicks "Sign in with GitHub"
    if (url.pathname === '/authorize') {
      // Parse the OAuth authorization request from the MCP client
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

      const clientName = url.searchParams.get('client_name') ?? 'Claude';
      const scopes = (url.searchParams.get('scope') ?? 'read').split(' ');

      // Store the parsed auth request in KV so /callback can complete authorization
      const oauthState = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `github_state:${oauthState}`,
        JSON.stringify({ oauthReqInfo }),
        { expirationTtl: 600 } // 10 minutes
      );

      const callbackUrl = `${url.origin}/callback`;
      const gitHubUrl = getGitHubAuthorizeUrl(
        env.GITHUB_CLIENT_ID,
        callbackUrl,
        oauthState
      );

      const html = renderConsentPage({
        clientName,
        scopes,
        gitHubAuthorizeUrl: gitHubUrl,
      });

      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // GitHub OAuth callback -- user has authenticated with GitHub
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const githubState = url.searchParams.get('state');

      if (!code || !githubState) {
        return Response.json(
          { error: 'Missing code or state from GitHub' },
          { status: 400 }
        );
      }

      // Retrieve the stored OAuth request info
      const storedState = await env.OAUTH_KV.get(`github_state:${githubState}`);
      if (!storedState) {
        return Response.json(
          { error: 'Invalid or expired state. Please try connecting again.' },
          { status: 400 }
        );
      }
      // eslint-disable-next-line drizzle/enforce-delete-with-where -- KV.delete(), not Drizzle
      await env.OAUTH_KV.delete(`github_state:${githubState}`);

      const { oauthReqInfo } = JSON.parse(storedState);

      // Exchange GitHub code for user info
      let gitHubUser;
      try {
        gitHubUser = await exchangeGitHubCode(
          code,
          env.GITHUB_CLIENT_ID,
          env.GITHUB_CLIENT_SECRET
        );
      } catch (error) {
        return Response.json(
          {
            error: `GitHub authentication failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          { status: 400 }
        );
      }

      // Check if this GitHub user is in the allowlist
      const allowlist = JSON.parse(env.USER_ALLOWLIST || '{}') as Record<
        string,
        number
      >;
      const rewindUserId = allowlist[String(gitHubUser.id)];

      if (rewindUserId === undefined) {
        return Response.json(
          {
            error: `GitHub user @${gitHubUser.login} is not authorized. Contact the Rewind admin to request access.`,
          },
          { status: 403 }
        );
      }

      // Complete the OAuth grant and redirect back to the MCP client with the auth code
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: String(rewindUserId),
        metadata: { label: gitHubUser.login },
        scope: oauthReqInfo.scope,
        props: {
          rewindUserId,
          rewindApiKey: env.REWIND_API_KEY,
          gitHubLogin: gitHubUser.login,
        } as GrantProps,
      });

      return Response.redirect(redirectTo, 302);
    }

    return Response.json(
      { error: 'Not found', docs: 'https://docs.rewind.rest' },
      { status: 404 }
    );
  },
};

// OAuth Provider configuration
const provider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: mcpHandler as ExportedHandler<Env> &
    Pick<Required<ExportedHandler<Env>>, 'fetch'>,
  defaultHandler: defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 3600, // 1 hour
  refreshTokenTTL: 7_776_000, // 90 days
  scopesSupported: [
    'read',
    'read:listening',
    'read:running',
    'read:watching',
    'read:collecting',
    'read:reading',
    'read:feed',
  ],
  allowPlainPKCE: false, // S256 only per MCP spec
  resourceMetadata: {
    resource_name: 'Rewind Personal Data API',
  },
});

export default provider;
