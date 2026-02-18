/**
 * @bifrost/shared
 *
 * Shared code for Bifrost MCP server and Slackbot
 */

// Types
export * from './types.js';

// Schemas - export selectively to avoid conflicts with types.ts
export {
  // Domain schema
  DomainSchema,
  // Route schemas
  RouteTypeSchema,
  RedirectStatusCodeSchema,
  RouteSchema,
  CreateRouteInputSchema,
  UpdateRouteInputSchema,
  // Analytics query schemas
  AnalyticsSummaryQuerySchema,
  AnalyticsListQuerySchema,
  SlugStatsQuerySchema,
  // Audit log schemas
  AuditActionSchema,
  AuditLogSchema,
  // MCP Tool input schemas
  ListRoutesInputSchema,
  GetRouteInputSchema,
  CreateRouteToolInputSchema,
  UpdateRouteToolInputSchema,
  DeleteRouteInputSchema,
  ToggleRouteInputSchema,
  GetAnalyticsSummaryInputSchema,
  GetClicksInputSchema,
  GetViewsInputSchema,
  GetSlugStatsInputSchema,
  // Inferred types from schemas (renamed to avoid conflicts)
  type ListRoutesInput,
  type GetRouteInput,
  type CreateRouteToolInput,
  type UpdateRouteToolInput,
  type DeleteRouteInput,
  type ToggleRouteInput,
  type GetAnalyticsSummaryInput,
  type GetClicksInput,
  type GetViewsInput,
  type GetSlugStatsInput,
  type AuditAction,
} from './schemas.js';

// Client
export {
  EdgeRouterClient,
  EdgeRouterError,
  createClientFromEnv,
} from './client.js';
export type { EdgeRouterClientConfig } from './client.js';

// Tool definitions
export {
  toolDefinitions,
  getToolDefinition,
  toMCPTools,
  toClaudeTools,
  toolCategories,
  getToolsByCategory,
  routeTools,
  analyticsTools,
} from './tools.js';
export type {
  ToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
} from './tools.js';
