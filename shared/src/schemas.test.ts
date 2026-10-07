import { assert, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CreateQrToolInputSchema,
  DeleteQrInputSchema,
  GetQrInputSchema,
  GetRouteQrInputSchema,
  ListQrsInputSchema,
  UpdateQrToolInputSchema,
} from './qr.js';
import {
  AcknowledgeCredentialTargetToolSchema,
  CreateRouteInputSchema,
  CreateRouteToolInputSchema,
  DeleteRouteInputSchema,
  DomainSchema,
  GetAnalyticsSummaryInputSchema,
  GetClicksInputSchema,
  GetRouteInputSchema,
  GetSlugStatsInputSchema,
  GetViewsInputSchema,
  ListRoutesInputSchema,
  mcpNumber,
  R2UpdateCommentInputSchema,
  RedirectStatusCodeSchema,
  RoutePathSchema,
  RouteSchema,
  RoutesListQuerySchema,
  RouteTypeSchema,
  ToggleRouteInputSchema,
  UpdateRouteInputSchema,
  UpdateRouteToolInputSchema,
} from './schemas.js';
import { SUPPORTED_DOMAINS } from './types.js';

const validRoute = () => ({
  path: '/ok',
  type: 'redirect',
  target: 'https://app.example/landing',
});

const create = (overrides: Record<string, unknown>) =>
  CreateRouteToolInputSchema.safeParse({
    path: '/ok',
    type: 'redirect',
    target: 'https://app.example/landing',
    domain: 'links.example.com',
    ...overrides,
  });

function create_ack(value: unknown): boolean | undefined {
  const parsed = AcknowledgeCredentialTargetToolSchema.safeParse(value);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : undefined;
}

const parseToggle = (enabled: unknown) =>
  ToggleRouteInputSchema.safeParse({
    path: '/test',
    enabled,
    domain: 'links.example.com',
  });

describe('schemas', () => {
  describe('DomainSchema', () => {
    it('accepts valid domains', () => {
      expect(DomainSchema.safeParse('links.example.com').success).toBe(true);
      expect(DomainSchema.safeParse('example.com').success).toBe(true);
      expect(DomainSchema.safeParse(undefined).success).toBe(true);
    });

    it('rejects invalid domains', () => {
      expect(DomainSchema.safeParse('unsupported.example.org').success).toBe(false);
      expect(DomainSchema.safeParse('localhost').success).toBe(false);
    });
  });

  describe('RouteTypeSchema', () => {
    it('accepts valid route types', () => {
      expect(RouteTypeSchema.safeParse('redirect').success).toBe(true);
      expect(RouteTypeSchema.safeParse('proxy').success).toBe(true);
      expect(RouteTypeSchema.safeParse('r2').success).toBe(true);
    });

    it('rejects invalid route types', () => {
      expect(RouteTypeSchema.safeParse('invalid').success).toBe(false);
      expect(RouteTypeSchema.safeParse('rewrite').success).toBe(false);
    });
  });

  describe('RedirectStatusCodeSchema', () => {
    it('accepts valid status codes', () => {
      expect(RedirectStatusCodeSchema.safeParse(301).success).toBe(true);
      expect(RedirectStatusCodeSchema.safeParse(302).success).toBe(true);
      expect(RedirectStatusCodeSchema.safeParse(307).success).toBe(true);
      expect(RedirectStatusCodeSchema.safeParse(308).success).toBe(true);
    });

    it('rejects invalid status codes', () => {
      expect(RedirectStatusCodeSchema.safeParse(200).success).toBe(false);
      expect(RedirectStatusCodeSchema.safeParse(303).success).toBe(false);
      expect(RedirectStatusCodeSchema.safeParse(404).success).toBe(false);
    });
  });

  describe('CreateRouteInputSchema', () => {
    it('accepts valid create input', () => {
      const result = CreateRouteInputSchema.safeParse({
        path: '/test',
        type: 'redirect',
        target: 'https://example.com',
      });
      expect(result.success).toBe(true);
    });

    it('accepts full create input with all options', () => {
      const result = CreateRouteInputSchema.safeParse({
        path: '/test',
        type: 'redirect',
        target: 'https://example.com',
        statusCode: 301,
        preserveQuery: false,
        cacheControl: 'max-age=3600',
        enabled: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects path not starting with /', () => {
      const result = CreateRouteInputSchema.safeParse({
        path: 'test',
        type: 'redirect',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty path', () => {
      const result = CreateRouteInputSchema.safeParse({
        path: '',
        type: 'redirect',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('UpdateRouteInputSchema', () => {
    it('accepts partial update input', () => {
      expect(UpdateRouteInputSchema.safeParse({ target: 'https://new.com' }).success).toBe(true);
      expect(UpdateRouteInputSchema.safeParse({ enabled: false }).success).toBe(true);
      expect(UpdateRouteInputSchema.safeParse({ type: 'proxy' }).success).toBe(true);
    });

    it('accepts empty update (no fields)', () => {
      expect(UpdateRouteInputSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('ListRoutesInputSchema', () => {
    it('requires an enumerated domain (v1.35.0 — no default anywhere)', () => {
      expect(ListRoutesInputSchema.safeParse({ domain: 'example.com' }).success).toBe(true);
      expect(ListRoutesInputSchema.safeParse({}).success).toBe(false);
      expect(ListRoutesInputSchema.safeParse({ domain: '' }).success).toBe(false);
      expect(ListRoutesInputSchema.safeParse({ domain: 'evil.example' }).success).toBe(false);
    });
  });

  describe('GetRouteInputSchema', () => {
    it('requires path and domain', () => {
      expect(
        GetRouteInputSchema.safeParse({ path: '/test', domain: 'links.example.com' }).success,
      ).toBe(true);
      expect(GetRouteInputSchema.safeParse({ domain: 'links.example.com' }).success).toBe(false);
      expect(GetRouteInputSchema.safeParse({ path: '/test' }).success).toBe(false);
    });

    it('rejects path not starting with /', () => {
      expect(
        GetRouteInputSchema.safeParse({ path: 'test', domain: 'links.example.com' }).success,
      ).toBe(false);
    });
  });

  describe('CreateRouteToolInputSchema', () => {
    it('accepts valid tool input', () => {
      const result = CreateRouteToolInputSchema.safeParse({
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/test',
        domain: 'links.example.com',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('DeleteRouteInputSchema', () => {
    it('requires path and domain', () => {
      expect(
        DeleteRouteInputSchema.safeParse({ path: '/test', domain: 'links.example.com' }).success,
      ).toBe(true);
      expect(DeleteRouteInputSchema.safeParse({ domain: 'links.example.com' }).success).toBe(false);
      expect(DeleteRouteInputSchema.safeParse({ path: '/test' }).success).toBe(false);
    });

    it('an ordinary delete takes the route-path rules; a recovery takes the listed key as it is', () => {
      const domain = 'links.example.com';
      expect(DeleteRouteInputSchema.safeParse({ path: '/p?x', domain }).success).toBe(false);
      for (const recover of [true, 'true']) {
        const parsed = DeleteRouteInputSchema.safeParse({
          path: '/p?x',
          domain,
          recover_invalid: recover,
        });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.recover_invalid).toBe(true);
      }
      expect(
        DeleteRouteInputSchema.safeParse({ path: 'p', domain, recover_invalid: true }).success,
      ).toBe(false);
      expect(
        DeleteRouteInputSchema.safeParse({ path: '/a', domain, recover_invalid: 'maybe' }).success,
      ).toBe(false);
    });
  });

  describe('RoutesListQuerySchema', () => {
    it('accepts whole numbers and the known filters only', () => {
      expect(RoutesListQuerySchema.parse({ limit: '10', offset: '20' })).toMatchObject({
        limit: 10,
        offset: 20,
      });
      for (const query of [
        { limit: 'abc' },
        { limit: '0' },
        { limit: '1001' },
        { limit: '1.5' },
        { limit: '' },
        { offset: '-1' },
        { offset: '2.5' },
        { offset: 'x' },
        { type: 'bogus' },
        { enabled: 'maybe' },
      ]) {
        expect({ query, success: RoutesListQuerySchema.safeParse(query).success }).toEqual({
          query,
          success: false,
        });
      }
    });
  });

  describe('RoutePathSchema / RouteTargetSchema', () => {
    it('accepts an ordinary path and target', () => {
      expect(create({}).success).toBe(true);
      expect(create({ path: '/a/b-c_d' }).success).toBe(true);
      expect(create({ path: '/a%20b' }).success).toBe(true);
    });

    it('refuses a path that cannot round-trip through normalisation', () => {
      // `normalizePath()` strips `?`/`#` BEFORE decoding, so a stored `/p%3Fx`
      // is listed back as `/p?x` and renormalises to a DIFFERENT route.
      expect(create({ path: '/p?x' }).success).toBe(false);
      expect(create({ path: '/p#x' }).success).toBe(false);
      expect(create({ path: '/p%3Fx' }).success).toBe(false);
      // A `%` surviving one decode is a second encode level, which orphans the
      // record entirely.
      expect(create({ path: '/p%253Fx' }).success).toBe(false);
    });

    it('refuses a target carrying a control character', () => {
      // The URL parser strips tab/LF/CR from anywhere in a URL, so
      // `to<TAB>ken=LIVE` would scan clean and then be served as `?token=LIVE`.
      expect(create({ target: 'https://app.example/?to\tken=LIVE' }).success).toBe(false);
      expect(create({ target: 'https://app.example/\nlanding' }).success).toBe(false);
      expect(create({ target: 'https://app.example/\u007flanding' }).success).toBe(false);
    });

    // v1.37.2: a cap at write time keeps every route record far below the
    // backup's 1 MiB record line limit
    it('caps a target at 8,192 characters, with a fixed message', () => {
      const base = 'https://app.example/';
      const at = (length: number) => `${base}${'a'.repeat(length - base.length)}`;
      expect(create({ target: at(8192) }).success).toBe(true);
      const over = create({ target: at(8193) });
      expect(over.success).toBe(false);
      expect(over.error?.issues.map(issue => issue.message)).toEqual([
        'Target must be at most 8192 characters',
      ]);
      expect(UpdateRouteInputSchema.safeParse({ target: at(8193) }).success).toBe(false);
    });

    it('caps hostHeader at 253 and cacheControl at 256 characters, on every route write schema', () => {
      for (const schema of [CreateRouteInputSchema, UpdateRouteInputSchema]) {
        const base = schema === CreateRouteInputSchema ? validRoute() : {};
        expect(schema.safeParse({ ...base, hostHeader: 'h'.repeat(253) }).success).toBe(true);
        expect(schema.safeParse({ ...base, hostHeader: 'h'.repeat(254) }).success).toBe(false);
        expect(schema.safeParse({ ...base, cacheControl: 'c'.repeat(256) }).success).toBe(true);
        expect(schema.safeParse({ ...base, cacheControl: 'c'.repeat(257) }).success).toBe(false);
      }
      for (const schema of [CreateRouteToolInputSchema, UpdateRouteToolInputSchema]) {
        const base = { ...validRoute(), domain: 'example.com' };
        expect(schema.safeParse({ ...base, hostHeader: 'h'.repeat(254) }).success).toBe(false);
        expect(schema.safeParse({ ...base, cacheControl: 'c'.repeat(257) }).success).toBe(false);
      }
    });
  });

  // v1.37.2: the response schema describes what is stored, so a route written
  // before the caps, or with a legacy path, still reads back
  describe('RouteSchema (response)', () => {
    it('accepts a legacy stored route over every write cap', () => {
      const legacy = {
        path: '/p?x',
        type: 'proxy',
        target: `https://app.example/${'a'.repeat(20_000)}`,
        hostHeader: 'h'.repeat(300),
        cacheControl: 'c'.repeat(300),
        createdAt: 1,
        updatedAt: 2,
      };
      expect(RouteSchema.safeParse(legacy).success).toBe(true);
      // The write schemas still refuse each of those fields
      expect(CreateRouteInputSchema.safeParse(legacy).success).toBe(false);
      for (const field of ['target', 'hostHeader', 'cacheControl'] as const) {
        expect(UpdateRouteInputSchema.safeParse({ [field]: legacy[field] }).success).toBe(false);
      }
    });
  });

  describe('AcknowledgeCredentialTargetToolSchema', () => {
    it('is optional, and parses the stringified booleans MCP clients send', () => {
      expect(create_ack(undefined)).toBe(undefined);
      expect(create_ack(true)).toBe(true);
      expect(create_ack('true')).toBe(true);
      expect(create_ack('false')).toBe(false);
    });

    it('refuses a value it does not recognise rather than guessing', () => {
      expect(AcknowledgeCredentialTargetToolSchema.safeParse('maybe').success).toBe(false);
      expect(AcknowledgeCredentialTargetToolSchema.safeParse(1).success).toBe(false);
    });
  });

  describe('ToggleRouteInputSchema', () => {
    it('parses the string forms and REFUSES an unrecognised value', () => {
      // ⚠️ `"false"` must DISABLE. A plain truthiness test would enable it.
      expect(parseToggle('false').success && parseToggle('false').data.enabled).toBe(false);
      expect(parseToggle('true').success && parseToggle('true').data.enabled).toBe(true);
      // A toggle is often the response to an abused link, so it fails closed.
      for (const value of ['off', 'disabled', 'n', 1, 0]) {
        expect(parseToggle(value).success).toBe(false);
      }
    });

    it('requires path, enabled and domain', () => {
      expect(
        ToggleRouteInputSchema.safeParse({
          path: '/test',
          enabled: true,
          domain: 'links.example.com',
        }).success,
      ).toBe(true);
      expect(
        ToggleRouteInputSchema.safeParse({
          path: '/test',
          enabled: false,
          domain: 'links.example.com',
        }).success,
      ).toBe(true);
      expect(
        ToggleRouteInputSchema.safeParse({ path: '/test', domain: 'links.example.com' }).success,
      ).toBe(false);
      expect(
        ToggleRouteInputSchema.safeParse({ enabled: true, domain: 'links.example.com' }).success,
      ).toBe(false);
      expect(ToggleRouteInputSchema.safeParse({ path: '/test', enabled: true }).success).toBe(
        false,
      );
    });
  });

  describe('GetAnalyticsSummaryInputSchema', () => {
    it('accepts optional domain and days', () => {
      expect(GetAnalyticsSummaryInputSchema.safeParse({}).success).toBe(true);
      expect(GetAnalyticsSummaryInputSchema.safeParse({ domain: 'example.com' }).success).toBe(
        true,
      );
      expect(GetAnalyticsSummaryInputSchema.safeParse({ days: 7 }).success).toBe(true);
      expect(
        GetAnalyticsSummaryInputSchema.safeParse({
          domain: 'example.com',
          days: 30,
        }).success,
      ).toBe(true);
    });

    it('rejects days out of range', () => {
      expect(GetAnalyticsSummaryInputSchema.safeParse({ days: 0 }).success).toBe(false);
      expect(GetAnalyticsSummaryInputSchema.safeParse({ days: 366 }).success).toBe(false);
    });

    // v1.35.0 — the optional domain is an ENUM, so omitting it is fine but
    // naming an unsupported one is not. Pinned for all three analytics schemas.
    it.each([
      ['get_analytics_summary', GetAnalyticsSummaryInputSchema],
      ['get_clicks', GetClicksInputSchema],
      ['get_views', GetViewsInputSchema],
    ])('%s: domain is optional but enumerated', (_name, schema) => {
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ domain: undefined }).success).toBe(true);
      for (const domain of SUPPORTED_DOMAINS) {
        expect(schema.safeParse({ domain }).success).toBe(true);
      }
      expect(schema.safeParse({ domain: 'evil.example' }).success).toBe(false);
      expect(schema.safeParse({ domain: '' }).success).toBe(false);
    });
  });

  describe('GetClicksInputSchema', () => {
    it('accepts optional filters', () => {
      expect(GetClicksInputSchema.safeParse({}).success).toBe(true);
      expect(GetClicksInputSchema.safeParse({ slug: '/linkedin' }).success).toBe(true);
      expect(GetClicksInputSchema.safeParse({ country: 'US' }).success).toBe(true);
      expect(GetClicksInputSchema.safeParse({ limit: 50, offset: 10 }).success).toBe(true);
    });

    it('rejects invalid limit/offset', () => {
      expect(GetClicksInputSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(GetClicksInputSchema.safeParse({ limit: 101 }).success).toBe(false);
      expect(GetClicksInputSchema.safeParse({ offset: -1 }).success).toBe(false);
    });
  });

  describe('GetSlugStatsInputSchema', () => {
    it('requires slug and domain', () => {
      expect(
        GetSlugStatsInputSchema.safeParse({ slug: '/linkedin', domain: 'links.example.com' })
          .success,
      ).toBe(true);
      expect(GetSlugStatsInputSchema.safeParse({ domain: 'links.example.com' }).success).toBe(
        false,
      );
      // v1.35.0 — the domain is required too: the same slug can live on several
      // domains and an unscoped read silently merges their clicks.
      expect(GetSlugStatsInputSchema.safeParse({ slug: '/linkedin' }).success).toBe(false);
    });

    it('rejects slug not starting with /', () => {
      expect(
        GetSlugStatsInputSchema.safeParse({ slug: 'linkedin', domain: 'links.example.com' })
          .success,
      ).toBe(false);
    });
  });
});

describe('R2UpdateCommentInputSchema (v1.30.0 — nullable-boundary semantics)', () => {
  it('accepts a comment string', () => {
    expect(
      R2UpdateCommentInputSchema.safeParse({
        bucket: 'files',
        key: 'docs/report.pdf',
        comment: 'Q2 pack — final',
      }).success,
    ).toBe(true);
  });

  it('accepts null and empty string (both mean clear)', () => {
    expect(
      R2UpdateCommentInputSchema.safeParse({ bucket: 'files', key: 'a.pdf', comment: null })
        .success,
    ).toBe(true);
    expect(
      R2UpdateCommentInputSchema.safeParse({ bucket: 'files', key: 'a.pdf', comment: '' }).success,
    ).toBe(true);
  });

  it('keeps the literal string "null" as text, not a clear', () => {
    const result = R2UpdateCommentInputSchema.safeParse({
      bucket: 'files',
      key: 'a.pdf',
      comment: 'null',
    });
    expect(result.success).toBe(true);
    assert(result.success);
    expect(result.data.comment).toBe('null');
  });

  it('rejects an omitted comment field (explicit-set semantics — absence is never a clear)', () => {
    expect(R2UpdateCommentInputSchema.safeParse({ bucket: 'files', key: 'a.pdf' }).success).toBe(
      false,
    );
  });

  it('rejects comments over the 1000-char cap', () => {
    expect(
      R2UpdateCommentInputSchema.safeParse({
        bucket: 'files',
        key: 'a.pdf',
        comment: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
  });
});

/**
 * v1.35.0 — one matrix over every MCP input schema that requires a domain, so a
 * schema cannot quietly relax back to the optional string. Each is exercised
 * with its own minimal valid input plus a domain that is: omitted, empty,
 * non-string, unsupported, or each supported value in turn.
 *
 * Deliberately absent: `migrate_route` and `transfer_route`. This repo has no shared Zod input schema for either — their contract lives in
 * the JSON-Schema catalog (`shared/src/tools.ts`, pinned by tools.test.ts) and
 * in the stdio handler guards (pinned by
 * mcp/src/tools/routes.no-domain.test.ts).
 */
describe('v1.35.0 required-domain schema matrix', () => {
  const CASES: [string, { safeParse: (v: unknown) => { success: boolean } }, object][] = [
    ['ListRoutesInputSchema', ListRoutesInputSchema, {}],
    ['GetRouteInputSchema', GetRouteInputSchema, { path: '/x' }],
    [
      'CreateRouteToolInputSchema',
      CreateRouteToolInputSchema,
      { path: '/x', type: 'redirect', target: 'https://target.example.com' },
    ],
    ['UpdateRouteToolInputSchema', UpdateRouteToolInputSchema, { path: '/x' }],
    ['DeleteRouteInputSchema', DeleteRouteInputSchema, { path: '/x' }],
    ['ToggleRouteInputSchema', ToggleRouteInputSchema, { path: '/x', enabled: true }],
    ['GetSlugStatsInputSchema', GetSlugStatsInputSchema, { slug: '/x' }],
    ['ListQrsInputSchema', ListQrsInputSchema, {}],
    ['GetQrInputSchema', GetQrInputSchema, { id: 'qr_1' }],
    [
      'CreateQrToolInputSchema',
      CreateQrToolInputSchema,
      { type: 'url', payload: { url: 'https://target.example.com' } },
    ],
    ['UpdateQrToolInputSchema', UpdateQrToolInputSchema, { id: 'qr_1' }],
    ['DeleteQrInputSchema', DeleteQrInputSchema, { id: 'qr_1' }],
    ['GetRouteQrInputSchema', GetRouteQrInputSchema, { path: '/x' }],
  ];

  it('covers the 13 schema-backed required-domain tools', () => {
    // 14 tools require a domain; migrate_route has no shared schema here.
    expect(CASES).toHaveLength(13);
  });

  it.each(CASES)('%s rejects an omitted domain', (_name, schema, base) => {
    expect(schema.safeParse({ ...base }).success).toBe(false);
  });

  it.each(CASES)('%s rejects an empty-string domain', (_name, schema, base) => {
    expect(schema.safeParse({ ...base, domain: '' }).success).toBe(false);
  });

  it.each(CASES)('%s rejects an unsupported domain', (_name, schema, base) => {
    expect(schema.safeParse({ ...base, domain: 'evil.example' }).success).toBe(false);
  });

  it.each(CASES)('%s rejects a non-string domain', (_name, schema, base) => {
    for (const domain of [123, null, true, {}, []]) {
      expect(schema.safeParse({ ...base, domain }).success).toBe(false);
    }
  });

  it.each(CASES)('%s accepts every supported domain', (_name, schema, base) => {
    for (const domain of SUPPORTED_DOMAINS) {
      expect(schema.safeParse({ ...base, domain }).success).toBe(true);
    }
  });
});

describe('RoutePathSchema', () => {
  it('refuses ?, #, a % surviving one decode, and controls raw or once-decoded', () => {
    for (const bad of [
      '/p?x',
      '/p#x',
      '/p%3Fx',
      '/p%23x',
      '/p%253Fx',
      '/a%2520b',
      '/p\tx',
      '/p\nx',
      '/p\u007fx',
      '/p%09x',
      '/p%0Ax',
      '/p%7Fx',
      'p',
      '',
    ]) {
      expect({ path: bad, ok: RoutePathSchema.safeParse(bad).success }).toEqual({
        path: bad,
        ok: false,
      });
    }
  });

  it('accepts ordinary encoded and unicode paths', () => {
    for (const ok of ['/', '/a', '/a%20b', '/caf%C3%A9', '/A/B-c_d.e', '/x/*']) {
      expect({ path: ok, ok: RoutePathSchema.safeParse(ok).success }).toEqual({
        path: ok,
        ok: true,
      });
    }
  });
});

// v1.38.0: numeric MCP tool fields read decimal text as numbers, and nothing else
describe('mcpNumber', () => {
  const limit = mcpNumber(z.number().int().min(1).max(100)).optional();

  it.each([
    ['20', 20],
    [' 7 ', 7],
    ['+5', 5],
    [20, 20],
    [undefined, undefined],
  ])('reads %j as %j', (input, output) => {
    expect(limit.parse(input)).toBe(output);
  });

  it.each([[''], ['  '], [null], [false], [[]], ['0x10'], ['1e2'], ['20px'], ['2.5'], ['0']])(
    'refuses %j, never coercing it to a number',
    input => {
      expect(limit.safeParse(input).success).toBe(false);
    },
  );
});
