/**
 * QR code tool handlers for the stdio MCP server (v1.35.0).
 *
 * Thin formatting layer over EdgeRouterClient's /api/qr methods — the API owns
 * validation (discriminated payload schemas, type immutability), so handlers
 * surface its errors verbatim and format results for tool output.
 *
 * `domain` is required on every QR tool and never defaulted. The low-level
 * stdio Server validates nothing, so the guard below is the enforcement here;
 * without it an omitted domain reached the API's ADMIN_API_DOMAIN fallback and
 * a QR meant for one domain landed on another's host.
 */

import type { EdgeRouterClient, QRCode } from '@bifrost/shared';
import { NO_DOMAIN_ERROR, requireDomain } from './routes.js';

function formatQr(qr: QRCode): string {
  const lines = [
    `QR: ${qr.id} (${qr.type})`,
    `Domain: ${qr.domain}`,
    ...(qr.description ? [`Description: ${qr.description}`] : []),
    ...(qr.tags && qr.tags.length > 0 ? [`Tags: ${qr.tags.join(', ')}`] : []),
    `Payload: ${JSON.stringify(qr.payload)}`,
    `Design: ${JSON.stringify(qr.design)}`,
    ...(qr.linkedRoute
      ? [
          `Linked route: https://${qr.linkedRoute.domain}${qr.linkedRoute.path} (dynamic — the image encodes the short URL while the route exists)`,
        ]
      : []),
    `Created: ${new Date(qr.createdAt).toISOString()} by ${qr.createdBy}`,
    `Updated: ${new Date(qr.updatedAt).toISOString()}`,
  ];
  return lines.join('\n');
}

function formatError(error: unknown): string {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export async function listQrs(
  client: EdgeRouterClient,
  args: {
    domain?: string;
    type?: string;
    tag?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const { items, meta } = await client.listQrs({ ...args, domain });
    if (items.length === 0) return 'No QR codes found.';

    const rows = items.map(
      qr =>
        `- ${qr.id} (${qr.type})${qr.description ? ` — ${qr.description}` : ''}${qr.linkedRoute ? ` → ${qr.linkedRoute.path}` : ''}`,
    );
    return [
      `${meta.total} QR code(s) (showing ${meta.count}, offset ${meta.offset}):`,
      ...rows,
    ].join('\n');
  } catch (error) {
    return formatError(error);
  }
}

export async function getQr(
  client: EdgeRouterClient,
  args: { id: string; domain?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const qr = await client.getQr(args.id, domain);
    return formatQr(qr);
  } catch (error) {
    return formatError(error);
  }
}

export async function createQr(
  client: EdgeRouterClient,
  args: {
    domain?: string;
    type: string;
    payload: Record<string, unknown>;
    id?: string;
    description?: string;
    tags?: string[];
    design?: Record<string, unknown>;
    linkedRoute?: { domain: string; path: string };
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const { domain: _domain, ...input } = args;
    const qr = await client.createQr(input, domain);
    return `QR code created.\n\n${formatQr(qr)}`;
  } catch (error) {
    return formatError(error);
  }
}

export async function updateQr(
  client: EdgeRouterClient,
  args: {
    id: string;
    domain?: string;
    description?: string;
    tags?: string[];
    payload?: Record<string, unknown>;
    design?: Record<string, unknown>;
    linkedRoute?: { domain: string; path: string };
    clearLinkedRoute?: boolean;
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const { id, domain: _domain, clearLinkedRoute, ...rest } = args;
    const input: Record<string, unknown> = { ...rest };
    // The REST contract clears the link with an explicit null.
    if (clearLinkedRoute) input.linkedRoute = null;

    const qr = await client.updateQr(id, input, domain);
    return `QR code updated.\n\n${formatQr(qr)}`;
  } catch (error) {
    return formatError(error);
  }
}

export async function deleteQr(
  client: EdgeRouterClient,
  args: { id: string; domain?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const result = await client.deleteQr(args.id, domain);
    return `QR code deleted: ${result.id} (hard delete; the audit log preserves the record).`;
  } catch (error) {
    return formatError(error);
  }
}

export async function getRouteQr(
  client: EdgeRouterClient,
  args: { path: string; domain?: string; fg?: string; bg?: string; size?: number },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const svg = await client.getRouteQrSvg(args.path, {
      domain,
      fg: args.fg,
      bg: args.bg,
      size: args.size,
    });
    return `QR SVG for ${args.path} (ephemeral — use create_qr with linkedRoute to persist):\n\n${svg}`;
  } catch (error) {
    return formatError(error);
  }
}
