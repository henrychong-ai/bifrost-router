import { Plug, Boxes, Terminal, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CodeBlock } from '@/components/code-block';
import { getToolsByCategory, toolDefinitions, type ToolDefinition } from '@bifrost/shared';

/**
 * MCP integration tab (v1.30.0 — ported from upstream v1.53.0, rewritten for
 * this deployment's LOCAL STDIO server: there is no remote /mcp endpoint and
 * no OAuth — the server runs on your machine and authenticates to the admin
 * API with the ADMIN_API_KEY, exactly like the dashboard).
 */

interface ClientDoc {
  id: string;
  name: string;
  blurb: string;
  snippets: { title: string; code: string; copyLabel: string }[];
  notes: string[];
}

const CLIENTS: ClientDoc[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: 'Register the stdio server once at user scope — available in every project.',
    snippets: [
      {
        title: 'One-time registration',
        code: 'claude mcp add --scope user bifrost \\\n  --env EDGE_ROUTER_URL=https://bifrost.example.com \\\n  --env EDGE_ROUTER_API_KEY=$BIFROST_ADMIN_KEY \\\n  -- node /path/to/bifrost/mcp/dist/index.js',
        copyLabel: 'Command',
      },
    ],
    notes: [
      'Build the server first: pnpm --filter mcp build (from the repo root).',
      'Inject EDGE_ROUTER_API_KEY from your secret manager rather than pasting it into config.',
      'Verify with claude mcp list — the server name is bifrost.',
    ],
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    blurb: 'Add a stdio entry to claude_desktop_config.json (full executable paths).',
    snippets: [
      {
        title: 'claude_desktop_config.json → mcpServers',
        code: '"bifrost": {\n  "command": "/usr/local/bin/node",\n  "args": ["/path/to/bifrost/mcp/dist/index.js"],\n  "env": {\n    "EDGE_ROUTER_URL": "https://bifrost.example.com",\n    "EDGE_ROUTER_API_KEY": "<from your secret manager>"\n  }\n}',
        copyLabel: 'Config',
      },
    ],
    notes: [
      'Claude Desktop requires FULL executable paths (node, not a bare command name).',
      'Remote connectors (Settings → Connectors) do NOT apply — this deployment has no remote /mcp endpoint.',
    ],
  },
];

const TOOL_CATEGORIES: {
  key: 'route' | 'analytics' | 'storage' | 'qr';
  label: string;
}[] = [
  { key: 'route', label: 'Routes' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'storage', label: 'Storage' },
  { key: 'qr', label: 'QR Codes' },
];

function ToolRow({ tool }: { tool: ToolDefinition }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-border/30 py-2 last:border-0">
      <div className="flex items-center gap-2">
        <code className="font-mono text-small font-medium text-blue-700">{tool.name}</code>
      </div>
      <p className="font-inter text-tiny text-charcoal-600">{tool.description}</p>
    </li>
  );
}

export function McpPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in flex items-center gap-4">
        <h1 className="font-inter text-huge font-bold text-blue-950">MCP</h1>
        <Badge className="border-transparent bg-gold-100 font-inter text-gold-600 hover:scale-100">
          Local stdio · Admin key
        </Badge>
        <div className="gradient-accent-bar h-1 flex-1 rounded-full opacity-30" />
      </div>

      <p className="animate-stagger-init animate-fade-in-up stagger-1 max-w-3xl font-inter text-small text-charcoal-600">
        Connect any MCP-capable AI client to Bifrost to manage routes, R2 storage, QR codes, and
        analytics from your agent. The server runs <strong>locally over stdio</strong> (the{' '}
        <code className="font-mono text-tiny">mcp/</code> package in this repo) and authenticates to
        the admin API with the same admin key the dashboard uses — there is no remote endpoint and
        no separate login.
      </p>

      {/* Connect — quick facts */}
      <Card className="animate-stagger-init animate-fade-in-up stagger-2 border-border/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-inter font-semibold text-blue-950">
            <Plug className="size-4 text-blue-600" />
            How it connects
          </CardTitle>
          <CardDescription className="font-inter">
            Your client spawns the server as a child process; the server calls the admin API.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-6 gap-y-2 font-inter text-small sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-charcoal-500">Transport</dt>
              <dd className="text-charcoal-700">stdio (local child process)</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-charcoal-500">Auth</dt>
              <dd className="text-charcoal-700">X-Admin-Key → admin API (full access)</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-charcoal-500">Server entry</dt>
              <dd className="font-mono text-tiny text-charcoal-700">mcp/dist/index.js</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-charcoal-500">Tools</dt>
              <dd className="text-charcoal-700">{toolDefinitions.length} (all local)</dd>
            </div>
          </dl>
          <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 font-inter text-tiny text-charcoal-600">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The key grants everything the dashboard can do — inject it from a secret manager
              instead of writing it into config files where possible.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Client setup */}
      <div className="animate-stagger-init animate-fade-in-up stagger-3 space-y-4">
        <h2 className="flex items-center gap-2 font-inter text-large font-semibold text-blue-950">
          <Terminal className="size-4 text-blue-600" />
          Client setup
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {CLIENTS.map(client => (
            <Card key={client.id} className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="font-inter font-semibold text-blue-950">
                  {client.name}
                </CardTitle>
                <CardDescription className="font-inter">{client.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {client.snippets.map(s => (
                  <CodeBlock key={s.title} title={s.title} code={s.code} copyLabel={s.copyLabel} />
                ))}
                <ul className="space-y-1 font-inter text-tiny text-charcoal-600">
                  {client.notes.map((note, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-1 size-1 shrink-0 rounded-full bg-charcoal-300" />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Tool catalog */}
      <div className="animate-stagger-init animate-fade-in-up stagger-4 space-y-4">
        <h2 className="flex items-center gap-2 font-inter text-large font-semibold text-blue-950">
          <Boxes className="size-4 text-blue-600" />
          Available tools
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {TOOL_CATEGORIES.map(cat => {
            const tools = getToolsByCategory(cat.key);
            if (tools.length === 0) return null;
            return (
              <Card key={cat.key} className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="font-inter text-small font-semibold text-blue-950">
                    {cat.label}{' '}
                    <span className="font-normal text-charcoal-400">({tools.length})</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul>
                    {tools.map(tool => (
                      <ToolRow key={tool.name} tool={tool} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
