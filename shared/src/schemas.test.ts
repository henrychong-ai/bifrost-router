import { describe, it, expect } from 'vitest';
import {
  DomainSchema,
  RouteTypeSchema,
  RedirectStatusCodeSchema,
  CreateRouteInputSchema,
  UpdateRouteInputSchema,
  ListRoutesInputSchema,
  GetRouteInputSchema,
  CreateRouteToolInputSchema,
  DeleteRouteInputSchema,
  ToggleRouteInputSchema,
  GetAnalyticsSummaryInputSchema,
  GetClicksInputSchema,
  GetSlugStatsInputSchema,
} from './schemas.js';

describe('schemas', () => {
  describe('DomainSchema', () => {
    it('accepts valid domains', () => {
      expect(DomainSchema.safeParse('link.henrychong.com').success).toBe(true);
      expect(DomainSchema.safeParse('henrychong.com').success).toBe(true);
      expect(DomainSchema.safeParse(undefined).success).toBe(true);
    });

    it('rejects invalid domains', () => {
      expect(DomainSchema.safeParse('example.com').success).toBe(false);
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
      expect(
        UpdateRouteInputSchema.safeParse({ target: 'https://new.com' }).success,
      ).toBe(true);
      expect(UpdateRouteInputSchema.safeParse({ enabled: false }).success).toBe(
        true,
      );
      expect(UpdateRouteInputSchema.safeParse({ type: 'proxy' }).success).toBe(
        true,
      );
    });

    it('accepts empty update (no fields)', () => {
      expect(UpdateRouteInputSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('ListRoutesInputSchema', () => {
    it('accepts optional domain', () => {
      expect(ListRoutesInputSchema.safeParse({}).success).toBe(true);
      expect(
        ListRoutesInputSchema.safeParse({ domain: 'henrychong.com' }).success,
      ).toBe(true);
    });
  });

  describe('GetRouteInputSchema', () => {
    it('requires path', () => {
      expect(GetRouteInputSchema.safeParse({ path: '/test' }).success).toBe(
        true,
      );
      expect(GetRouteInputSchema.safeParse({}).success).toBe(false);
    });

    it('rejects path not starting with /', () => {
      expect(GetRouteInputSchema.safeParse({ path: 'test' }).success).toBe(
        false,
      );
    });
  });

  describe('CreateRouteToolInputSchema', () => {
    it('accepts valid tool input', () => {
      const result = CreateRouteToolInputSchema.safeParse({
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/test',
        domain: 'link.henrychong.com',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('DeleteRouteInputSchema', () => {
    it('requires path', () => {
      expect(DeleteRouteInputSchema.safeParse({ path: '/test' }).success).toBe(
        true,
      );
      expect(DeleteRouteInputSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('ToggleRouteInputSchema', () => {
    it('requires path and enabled', () => {
      expect(
        ToggleRouteInputSchema.safeParse({ path: '/test', enabled: true })
          .success,
      ).toBe(true);
      expect(
        ToggleRouteInputSchema.safeParse({ path: '/test', enabled: false })
          .success,
      ).toBe(true);
      expect(ToggleRouteInputSchema.safeParse({ path: '/test' }).success).toBe(
        false,
      );
      expect(ToggleRouteInputSchema.safeParse({ enabled: true }).success).toBe(
        false,
      );
    });
  });

  describe('GetAnalyticsSummaryInputSchema', () => {
    it('accepts optional domain and days', () => {
      expect(GetAnalyticsSummaryInputSchema.safeParse({}).success).toBe(true);
      expect(
        GetAnalyticsSummaryInputSchema.safeParse({ domain: 'henrychong.com' })
          .success,
      ).toBe(true);
      expect(
        GetAnalyticsSummaryInputSchema.safeParse({ days: 7 }).success,
      ).toBe(true);
      expect(
        GetAnalyticsSummaryInputSchema.safeParse({
          domain: 'henrychong.com',
          days: 30,
        }).success,
      ).toBe(true);
    });

    it('rejects days out of range', () => {
      expect(
        GetAnalyticsSummaryInputSchema.safeParse({ days: 0 }).success,
      ).toBe(false);
      expect(
        GetAnalyticsSummaryInputSchema.safeParse({ days: 366 }).success,
      ).toBe(false);
    });
  });

  describe('GetClicksInputSchema', () => {
    it('accepts optional filters', () => {
      expect(GetClicksInputSchema.safeParse({}).success).toBe(true);
      expect(
        GetClicksInputSchema.safeParse({ slug: '/linkedin' }).success,
      ).toBe(true);
      expect(GetClicksInputSchema.safeParse({ country: 'US' }).success).toBe(
        true,
      );
      expect(
        GetClicksInputSchema.safeParse({ limit: 50, offset: 10 }).success,
      ).toBe(true);
    });

    it('rejects invalid limit/offset', () => {
      expect(GetClicksInputSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(GetClicksInputSchema.safeParse({ limit: 101 }).success).toBe(
        false,
      );
      expect(GetClicksInputSchema.safeParse({ offset: -1 }).success).toBe(
        false,
      );
    });
  });

  describe('GetSlugStatsInputSchema', () => {
    it('requires slug', () => {
      expect(
        GetSlugStatsInputSchema.safeParse({ slug: '/linkedin' }).success,
      ).toBe(true);
      expect(GetSlugStatsInputSchema.safeParse({}).success).toBe(false);
    });

    it('rejects slug not starting with /', () => {
      expect(
        GetSlugStatsInputSchema.safeParse({ slug: 'linkedin' }).success,
      ).toBe(false);
    });
  });
});
