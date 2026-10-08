/**
 * One MCP tool call: its JSON-RPC arguments read as unknown and validated
 * with the tool's SHARED schema before any handler sees them (v1.38.0). The
 * stdio server's low-level `Server` validates nothing, and the arguments came
 * in through `as` casts, so a non-string path reached the client as it was.
 * Now a call whose arguments fail the schema is refused with the failing
 * field and nothing is sent; a missing domain is still answered with the
 * actionable no-domain error the handlers give.
 */
import {
  CreateQrToolInputSchema,
  CreateRouteToolInputSchema,
  DeleteQrInputSchema,
  DeleteRouteInputSchema,
  type EdgeRouterClient,
  GetAnalyticsSummaryInputSchema,
  GetClicksInputSchema,
  GetQrInputSchema,
  GetRouteInputSchema,
  GetRouteQrInputSchema,
  GetSlugStatsInputSchema,
  GetViewsInputSchema,
  isRecord,
  ListBucketsInputSchema,
  ListQrsInputSchema,
  ListRoutesInputSchema,
  MigrateRouteToolInputSchema,
  R2DeleteObjectInputSchema,
  R2GetObjectInputSchema,
  R2ListObjectsInputSchema,
  R2MoveInputSchema,
  R2ObjectKeyInputSchema,
  R2RenameInputSchema,
  R2UpdateCommentInputSchema,
  R2UpdateMetadataInputSchema,
  R2UploadInputSchema,
  ToggleRouteInputSchema,
  TransferRouteToolInputSchema,
  UpdateQrToolInputSchema,
  UpdateRouteToolInputSchema,
} from '@bifrost/shared';
import type { z } from 'zod';
import { getAnalyticsSummary, getClicks, getSlugStats, getViews } from './tools/analytics.js';
import { NO_DOMAIN_ERROR, requireDomain } from './tools/domain.js';
import { createQr, deleteQr, getQr, getRouteQr, listQrs, updateQr } from './tools/qr.js';
import {
  createRoute,
  deleteRoute,
  getRoute,
  handleTransferRoute,
  listRoutes,
  migrateRoute,
  toggleRoute,
  transferDomainsError,
  updateRoute,
} from './tools/routes.js';
import {
  deleteObject,
  getObject,
  getObjectMeta,
  handlePurgeCache,
  listBuckets,
  listObjects,
  moveObject,
  renameObject,
  updateObjectComment,
  updateObjectMetadata,
  uploadObject,
} from './tools/storage.js';

/** A tool: validates its raw arguments, then runs its handler. */
type Tool = (client: EdgeRouterClient, args: Record<string, unknown>) => Promise<string>;

/** The refusal of arguments that fail the tool's schema: the field and why, nothing sent. */
export function invalidArgumentsError(name: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.join('.') ?? '';
  return `Error: invalid arguments for ${name}: ${field ? `${field}: ` : ''}${issue?.message ?? 'validation failed'}`;
}

/**
 * A tool whose arguments are validated with `schema` before `run` sees them.
 * `before` answers first when it has something to say (the no-domain errors,
 * which name what to send).
 */
function validated<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (client: EdgeRouterClient, args: z.output<S>) => Promise<string>,
  before?: (args: Record<string, unknown>) => string | undefined,
): Tool {
  return async (client, args) => {
    const early = before?.(args);
    if (early !== undefined) return early;
    const parsed = schema.safeParse(args);
    if (!parsed.success) return invalidArgumentsError(name, parsed.error);
    return run(client, parsed.data);
  };
}

/** The no-domain error for a tool that names one domain. */
const needsDomain = (args: Record<string, unknown>) =>
  requireDomain(args['domain']) === undefined ? NO_DOMAIN_ERROR : undefined;

/** transfer_route names both of its domains, and which one is missing. */
const needsTransferDomains = (args: Record<string, unknown>) => {
  const missing = [
    ...(requireDomain(args['from_domain']) ? [] : ['from_domain']),
    ...(requireDomain(args['to_domain']) ? [] : ['to_domain']),
  ];
  return missing.length > 0 ? transferDomainsError(missing) : undefined;
};

const TOOLS: Record<string, Tool> = {
  list_routes: validated('list_routes', ListRoutesInputSchema, listRoutes, needsDomain),
  get_route: validated('get_route', GetRouteInputSchema, getRoute, needsDomain),
  create_route: validated('create_route', CreateRouteToolInputSchema, createRoute, needsDomain),
  update_route: validated('update_route', UpdateRouteToolInputSchema, updateRoute, needsDomain),
  delete_route: validated('delete_route', DeleteRouteInputSchema, deleteRoute, needsDomain),
  toggle_route: validated('toggle_route', ToggleRouteInputSchema, toggleRoute, needsDomain),
  migrate_route: validated('migrate_route', MigrateRouteToolInputSchema, migrateRoute, needsDomain),
  transfer_route: validated(
    'transfer_route',
    TransferRouteToolInputSchema,
    handleTransferRoute,
    needsTransferDomains,
  ),
  get_analytics_summary: validated(
    'get_analytics_summary',
    GetAnalyticsSummaryInputSchema,
    getAnalyticsSummary,
  ),
  get_clicks: validated('get_clicks', GetClicksInputSchema, getClicks),
  get_views: validated('get_views', GetViewsInputSchema, getViews),
  get_slug_stats: validated('get_slug_stats', GetSlugStatsInputSchema, getSlugStats, needsDomain),
  list_buckets: validated('list_buckets', ListBucketsInputSchema, client => listBuckets(client)),
  list_objects: validated('list_objects', R2ListObjectsInputSchema, listObjects),
  get_object_meta: validated('get_object_meta', R2ObjectKeyInputSchema, getObjectMeta),
  get_object: validated('get_object', R2GetObjectInputSchema, getObject),
  upload_object: validated('upload_object', R2UploadInputSchema, uploadObject),
  delete_object: validated('delete_object', R2DeleteObjectInputSchema, deleteObject),
  rename_object: validated('rename_object', R2RenameInputSchema, renameObject),
  move_object: validated('move_object', R2MoveInputSchema, moveObject),
  update_object_metadata: validated(
    'update_object_metadata',
    R2UpdateMetadataInputSchema,
    updateObjectMetadata,
  ),
  update_object_comment: validated(
    'update_object_comment',
    R2UpdateCommentInputSchema,
    updateObjectComment,
  ),
  purge_cache: validated('purge_cache', R2ObjectKeyInputSchema, handlePurgeCache),
  list_qrs: validated('list_qrs', ListQrsInputSchema, listQrs, needsDomain),
  get_qr: validated('get_qr', GetQrInputSchema, getQr, needsDomain),
  create_qr: validated('create_qr', CreateQrToolInputSchema, createQr, needsDomain),
  update_qr: validated('update_qr', UpdateQrToolInputSchema, updateQr, needsDomain),
  delete_qr: validated('delete_qr', DeleteQrInputSchema, deleteQr, needsDomain),
  get_route_qr: validated('get_route_qr', GetRouteQrInputSchema, getRouteQr, needsDomain),
};

/** Whether `name` is a tool this server runs. */
export function isKnownTool(name: string): boolean {
  return Object.hasOwn(TOOLS, name);
}

/**
 * Run one tool call. `rawArgs` is the JSON-RPC `arguments` as it arrived:
 * anything but an object (or nothing) reads as no arguments, so a call
 * without them still gets the actionable no-domain error. Throws only for an
 * unknown tool name.
 */
export async function callTool(
  client: EdgeRouterClient,
  name: string,
  rawArgs: unknown,
): Promise<string> {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
  return tool(client, isRecord(rawArgs) ? rawArgs : {});
}
