import { describe, expect, it } from 'vitest';
import { LINK_NAMING_HINT, type LinkNamingIssueCode, linkNamingIssues } from './link-naming.js';

const codes = (path: string, fileKey?: string) =>
  linkNamingIssues(path, fileKey).map(issue => `${issue.code}:${issue.token}`);

describe('linkNamingIssues', () => {
  it.each([
    ['/brochures/corporate-overview-en', '20260923-example-brochure-corporate-overview-en.pdf'],
    ['/services/fund-admin-tc', '20260801-services-fund-admin-tc.pdf'],
    ['/office-sg', 'offices/20250310-office-sg-overview.pdf'],
    ['/regulation/companies-act', 'regulation/companies-act-2004-consolidated.pdf'],
    ['/brochures/family-office-cn', undefined],
    ['/marketing/decision-guide-ms', undefined],
    ['/', 'report.pdf'],
    ['', 'report.pdf'],
    ['/site/*', 'site/'],
    ['/annual-report', '123456.pdf'],
    ['/order-123456', undefined],
    ['/dec-1', undefined],
    ['/copywriting', undefined],
    ['/finalists', undefined],
  ])('raises nothing for the well-named link %s', (path, fileKey) => {
    expect(linkNamingIssues(path, fileKey)).toEqual([]);
  });

  it.each([
    ['/report.pdf', '.pdf'],
    ['/brochures/Corporate.PDF', '.pdf'],
    ['/deck.pptx', '.pptx'],
    ['/clip.mp4', '.mp4'],
    ['/page.html/', '.html'],
  ])('flags the file extension in %s', (path, token) => {
    expect(codes(path)).toEqual([`file-extension:${token}`]);
  });

  it('ignores a dot that is not an extension', () => {
    expect(codes('/.env')).toEqual([]);
    expect(codes('/release.2')).toEqual([]);
  });

  it.each([
    ['/corporate-overview-en', 'brochures/corporate-overview-en.pdf'],
    ['/Corporate_Overview_EN', 'corporate-overview-en.pdf'],
    ['/brochures/corporateoverviewen', 'corporate-overview-en.pdf'],
    ['/corporate-overview-en', 'corporate-overview-en'],
  ])('flags %s as a copy of the file name %s', (path, fileKey) => {
    expect(linkNamingIssues(path, fileKey).map(issue => issue.code)).toEqual(['file-name']);
  });

  it('flags a link that repeats the file name with its extension', () => {
    expect(codes('/brochure.pdf', 'docs/brochure.pdf')).toEqual([
      'file-extension:.pdf',
      'file-name:brochure.pdf',
    ]);
  });

  it('reports a dated file name used as the link', () => {
    expect(
      codes('/20260923-example-brochure-en', 'brochures/20260923-example-brochure-en.pdf'),
    ).toEqual(['file-name:20260923-example-brochure-en', 'date:20260923']);
  });

  it.each([
    ['/report-20260923', 'date:20260923'],
    ['/report-23092026', 'date:23092026'],
    ['/report-260923', 'date:260923'],
    ['/report-072026', 'date:072026'],
    ['/report-202607', 'date:202607'],
    ['/report-2026-09-23', 'date:2026-09-23'],
    ['/report_2026_09_23', 'date:2026_09_23'],
    ['/report-2026', 'date:2026'],
    ['/2026/report', 'date:2026'],
    ['/report-aug26', 'date:aug26'],
    ['/report-sep2026', 'date:sep2026'],
    ['/report-sept-2026', 'date:sept-2026'],
    ['/report-august2026', 'date:august2026'],
    ['/report-may-26', 'date:may-26'],
  ])('flags the date in %s', (path, expected) => {
    expect(codes(path)).toEqual([expected]);
  });

  it('rejects implausible 6- and 8-digit numbers as dates', () => {
    expect(codes('/ref-99999999')).toEqual([]);
    expect(codes('/ref-12345678')).toEqual([]);
    expect(codes('/ref-999999')).toEqual([]);
  });

  it.each([
    ['/report-final', 'version:final'],
    ['/report-draft', 'version:draft'],
    ['/report-copy', 'version:copy'],
    ['/report-v2', 'version:v2'],
    ['/report-v3', 'version:v3'],
    ['/V10/report', 'version:v10'],
  ])('flags the version word in %s', (path, expected) => {
    expect(codes(path)).toEqual([expected]);
  });

  it('reports every problem once, in link order', () => {
    expect(codes('/2026/report-final-final-v2-aug26.pdf')).toEqual([
      'file-extension:.pdf',
      'date:2026',
      'version:final',
      'version:v2',
      'date:aug26',
    ]);
  });

  it('ignores the query string and fragment', () => {
    expect(codes('/brochure?v=2026#final')).toEqual([]);
  });

  it('gives every issue a person-readable message naming the token', () => {
    const issues = linkNamingIssues('/report-final-20260923.pdf', 'report-final-20260923.pdf');
    const byCode = Object.fromEntries(issues.map(issue => [issue.code, issue.message])) as Record<
      LinkNamingIssueCode,
      string
    >;
    expect(byCode['file-extension']).toContain('.pdf');
    expect(byCode['file-name']).toContain('file name');
    expect(byCode.date).toContain('20260923');
    expect(byCode.version).toContain('final');
  });

  it('publishes the standing hint', () => {
    expect(LINK_NAMING_HINT).toBe(
      'Name the link after the document, not the file — no dates, versions or file extensions. The link stays the same when you swap the file later.',
    );
  });
});
