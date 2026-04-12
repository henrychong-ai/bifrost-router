# MCP Server & Slackbot Implementation Plan

## Overview

Build a complete AI-powered management system for cloudflare-edge-router consisting of:

1. **Phase I: MCP Server** - Local AI integration via Claude Code/Desktop
2. **Phase II: Slackbot Worker** - Slack-based management with permissions
3. **Phase III: AI-Powered Responses** - Claude-driven natural language processing

All phases share code, tool definitions, and infrastructure.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COMPLETE SYSTEM ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐     │
│  │  Claude Code/   │      │    Slack        │      │    Other AI     │     │
│  │  Desktop        │      │    Users        │      │    Clients      │     │
│  └────────┬────────┘      └────────┬────────┘      └────────┬────────┘     │
│           │                        │                        │               │
│           ▼                        ▼                        ▼               │
│  ┌─────────────────┐      ┌─────────────────────────────────────────┐      │
│  │  MCP Server     │      │         Slackbot Worker                 │      │
│  │  (stdio)        │      │   ┌─────────────────────────────────┐   │      │
│  │                 │      │   │  Permission Check (KV)          │   │      │
│  │  Phase I        │      │   │  Claude API (Phase III)         │   │      │
│  └────────┬────────┘      │   │  Conversation State (D1)        │   │      │
│           │               │   └─────────────────────────────────┘   │      │
│           │               │              Phase II + III             │      │
│           │               └──────────────────┬──────────────────────┘      │
│           │                                  │                              │
│           │         ┌────────────────────────┘                              │
│           │         │                                                       │
│           ▼         ▼                                                       │
│  ┌─────────────────────────────────────┐                                   │
│  │       Shared Code Package           │                                   │
│  │   - EdgeRouterClient                │                                   │
│  │   - Tool Definitions                │                                   │
│  │   - Zod Schemas                     │                                   │
│  └──────────────────┬──────────────────┘                                   │
│                     │                                                       │
│                     ▼ HTTPS                                                 │
│  ┌─────────────────────────────────────┐                                   │
│  │       Admin API                     │                                   │
│  │   (cloudflare-edge-router Worker)   │                                   │
│  │                                     │                                   │
│  │   Routes: KV ───────────────────────┼──► Per-Domain KV Namespaces       │
│  │   Analytics: D1 ────────────────────┼──► link_clicks, page_views        │
│  └─────────────────────────────────────┘                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Domain Filtering & Scoping

### Core Principle

**All tools support domain-scoped operations.** This enables:
1. Focused queries on specific domains
2. Permission enforcement per domain
3. Multi-tenant support via Slackbot

### Domain Parameter

Every tool accepts an optional `domain` parameter:

```typescript
// All tools follow this pattern
{
  name: "list_routes",
  inputSchema: {
    domain: z.string().optional().describe(
      "Target domain (e.g., 'links.example.com', 'example.com'). " +
      "Defaults to EDGE_ROUTER_DOMAIN env var if set."
    ),
    // ... other params
  }
}
```

### Supported Domains

| Domain | Description |
|--------|-------------|
| `links.example.com` | Short link service |
| `example.com` | Main domain (151 routes) |
| `secondary.example.net` | Personal domain (4 routes) |
| `user1.example.com` | David Chong domain |
| `user2.example.com` | Sonja Chong domain |
| `user3.example.com` | Anja Chong domain |
| `couple.example.com` | Kit Kat Couple domain |
| `user5.example.com` | Valerie Hung domain |

### Response Domain Labeling

All tool responses clearly indicate the target domain:

```json
{
  "content": [{
    "type": "text",
    "text": "Routes for links.example.com:\n\n1. /linkedin → redirect → https://linkedin.com/in/..."
  }]
}
```

---

## Phase I: MCP Server

### Purpose

Local MCP server for Claude Code and Claude Desktop integration. Enables natural language route management and analytics queries directly from the AI assistant.

### Transport

**stdio** - Standard input/output communication with Claude Code/Desktop.

### Tools (10 Total)

#### Route Management (6)

| Tool | Permission | Description |
|------|------------|-------------|
| `list_routes` | read | List all routes for a domain |
| `get_route` | read | Get single route details |
| `create_route` | edit | Create redirect/proxy/R2 route |
| `update_route` | edit | Modify existing route |
| `delete_route` | admin | Remove a route permanently |
| `toggle_route` | edit | Enable/disable a route |

#### Analytics (4)

| Tool | Permission | Description |
|------|------------|-------------|
| `get_analytics_summary` | read | Dashboard overview with totals and trends |
| `get_clicks` | read | Paginated click records |
| `get_views` | read | Paginated view records |
| `get_slug_stats` | read | Detailed stats for specific link |

### Tool Schemas

```typescript
// list_routes
{
  name: "list_routes",
  description: "List all routes configured for a domain. Returns route paths, types, targets, and status.",
  inputSchema: {
    domain: z.string().optional()
  }
}

// create_route
{
  name: "create_route",
  description: "Create a new redirect, proxy, or R2 route.",
  inputSchema: {
    path: z.string().describe("Route path starting with /"),
    type: z.enum(["redirect", "proxy", "r2"]),
    target: z.string().describe("Target URL or R2 key"),
    statusCode: z.number().optional().describe("301, 302, 307, or 308"),
    preserveQuery: z.boolean().optional().default(true),
    cacheControl: z.string().optional(),
    domain: z.string().optional()
  }
}

// get_analytics_summary
{
  name: "get_analytics_summary",
  description: "Get analytics overview including totals, top links, top pages, and trends.",
  inputSchema: {
    domain: z.string().optional(),
    days: z.number().min(1).max(365).optional().default(30)
  }
}

// get_slug_stats
{
  name: "get_slug_stats",
  description: "Get detailed statistics for a specific link/slug.",
  inputSchema: {
    slug: z.string().describe("Link slug (e.g., '/linkedin')"),
    domain: z.string().optional(),
    days: z.number().optional().default(30)
  }
}
```

### Project Structure

```
mcp/
├── package.json
├── tsconfig.json
├── PLAN.md
├── README.md
└── src/
    ├── index.ts              # MCP server entry point
    ├── client.ts             # EdgeRouterClient (→ shared/)
    ├── types.ts              # Types (→ shared/)
    ├── schemas.ts            # Zod schemas (→ shared/)
    └── tools/
        ├── index.ts
        ├── routes.ts         # Route management tools
        └── analytics.ts      # Analytics tools
```

### Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EDGE_ROUTER_API_KEY` | Yes | - | Admin API key |
| `EDGE_ROUTER_URL` | No | `https://example.com` | Base URL |
| `EDGE_ROUTER_DOMAIN` | No | - | Default domain |

### Installation

#### Claude Code
```bash
claude mcp add --scope user edge-router -- \
  node /Users/henrychong/repos/cloudflare-edge-router/mcp/dist/index.js
```

#### With 1Password
```bash
claude mcp add-json --scope user edge-router '{
  "type": "stdio",
  "command": "op",
  "args": ["run", "--account", "your-1password-account", "--", "node", "/Users/henrychong/repos/cloudflare-edge-router/mcp/dist/index.js"],
  "env": {
    "EDGE_ROUTER_API_KEY": "op://Your-Vault/Cloudflare/ADMIN_API_KEY"
  }
}'
```

### Phase I Checklist

- [ ] Create mcp/ directory structure
- [ ] Initialize package.json with @modelcontextprotocol/sdk
- [ ] Implement EdgeRouterClient HTTP client
- [ ] Implement all 6 route management tools
- [ ] Implement all 4 analytics tools
- [ ] Test with Claude Code
- [ ] Write README.md

---

## Phase II: Slackbot Worker

### Purpose

Cloudflare Worker that receives Slack events and enables route management via natural language in Slack channels and DMs.

### Why Cloudflare Worker (Not n8n)

| Consideration | Worker | n8n |
|---------------|--------|-----|
| **Latency** | Edge-deployed, <50ms | Server-based, variable |
| **Infrastructure** | Same as edge-router | Additional dependency |
| **KV Access** | Native bindings | External API calls |
| **Cost** | Free tier sufficient | Paid or self-hosted |
| **Authorization** | Full control | Limited |
| **Code Reuse** | Shared package | Webhook only |

**Decision: Cloudflare Worker** for consistency and performance.

### Slack App Configuration

#### Bot Token Scopes
- `app_mentions:read` - Receive @mentions in channels
- `chat:write` - Send messages
- `im:history` - Read DM history
- `im:read` - Access DM metadata
- `im:write` - Send DMs
- `users:read` - Get user information

#### Event Subscriptions
| Event | Trigger |
|-------|---------|
| `app_mention` | Bot @mentioned in channel |
| `message.im` | DM sent to bot |

#### Webhook Endpoints
```
POST /slack/events     - Slack Event API webhook
POST /slack/commands   - Slash commands (future)
```

### Request Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SLACKBOT REQUEST FLOW                            │
├────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. User sends: "@EdgeRouter how many clicks on /linkedin this week?"  │
│                          │                                              │
│                          ▼                                              │
│  2. Slack sends POST to /slack/events                                  │
│                          │                                              │
│                          ▼                                              │
│  3. ┌─────────────────────────────────────────┐                        │
│     │  Verify Slack Signature                 │                        │
│     │  (HMAC-SHA256 with signing secret)      │                        │
│     └─────────────────────────────────────────┘                        │
│                          │                                              │
│                          ▼                                              │
│  4. ┌─────────────────────────────────────────┐                        │
│     │  Extract user_id, check KV permissions  │                        │
│     │  Key: slack-permissions:{user_id}       │                        │
│     └─────────────────────────────────────────┘                        │
│                          │                                              │
│                          ▼                                              │
│  5. ┌─────────────────────────────────────────┐                        │
│     │  Phase III: Claude API with tools       │                        │
│     │  (see Phase III section)                │                        │
│     └─────────────────────────────────────────┘                        │
│                          │                                              │
│                          ▼                                              │
│  6. Post response to Slack thread                                      │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

### Permission System

#### Permission Schema (KV)

```typescript
interface SlackUserPermissions {
  user_id: string;           // Slack user ID (e.g., "U1234567890")
  user_name: string;         // Display name for logging
  permissions: {
    [domain: string]: PermissionLevel;
  };
  created_at: number;        // Unix timestamp
  updated_at: number;
}

type PermissionLevel = "none" | "read" | "edit" | "admin";
```

#### Permission Levels

| Level | Capabilities |
|-------|--------------|
| `none` | No access to domain |
| `read` | list_routes, get_route, all analytics |
| `edit` | read + create_route, update_route, toggle_route |
| `admin` | edit + delete_route |

#### Permission Hierarchy

```
admin > edit > read > none
```

An `admin` user automatically has `edit` and `read` permissions.

#### Example Permission Record

```json
{
  "user_id": "U1234567890",
  "user_name": "Henry Chong",
  "permissions": {
    "links.example.com": "admin",
    "example.com": "admin",
    "secondary.example.net": "edit",
    "user1.example.com": "read"
  },
  "created_at": 1736784000,
  "updated_at": 1736784000
}
```

#### Tool Permission Requirements

```typescript
const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  // Read operations
  list_routes: "read",
  get_route: "read",
  get_analytics_summary: "read",
  get_clicks: "read",
  get_views: "read",
  get_slug_stats: "read",

  // Edit operations
  create_route: "edit",
  update_route: "edit",
  toggle_route: "edit",

  // Admin operations
  delete_route: "admin",
};
```

### Project Structure

```
slackbot/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── README.md
└── src/
    ├── index.ts              # Worker entry point
    ├── slack/
    │   ├── verify.ts         # Signature verification
    │   ├── events.ts         # Event handlers
    │   └── format.ts         # Message formatting
    ├── auth/
    │   ├── permissions.ts    # Permission checking
    │   └── types.ts          # Permission types
    └── api/
        └── client.ts         # → shared/client.ts
```

### wrangler.toml

```toml
name = "cloudflare-edge-router-slackbot"
main = "src/index.ts"
compatibility_date = "2025-01-01"

# KV for permissions
[[kv_namespaces]]
binding = "SLACK_PERMISSIONS"
id = "..." # Create via: wrangler kv namespace create slack-permissions

# D1 for conversations (Phase III)
[[d1_databases]]
binding = "DB"
database_name = "cloudflare-edge-router-analytics"
database_id = "5d3b1430-3405-451a-a165-f497e178a838"

[vars]
EDGE_ROUTER_URL = "https://example.com"
```

### Required Secrets

```bash
# Slack credentials
wrangler secret put SLACK_SIGNING_SECRET    # From Slack app settings
wrangler secret put SLACK_BOT_TOKEN         # xoxb-... token

# Claude API (for Phase III)
wrangler secret put ANTHROPIC_API_KEY

# Admin API
wrangler secret put ADMIN_API_KEY
```

### Signature Verification

```typescript
// src/slack/verify.ts
import { timingSafeEqual } from 'crypto';

export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string
): boolean {
  // Reject if timestamp is more than 5 minutes old
  const time = Math.floor(Date.now() / 1000);
  if (Math.abs(time - parseInt(timestamp)) > 300) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(sigBasestring);
  const computed = `v0=${hmac.digest('hex')}`;

  return timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(signature)
  );
}
```

### Phase II Checklist

- [ ] Create slackbot/ directory structure
- [ ] Create Slack app in Slack API dashboard
- [ ] Configure bot scopes and event subscriptions
- [ ] Create KV namespace for permissions
- [ ] Implement signature verification
- [ ] Implement permission checking middleware
- [ ] Implement event handlers
- [ ] Deploy Worker
- [ ] Configure Slack event URL
- [ ] Add initial user permissions to KV
- [ ] Test mentions and DMs

---

## Phase III: AI-Powered Responses

### Purpose

Integrate Claude API to:
1. Parse natural language queries
2. Determine appropriate tool(s) to call
3. Execute tools with permission enforcement
4. Generate human-friendly responses
5. Handle multi-turn conversations

### Claude API Integration

```typescript
// src/ai/claude.ts
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
});

export async function processMessage(
  message: string,
  context: ConversationContext,
  tools: Tool[],
  permissions: SlackUserPermissions
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: buildSystemPrompt(permissions),
    tools: tools,
    messages: context.messages.concat([
      { role: "user", content: message }
    ]),
  });

  // Handle tool_use blocks
  if (response.stop_reason === "tool_use") {
    const toolResults = await executeTools(response, permissions);
    // Continue conversation with tool results
    return processMessage(message, updatedContext, tools, permissions);
  }

  return extractTextResponse(response);
}
```

### System Prompt

```typescript
function buildSystemPrompt(permissions: SlackUserPermissions): string {
  const domains = Object.entries(permissions.permissions)
    .filter(([_, level]) => level !== "none")
    .map(([domain, level]) => `- ${domain} (${level})`)
    .join('\n');

  return `You are an Edge Router assistant that helps users manage URL redirects and view analytics.

## Your Capabilities

**Route Management:**
- List, create, update, and delete routes
- Routes can be redirects (send to URL), proxies (fetch content), or R2 (serve files)
- Each domain has its own set of routes

**Analytics:**
- View click statistics for links
- View page view statistics
- See top links, pages, countries, referrers
- Analyze traffic trends

## Domains You Can Access

${domains}

## Guidelines

1. **Always confirm destructive actions** before executing (delete, bulk changes)
2. **Be concise** - Slack messages should be scannable
3. **Use formatting** - Bullet points, bold for emphasis
4. **Provide context** - Include comparisons (vs last week, etc.)
5. **Ask for clarification** if the domain or route is ambiguous
6. **Respect permissions** - Some operations may be restricted

## Response Format

For analytics queries:
- Key numbers with context
- Trends or comparisons when available
- Actionable insights if relevant

For route changes:
- Confirm what was changed
- Show the new state
- Explain how to undo if needed`;
}
```

### Tool Execution with Permission Enforcement

```typescript
// src/ai/execute.ts
async function executeTools(
  response: Anthropic.Message,
  permissions: SlackUserPermissions,
  client: EdgeRouterClient
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const block of response.content) {
    if (block.type !== "tool_use") continue;

    const toolName = block.name;
    const input = block.input as Record<string, unknown>;
    const domain = (input.domain as string) || defaultDomain;

    // Check permission
    const requiredLevel = TOOL_PERMISSIONS[toolName];
    const userLevel = permissions.permissions[domain] || "none";

    if (!hasPermission(userLevel, requiredLevel)) {
      results.push({
        tool_use_id: block.id,
        content: `Permission denied: You have '${userLevel}' access to ${domain}, but '${requiredLevel}' is required for ${toolName}.`,
        is_error: true,
      });
      continue;
    }

    // Execute tool
    try {
      const result = await executeTool(client, toolName, input);
      results.push({
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: false,
      });
    } catch (error) {
      results.push({
        tool_use_id: block.id,
        content: `Error: ${error.message}`,
        is_error: true,
      });
    }
  }

  return results;
}
```

### Conversation State Management

#### D1 Schema

```sql
CREATE TABLE slack_conversations (
  id TEXT PRIMARY KEY,           -- channel_id:thread_ts
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  messages TEXT NOT NULL,        -- JSON array of messages
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_conversations_user ON slack_conversations(user_id);
CREATE INDEX idx_conversations_updated ON slack_conversations(updated_at);
```

#### Conversation Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                    MULTI-TURN CONVERSATION                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User: "How many clicks did I get today?"                          │
│                     │                                               │
│                     ▼                                               │
│  Bot: "You got 23 clicks today across all domains:                 │
│        • links.example.com: 18 clicks                            │
│        • example.com: 5 clicks"                                 │
│                     │                                               │
│                     ▼ (thread created, state saved)                 │
│                                                                     │
│  User (in thread): "What about just links.example.com?"          │
│                     │                                               │
│                     ▼ (context loaded from D1)                      │
│                                                                     │
│  Bot: "For links.example.com specifically:                       │
│        • 18 clicks today                                           │
│        • Top link: /linkedin (7 clicks)                            │
│        • Top country: US (10 clicks)"                              │
│                     │                                               │
│                     ▼ (state updated)                               │
│                                                                     │
│  User (in thread): "Which link was most popular?"                  │
│                     │                                               │
│                     ▼                                               │
│                                                                     │
│  Bot: "The /linkedin link was most popular with 7 clicks today."   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

#### State Management

```typescript
// src/ai/conversation.ts
interface ConversationState {
  id: string;
  user_id: string;
  channel_id: string;
  thread_ts: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  created_at: number;
  updated_at: number;
}

export async function loadConversation(
  db: D1Database,
  channelId: string,
  threadTs: string
): Promise<ConversationState | null> {
  const id = `${channelId}:${threadTs}`;
  const result = await db.prepare(
    "SELECT * FROM slack_conversations WHERE id = ?"
  ).bind(id).first();

  if (!result) return null;

  return {
    ...result,
    messages: JSON.parse(result.messages as string),
  };
}

export async function saveConversation(
  db: D1Database,
  state: ConversationState
): Promise<void> {
  await db.prepare(`
    INSERT INTO slack_conversations (id, user_id, channel_id, thread_ts, messages, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      messages = excluded.messages,
      updated_at = excluded.updated_at
  `).bind(
    state.id,
    state.user_id,
    state.channel_id,
    state.thread_ts,
    JSON.stringify(state.messages),
    state.created_at,
    Date.now() / 1000
  ).run();
}
```

### Response Formatting

```typescript
// src/slack/format.ts
export function formatAnalyticsSummary(summary: AnalyticsSummary): string {
  const lines = [
    `*Analytics Summary (${summary.period})*`,
    '',
    `📊 *Totals*`,
    `• Total Clicks: ${summary.clicks.total.toLocaleString()}`,
    `• Unique Links: ${summary.clicks.uniqueSlugs}`,
    `• Total Page Views: ${summary.views.total.toLocaleString()}`,
    `• Unique Pages: ${summary.views.uniquePaths}`,
  ];

  if (summary.topClicks.length > 0) {
    lines.push('', '🔗 *Top Links*');
    summary.topClicks.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. \`${item.name}\` - ${item.count} clicks`);
    });
  }

  if (summary.topCountries.length > 0) {
    lines.push('', '🌍 *Top Countries*');
    summary.topCountries.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name || 'Unknown'} - ${item.count}`);
    });
  }

  return lines.join('\n');
}
```

### Phase III Checklist

- [ ] Add D1 migration for slack_conversations table
- [ ] Implement Claude API client
- [ ] Build system prompt generator
- [ ] Implement tool execution with permission checks
- [ ] Implement conversation state management
- [ ] Add response formatting for Slack
- [ ] Handle multi-turn conversations
- [ ] Add conversation cleanup (TTL or cron)
- [ ] Test end-to-end flow

---

## Shared Code Package

### Purpose

Avoid duplication between MCP server and Slackbot by extracting common code.

### Structure

```
cloudflare-edge-router/
├── shared/                       # Shared code package
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # Exports
│       ├── client.ts             # EdgeRouterClient
│       ├── types.ts              # Shared types
│       ├── schemas.ts            # Zod schemas
│       └── tools.ts              # Tool definitions
├── mcp/                          # Imports from shared
├── slackbot/                     # Imports from shared
└── package.json                  # Workspace root
```

### Workspace Configuration

```json
// Root package.json
{
  "private": true,
  "workspaces": [
    "shared",
    "mcp",
    "slackbot"
  ]
}
```

### Tool Definitions (Shared)

```typescript
// shared/src/tools.ts
export const toolDefinitions = [
  {
    name: "list_routes",
    description: "List all routes configured for a domain.",
    input_schema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Target domain (e.g., 'links.example.com')"
        }
      }
    }
  },
  {
    name: "create_route",
    description: "Create a new redirect, proxy, or R2 route.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path starting with /" },
        type: { type: "string", enum: ["redirect", "proxy", "r2"] },
        target: { type: "string", description: "Target URL or R2 key" },
        statusCode: { type: "number", description: "HTTP status (301/302/307/308)" },
        preserveQuery: { type: "boolean", default: true },
        domain: { type: "string" }
      },
      required: ["path", "type", "target"]
    }
  },
  // ... all 10 tools
];

// Export for MCP SDK format and Claude API format
export function toMCPTools(definitions: ToolDefinition[]) { ... }
export function toClaudeTools(definitions: ToolDefinition[]) { ... }
```

---

## Slack App Setup Guide

### Step 1: Create Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: "Edge Router"
4. Workspace: Select your workspace
5. Click "Create App"

### Step 2: Configure Bot

1. Navigate to "OAuth & Permissions"
2. Add Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `users:read`

### Step 3: Enable Events

1. Navigate to "Event Subscriptions"
2. Toggle "Enable Events" ON
3. Request URL: `https://edge-router-slackbot.<account>.workers.dev/slack/events`
   (Update after deploying Worker)
4. Subscribe to bot events:
   - `app_mention`
   - `message.im`
5. Save Changes

### Step 4: Install to Workspace

1. Navigate to "Install App"
2. Click "Install to Workspace"
3. Authorize permissions
4. Copy "Bot User OAuth Token" (xoxb-...)

### Step 5: Get Signing Secret

1. Navigate to "Basic Information"
2. Copy "Signing Secret"

### Step 6: Deploy Worker & Configure

```bash
# Create KV namespace
wrangler kv namespace create slack-permissions

# Set secrets
cd slackbot
wrangler secret put SLACK_SIGNING_SECRET    # Paste signing secret
wrangler secret put SLACK_BOT_TOKEN         # Paste xoxb-... token
wrangler secret put ANTHROPIC_API_KEY       # Claude API key
wrangler secret put ADMIN_API_KEY           # Admin API key

# Deploy
pnpm run deploy
```

### Step 7: Update Event URL

1. Return to Slack app settings
2. Update Request URL with deployed Worker URL
3. Slack will verify the endpoint

### Step 8: Add Initial Permissions

```bash
# Add yourself as admin
wrangler kv key put --binding SLACK_PERMISSIONS "U1234567890" '{
  "user_id": "U1234567890",
  "user_name": "Henry Chong",
  "permissions": {
    "links.example.com": "admin",
    "example.com": "admin",
    "secondary.example.net": "admin"
  },
  "created_at": 1736784000,
  "updated_at": 1736784000
}'
```

---

## Security Considerations

| Risk | Phase | Mitigation |
|------|-------|------------|
| API key exposure | I | Environment variables, 1Password |
| Unauthorized Slack access | II | Signature verification, KV permissions |
| Permission bypass | II/III | Server-side enforcement before tool execution |
| Excessive API calls | All | Cloudflare WAF rate limiting |
| Conversation data leak | III | User-scoped conversations, auto-cleanup |
| Prompt injection | III | Structured tool outputs, limited system prompt |

---

## Implementation Timeline

| Phase | Estimated Effort | Dependencies |
|-------|------------------|--------------|
| **Phase I: MCP Server** | 1-2 days | None |
| **Phase II: Slackbot** | 2-3 days | Phase I (shared code) |
| **Phase III: AI Responses** | 1-2 days | Phase II |
| **Total** | 4-7 days | |

---

## Complete Checklist

### Phase I: MCP Server
- [ ] Create shared/ package with client, types, schemas, tools
- [ ] Create mcp/ directory structure
- [ ] Initialize package.json with @modelcontextprotocol/sdk
- [ ] Implement EdgeRouterClient HTTP client
- [ ] Implement all 6 route management tools
- [ ] Implement all 4 analytics tools
- [ ] Build and test locally
- [ ] Add to Claude Code config
- [ ] Test natural language queries
- [ ] Write README.md

### Phase II: Slackbot Worker
- [ ] Create Slack app in Slack API dashboard
- [ ] Configure bot scopes and event subscriptions
- [ ] Create slackbot/ directory structure
- [ ] Create KV namespace for permissions
- [ ] Implement signature verification
- [ ] Implement permission checking middleware
- [ ] Implement event handlers (app_mention, message.im)
- [ ] Deploy Worker
- [ ] Configure Slack event URL
- [ ] Add initial user permissions to KV
- [ ] Test mentions and DMs

### Phase III: AI-Powered Responses
- [ ] Add D1 migration for slack_conversations table
- [ ] Implement Claude API client
- [ ] Build system prompt generator with domain context
- [ ] Implement tool execution with permission enforcement
- [ ] Implement conversation state management
- [ ] Add response formatting for Slack
- [ ] Handle multi-turn conversations in threads
- [ ] Add conversation cleanup cron
- [ ] Test end-to-end flow
- [ ] Test permission denied scenarios

---

## Natural Language Examples

| User Query | Tools Called | Response |
|------------|--------------|----------|
| "How many clicks did I get this week?" | get_analytics_summary | Summary with totals and top links |
| "Show me /linkedin stats" | get_slug_stats | Detailed stats for that slug |
| "Add a redirect from /zoom to my Zoom link" | create_route | Confirmation of created route |
| "Disable /old-blog" | toggle_route | Confirmation route is disabled |
| "List all routes for secondary.example.net" | list_routes | List of routes for that domain |
| "Delete /test" | delete_route | Confirmation (or permission denied) |
| "What countries are visitors from?" | get_analytics_summary | Top countries breakdown |

---

Ready to implement!
