# Obolos MCP Server

**Let AI agents discover and pay for APIs on the Obolos x402 marketplace.**

Every API on the Obolos marketplace becomes a tool your AI agent can call — with automatic USDC micropayments on Base.

## Quick Setup

### Claude Code

By default, `claude mcp add` registers the server for the **current project only**. To make Obolos available in **every Claude Code session** across all your projects, add `--scope user`:

**Global (all projects):**

```bash
claude mcp add obolos --scope user -e OBOLOS_PRIVATE_KEY=0xyour_private_key -- node /path/to/mcp-server/dist/index.js
```

**Per-project (current project only):**

```bash
claude mcp add obolos -e OBOLOS_PRIVATE_KEY=0xyour_private_key -- node /path/to/mcp-server/dist/index.js
```

**Browse-only (no payments):** omit the `-e OBOLOS_PRIVATE_KEY=...` flag to search and explore APIs without paying.

> **Scope reference:**
>
> | Scope | Flag | Stored in | Available |
> |-------|------|-----------|-----------|
> | Local | *(default)* | `~/.claude.json` (project entry) | Current project only |
> | Project | `--scope project` | `.mcp.json` at repo root | Anyone who clones the repo |
> | User | `--scope user` | `~/.claude.json` (global entry) | All projects on your machine |
>
> If the same server name exists at multiple scopes, local wins over project, project wins over user.

### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obolos": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "OBOLOS_PRIVATE_KEY": "0xyour_private_key"
      }
    }
  }
}
```

### Cursor / Windsurf / Other MCP Clients

Add to your MCP config:

```json
{
  "obolos": {
    "command": "node",
    "args": ["/path/to/mcp-server/dist/index.js"],
    "env": {
      "OBOLOS_PRIVATE_KEY": "0xyour_private_key"
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `search_apis` | Search the marketplace by query, category, or sort order |
| `list_categories` | Browse available API categories |
| `get_api_details` | Get full details, input fields, and pricing for an API |
| `call_api` | Execute an API with automatic x402 USDC payment |
| `get_balance` | Check your wallet's USDC balance on Base |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OBOLOS_PRIVATE_KEY` | For payments | Private key of a Base wallet with USDC |
| `OBOLOS_API_URL` | No | Marketplace URL (default: `https://obolos.tech`) |

## Example Usage

Once configured, your AI agent can:

```
"Search for token price APIs on Obolos"
→ search_apis(query: "token price")

"How much does the DeFi portfolio API cost?"
→ get_api_details(api_id: "ext-abc123")

"Get the current ETH price using Obolos"
→ call_api(api_id: "ext-abc123", method: "GET", query_params: {"symbol": "ETH"})

"What's my Obolos wallet balance?"
→ get_balance()
```

## How Payments Work

1. Agent calls `call_api` with an API id and parameters
2. MCP server sends request to Obolos proxy
3. Proxy returns HTTP 402 with payment requirements
4. Server signs an EIP-712 payment with your private key
5. Retries request with payment header
6. API response is returned to the agent

Payments are USDC micropayments on Base ($0.001–$0.10 per call). Only 1% platform fee — 99% goes directly to the API creator.

## Build from Source

```bash
cd mcp-server
npm install
npm run build
```

## License

MIT
