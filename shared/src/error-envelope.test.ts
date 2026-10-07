import { describe, expect, it } from 'vitest';
import { isErrorCode, readErrorEnvelope } from './error-envelope';

describe('readErrorEnvelope: the one reader of a failed answer for the client and the dashboard', () => {
  it('keeps a coded refusal: the code beside its sentence', () => {
    expect(
      readErrorEnvelope({
        success: false,
        error: 'QR_NOT_FOUND',
        message: 'QR code not found: gone',
      }),
    ).toMatchObject({ code: 'QR_NOT_FOUND', text: 'QR code not found: gone' });
  });

  it('an explicit code field wins over a code in error, and carries details', () => {
    expect(
      readErrorEnvelope({
        code: 'ROUTE_TARGET_CREDENTIAL',
        error: 'Refused',
        message: 'This route target carries credential-named parameters (token).',
        details: { parameters: ['token'] },
      }),
    ).toMatchObject({
      code: 'ROUTE_TARGET_CREDENTIAL',
      text: 'This route target carries credential-named parameters (token).',
      details: { parameters: ['token'] },
    });
    expect(readErrorEnvelope({ code: 'SOME_CODE', error: 'Something failed' })).toMatchObject({
      code: 'SOME_CODE',
      text: 'Something failed',
      details: undefined,
    });
  });

  it('a code is an UPPER_SNAKE value only: anything else is text, never a code', () => {
    // An error sentence beside a message (the 500 answer) is not a code
    expect(readErrorEnvelope({ error: 'Internal Server Error', message: 'boom' })).toMatchObject({
      code: undefined,
      text: 'boom',
      details: undefined,
    });
    // A code field that is not UPPER_SNAKE is ignored
    for (const code of [
      'some_code',
      'Not a code',
      'TRAILING_',
      '_LEADING',
      'DOUBLE__SCORE',
      '9X',
    ]) {
      expect(readErrorEnvelope({ code, error: 'Refused' })?.code).toBeUndefined();
    }
    expect(readErrorEnvelope({ error: 'Validation failed', details: [1] })).toMatchObject({
      code: undefined,
      text: 'Validation failed',
      details: [1],
    });
  });

  it('an empty or non-string field reads as absent', () => {
    expect(readErrorEnvelope({ error: '', message: '', code: '' })).toMatchObject({
      code: undefined,
      text: undefined,
      details: undefined,
    });
    expect(readErrorEnvelope({ error: 42, message: ['x'] })).toMatchObject({
      code: undefined,
      text: undefined,
      details: undefined,
    });
  });

  it('a body that is not a JSON object is no envelope', () => {
    for (const body of [null, 'text', [1], 3]) expect(readErrorEnvelope(body)).toBeNull();
  });

  it('reads own fields only', () => {
    const body: Record<string, unknown> = Object.create({ error: 'INHERITED', message: 'x' });
    expect(readErrorEnvelope(body)).toMatchObject({
      code: undefined,
      text: undefined,
      details: undefined,
    });
  });

  it('isErrorCode', () => {
    expect(isErrorCode('QR_NOT_FOUND')).toBe(true);
    expect(isErrorCode('SAME')).toBe(true);
    expect(isErrorCode('qr_not_found')).toBe(false);
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode(1)).toBe(false);
  });
});
