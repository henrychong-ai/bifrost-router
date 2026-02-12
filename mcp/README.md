# @bifrost/mcp

MCP (Model Context Protocol) server for bifrost. Provides AI-powered route management through Claude Code, Claude Desktop, and other MCP-compatible clients.

## Features

- **11 Tools** for complete route and analytics management
- **Multi-domain support** for managing multiple domains through a single interface
- **Stdio transport** for seamless Claude Code/Desktop integration
- **Type-safe** with Zod validation for all inputs

## Installation

```bash
# From the monorepo root
pnpm install
pnpm -C mcp build
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `EDGE_ROUTER_API_KEY` | Admin API key for authentication |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_ROUTER_URL` | `https://henrychong.com` | Base URL of the edge router |
| `EDGE_ROUTER_DOMAIN` | - | Default domain for operations |

## Claude Code Integration

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "node",
      "args": ["/path/to/bifrost/mcp/dist/index.js"],
      "env": {
        "EDGE_ROUTER_API_KEY": "your-api-key",
        "EDGE_ROUTER_URL": "https://henrychong.com",
        "EDGE_ROUTER_DOMAIN": "link.henrychong.com"
      }
    }
  }
}
```

### With 1Password Secrets

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "op",
      "args": [
        "run",
        "--account", "my.1password.com",
        "--",
        "node",
        "/path/to/bifrost/mcp/dist/index.js"
      ],
      "env": {
        "EDGE_ROUTER_API_KEY": "op://Technology/Cloudflare - HC/API Tokens/ADMIN_API_KEY",
        "EDGE_ROUTER_URL": "https://henrychong.com",
        "EDGE_ROUTER_DOMAIN": "link.henrychong.com"
      }
    }
  }
}
```

## Claude Desktop Integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/bifrost/mcp/dist/index.js"],
      "env": {
        "EDGE_ROUTER_API_KEY": "your-api-key",
        "EDGE_ROUTER_URL": "https://henrychong.com",
        "EDGE_ROUTER_DOMAIN": "link.henrychong.com"
      }
    }
  }
}
```

**Note:** Claude Desktop requires full executable paths (e.g., `/usr/local/bin/node` instead of `node`).

## Available Tools

### Route Management (7 tools)

| Tool | Description |
|------|-------------|
| `list_routes` | List all routes for a domain |
| `get_route` | Get details for a specific route |
| `create_route` | Create a new route (redirect, proxy, or r2) |
| `update_route` | Update an existing route |
| `delete_route` | Delete a route permanently |
| `toggle_route` | Enable or disable a route |
| `migrate_route` | Migrate a route to a new path |

### Analytics (4 tools)

| Tool | Description |
|------|-------------|
| `get_analytics_summary` | Get overview with totals and top items |
| `get_clicks` | Get paginated list of link clicks |
| `get_views` | Get paginated list of page views |
| `get_slug_stats` | Get detailed stats for a specific slug |

## Usage Examples

### List Routes

```
"List all routes for link.henrychong.com"
```

### Create a Redirect

```
"Create a redirect from /twitter to https://twitter.com/henrychong"
```

### View Analytics

```
"Show me the analytics summary for the last 7 days"
```

### Check Link Performance

```
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
│   ├── index.ts           # MCP server entry point
│   └── tools/
│       ├── routes.ts      # Route management handlers
│       ├── routes.test.ts # Route handler tests
│       ├── analytics.ts   # Analytics handlers
│       └── analytics.test.ts # Analytics tests
├── package.json
├── tsconfig.json
└── README.md
```

## Supported Domains

The MCP server can manage routes for any domain configured in bifrost:

- `link.henrychong.com` - Short link service
- `henrychong.com` - Personal domain
- `vanessahung.net` - Personal domain
- Additional domains as configured

## Security

- API key is required for all operations
- Supports 1Password secret injection
- All inputs validated with Zod schemas
- Rate limiting handled by Cloudflare WAF

## Dependencies

- `@modelcontextprotocol/sdk` - MCP server implementation
- `@bifrost/shared` - Shared types, schemas, and client
- `zod` - Runtime validation

## License

Private - Internal use only
