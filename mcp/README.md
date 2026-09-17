# @bifrost/mcp

MCP (Model Context Protocol) server for bifrost. Provides AI-powered route, analytics, and R2 storage management through Claude Code, Claude Desktop, and other MCP-compatible clients.

## Features

- **29 tools** for route management, analytics, R2 storage, and QR codes
- **Multi-domain support** for managing multiple domains through a single interface
- **Stdio transport** with API-key auth for Claude Code/Desktop integration
- **Type-safe** with Zod validation for all inputs

## Install

> **Tip:** if you have this repo open in Claude Code, just ask it to **"install mcp"** — `CLAUDE.md` carries the instructions and it will configure both surfaces for you.

### Build

```bash
# From the monorepo root
pnpm install
pnpm -C shared build
pnpm -C mcp build
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_ROUTER_API_KEY` | — | Admin API key (required) |
| `EDGE_ROUTER_URL` | `https://example.com` | Base URL of your deployed edge router |

There is no default-domain variable. `EDGE_ROUTER_DOMAIN` was removed in
v1.35.0: every route, QR and slug-stats call names its own domain, and a stale
key in the environment logs one stderr warning at boot and is otherwise
ignored.

### Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "bifrost": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/bifrost-router/mcp/dist/index.js"],
      "env": {
        "EDGE_ROUTER_API_KEY": "your-api-key",
        "EDGE_ROUTER_URL": "https://bifrost.example.com"
      }
    }
  }
}
```

Verify with `claude mcp list` — expect `bifrost … ✔ Connected`.

#### With 1Password Secrets

Avoid a plaintext API key by injecting it via `op run`:

```json
{
  "mcpServers": {
    "bifrost": {
      "type": "stdio",
      "command": "op",
      "args": [
        "run",
        "--account", "your-1password-account",
        "--",
        "node",
        "/absolute/path/to/bifrost-router/mcp/dist/index.js"
      ],
      "env": {
        "EDGE_ROUTER_API_KEY": "op://Your-Vault/Cloudflare/ADMIN_API_KEY",
        "EDGE_ROUTER_URL": "https://bifrost.example.com"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/bifrost-router/mcp/dist/index.js"],
      "env": {
        "EDGE_ROUTER_API_KEY": "your-api-key",
        "EDGE_ROUTER_URL": "https://bifrost.example.com"
      }
    }
  }
}
```

**Notes:**
- Claude Desktop requires **full executable paths** (e.g. `/usr/local/bin/node` or `/opt/homebrew/bin/node` instead of `node`) — it does not inherit the shell PATH.
- Fully restart Claude Desktop (Cmd+Q on macOS) after editing — stdio servers load at app launch.
- Desktop's **Settings → Connectors** UI is for remote (HTTP/OAuth) MCP servers only and does not apply to this stdio server. `claude_desktop_config.json` is the stdio path.

## Available Tools (29)

**Domain (v1.35.0):** `domain` is REQUIRED and enumerated on every route tool,
every QR tool and `get_slug_stats` — there is no default and nothing fills a
missing one in. `transfer_route` requires both `from_domain` and `to_domain`.
Only `get_analytics_summary`, `get_clicks` and `get_views` take an optional
`domain`, where omitting it means all domains.

### Route Management (8 tools)

| Tool | Description |
|------|-------------|
| `list_routes` | List all routes for a domain |
| `get_route` | Get details for a specific route |
| `create_route` | Create a new route (redirect, proxy, or r2) |
| `update_route` | Update an existing route |
| `delete_route` | Delete a route permanently |
| `toggle_route` | Enable or disable a route |
| `migrate_route` | Migrate a route to a new path (preserves createdAt) |
| `transfer_route` | Transfer a route to a different domain |

**Credential-bearing targets (v1.36.0).** A route TARGET is stored in KV, copied
into the click analytics, written to the request log, and exercised by everyone
who opens the short link. `create_route`, `update_route`, `toggle_route` and
`transfer_route` are refused with `ROUTE_TARGET_CREDENTIAL` when the target's
query or fragment carries a credential-named parameter, and the error names the
parameters. Each of those four tools takes an optional
`acknowledgeCredentialTarget` to proceed anyway.

> ⚠️ **Ask the human before setting it.** The refusal exists so a person looks at
> the parameter. Surface the names, ask, and set the flag only on their answer —
> never on your own initiative. It is request-only and is never stored on the
> route.

`migrate_route` moves the slug within one domain and needs no acknowledgement; a
transfer does, because it re-publishes the same target to a different audience.

**`toggle_route` fails closed (v1.36.0).** `enabled` accepts a real boolean or
the usual string forms (`"true"`/`"1"`/`"yes"`, `"false"`/`"0"`/`"no"`), so
`"false"` DISABLES. Anything else — `"off"`, `"disabled"`, `"n"` — is answered
with an error and the route is left untouched.

### Analytics (4 tools)

| Tool | Description |
|------|-------------|
| `get_analytics_summary` | Get overview with totals and top items |
| `get_clicks` | Get paginated list of link clicks |
| `get_views` | Get paginated list of page views |
| `get_slug_stats` | Get detailed stats for a specific slug |

### R2 Storage (11 tools)

| Tool | Description |
|------|-------------|
| `list_buckets` | List available R2 buckets |
| `list_objects` | List objects in a bucket (prefix, cursor, limit) |
| `get_object` | Download an object |
| `get_object_meta` | Get object metadata |
| `upload_object` | Upload a file (optional route creation) |
| `rename_object` | Rename an object within a bucket |
| `move_object` | Move an object to a different bucket |
| `delete_object` | Delete an object |
| `update_object_metadata` | Update HTTP metadata on an object |
| `update_object_comment` | Set or clear the free-text comment on an object (null/'' clears) |
| `purge_cache` | Purge the CDN cache for an object globally |

### QR Codes (6 tools)

| Tool | Description |
|------|-------------|
| `list_qrs` | List QR codes for a domain (filter by type/tag/search, paginated) |
| `get_qr` | Get a QR code record (payload, design, linked route) |
| `create_qr` | Create a QR code (url/text/vcard/wifi; url may link a route for dynamic-QR semantics) |
| `update_qr` | Update description/tags/payload/design/route link (type is immutable) |
| `delete_qr` | Delete a QR code (hard delete; the audit log preserves the record) |
| `get_route_qr` | Render an ephemeral QR SVG for an existing route |


> Feedback-queue triage has no MCP tools — use the REST API or the dashboard Feedback page (see `CLAUDE.md`).

## Usage Examples

```
"List all routes for links.example.com"
"Create a redirect from /twitter to https://twitter.com/example"
"Upload this PDF to the files bucket and create a route for it"
"Show me the analytics summary for the last 7 days"
"Get detailed statistics for the /linkedin link"
```

## Development

```bash
# Build
pnpm -C mcp build

# Run tests
pnpm -C mcp test

# Type check
pnpm -C mcp typecheck

# Watch mode for tests
pnpm -C mcp test:watch
```

## Architecture

```
mcp/
├── src/
│   ├── index.ts           # MCP server entry point (stdio)
│   └── tools/
│       ├── routes.ts      # Route management handlers
│       ├── analytics.ts   # Analytics handlers
│       ├── storage.ts     # R2 storage handlers
│       └── *.test.ts      # Handler tests
├── package.json
├── tsconfig.json
└── README.md
```

## Supported Domains

The MCP server can manage routes for any domain configured in `shared/src/types.ts` `SUPPORTED_DOMAINS` — tool schemas are generated from that list, so rebuild `shared/` after changing it (`pnpm -C shared build`).

## Security

- API key is required for all operations
- Supports 1Password secret injection (`op run`) to keep the key out of config files
- The stdio server enforces the domain contract in its handlers (`requireDomain()` / `NO_DOMAIN_ERROR`) and advertises the JSON-Schema catalog to clients; the low-level SDK `Server` itself validates no arguments, so every other field is re-validated by the REST API
- Rate limiting handled by Cloudflare WAF

## Dependencies

- `@modelcontextprotocol/sdk` - MCP server implementation
- `@bifrost/shared` - Shared types, schemas, and client
- `zod` - Runtime validation

## License

MIT — see [LICENSE](../LICENSE)
