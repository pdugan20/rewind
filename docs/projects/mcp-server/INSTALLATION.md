# MCP Server Installation Guide

## Prerequisites

- A Rewind API key (`rw_live_...`) -- generate one via the admin endpoint or ask the project owner
- Node.js 18+ (for local/stdio mode)

## Claude Desktop (Mac App)

Claude Desktop supports MCP servers via a JSON config file. The server runs as a local process that Claude launches and communicates with over stdin/stdout.

### Setup

1. Open the config file:

   ```bash
   # Create if it doesn't exist
   mkdir -p ~/Library/Application\ Support/Claude
   nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

2. Add the Rewind server:

   ```json
   {
     "mcpServers": {
       "rewind": {
         "command": "npx",
         "args": ["-y", "rewind-mcp-server"],
         "env": {
           "REWIND_API_KEY": "rw_live_your_key_here",
           "REWIND_API_URL": "https://api.rewind.rest"
         }
       }
     }
   }
   ```

3. **Fully quit** Claude Desktop (Cmd+Q, not just close the window) and relaunch it.

4. Verify: Open Settings > Developer. You should see "rewind" listed with its tools.

### Troubleshooting

- **Server not appearing:** Check that `npx` is in your PATH. Try running `npx -y rewind-mcp-server` in a terminal to verify it works.
- **Tools not loading:** Check the Claude Desktop logs at `~/Library/Logs/Claude/` for MCP-related errors.
- **Config changes not taking effect:** You must fully quit and relaunch -- closing the window is not enough.

## Claude Code (CLI / IDE Extensions)

### Option A: Project-Level Config

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "rewind": {
      "command": "npx",
      "args": ["-y", "rewind-mcp-server"],
      "env": {
        "REWIND_API_KEY": "rw_live_your_key_here",
        "REWIND_API_URL": "https://api.rewind.rest"
      }
    }
  }
}
```

Claude Code detects `.mcp.json` changes automatically.

### Option B: CLI Registration

```bash
claude mcp add rewind -- npx -y rewind-mcp-server
```

Set env vars separately or pass them inline.

## Claude iOS App

The iOS app cannot launch local processes. It connects to a **remote MCP server** hosted at `mcp.rewind.rest`.

### Setup

1. Open Claude on iOS
2. Go to Settings (or configure via claude.ai on web -- settings sync across devices)
3. Navigate to Integrations
4. Add a new integration:
   - **URL:** `https://mcp.rewind.rest/mcp`
   - **Authorization:** `Bearer rw_live_your_key_here`

The integration syncs automatically between iOS and web.

## Claude.ai (Web App)

Same as iOS -- claude.ai supports remote MCP servers via the Integrations settings page.

### Setup

1. Go to [claude.ai](https://claude.ai)
2. Open Settings > Integrations
3. Add integration:
   - **URL:** `https://mcp.rewind.rest/mcp`
   - **Authorization:** `Bearer rw_live_your_key_here`

## How It Works

### Local Mode (Desktop / Code)

```
Claude <--stdio (JSON-RPC)--> rewind-mcp-server <--HTTPS--> api.rewind.rest
```

- Claude launches the server as a child process via `npx`
- Communication happens over stdin/stdout using JSON-RPC
- The server makes HTTP requests to the Rewind API using your API key
- No data is stored locally -- the server is stateless

### Remote Mode (iOS / Web)

```
Claude <--Streamable HTTP--> mcp.rewind.rest <--HTTPS--> api.rewind.rest
```

- Claude connects to the hosted MCP server via HTTP
- Authentication via Bearer token in the request headers
- The remote server forwards requests to the Rewind API
- Hosted on Cloudflare Workers at `mcp.rewind.rest`

## Security Notes

- Your API key is only used server-side to authenticate with `api.rewind.rest`
- In local mode, the key is stored in your local config file (not transmitted to Anthropic)
- In remote mode, the key is sent to `mcp.rewind.rest` which you control
- The MCP server has **read-only access** -- no admin tools are exposed by default
- All communication with `api.rewind.rest` is over HTTPS
