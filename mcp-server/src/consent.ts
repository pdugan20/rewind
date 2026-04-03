/**
 * Consent page HTML for the OAuth authorization flow.
 * Shows "Sign in with GitHub" and the requested scopes.
 */

export function renderConsentPage(options: {
  clientName: string;
  scopes: string[];
  gitHubAuthorizeUrl: string;
  error?: string;
}): string {
  const scopeList = options.scopes.length
    ? options.scopes
        .map((s) => `<li>${escapeHtml(formatScope(s))}</li>`)
        .join('')
    : '<li>Read access to all domains</li>';

  const errorHtml = options.error
    ? `<div class="error">${escapeHtml(options.error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect to Rewind</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
    }
    .logo {
      font-size: 24px;
      font-weight: 700;
      color: #6874e8;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #888;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .client-name {
      font-weight: 600;
      color: #e5e5e5;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    ul {
      list-style: none;
      margin-bottom: 24px;
    }
    li {
      padding: 8px 0;
      border-bottom: 1px solid #222;
      font-size: 14px;
      color: #ccc;
    }
    li:before {
      content: "\\2713";
      color: #6874e8;
      margin-right: 8px;
    }
    .github-btn {
      display: block;
      width: 100%;
      padding: 12px;
      background: #6874e8;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      text-align: center;
      transition: background 0.2s;
    }
    .github-btn:hover { background: #5563d6; }
    .footer {
      margin-top: 16px;
      font-size: 12px;
      color: #666;
      text-align: center;
    }
    .footer a { color: #6874e8; text-decoration: none; }
    .error {
      background: #2d1515;
      border: 1px solid #5c2020;
      color: #f87171;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Rewind</div>
    <p class="subtitle">
      <span class="client-name">${escapeHtml(options.clientName)}</span> wants to access your Rewind data
    </p>
    ${errorHtml}
    <h2>This will allow access to:</h2>
    <ul>${scopeList}</ul>
    <a href="${escapeHtml(options.gitHubAuthorizeUrl)}" class="github-btn">
      Sign in with GitHub
    </a>
    <p class="footer">
      <a href="https://rewind.rest/privacy">Privacy Policy</a>
    </p>
  </div>
</body>
</html>`;
}

function formatScope(scope: string): string {
  const labels: Record<string, string> = {
    read: 'Read access to all domains',
    'read:listening': 'Listening history and stats (Last.fm)',
    'read:running': 'Running activities and stats (Strava)',
    'read:watching': 'Watch history and stats (Plex, Letterboxd)',
    'read:collecting': 'Collection data (Discogs)',
    'read:reading': 'Reading data and highlights (Instapaper)',
    'read:feed': 'Cross-domain feed and search',
  };
  return labels[scope] ?? scope;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
