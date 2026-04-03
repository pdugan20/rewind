/**
 * HTTP client for the Rewind API (api.rewind.rest).
 * All logging goes to stderr -- stdout is reserved for MCP stdio transport.
 */

const log = (...args: unknown[]) => console.error('[rewind-mcp]', ...args);

export class RewindClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(`/v1${path}`, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    log(`GET ${url.pathname}${url.search}`);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new RewindApiError(res.status, res.statusText, body);
    }

    return res.json() as Promise<T>;
  }
}

export class RewindApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string
  ) {
    super(`Rewind API error: ${status} ${statusText}`);
    this.name = 'RewindApiError';
  }
}

/**
 * Create a RewindClient from environment variables.
 * Throws if required vars are missing.
 */
export function createClientFromEnv(): RewindClient {
  const apiKey = process.env.REWIND_API_KEY;
  const apiUrl = process.env.REWIND_API_URL ?? 'https://api.rewind.rest';

  if (!apiKey) {
    throw new Error(
      'REWIND_API_KEY environment variable is required. ' +
        'Set it to your Rewind API key (rw_live_... or rw_admin_...).'
    );
  }

  return new RewindClient(apiUrl, apiKey);
}
