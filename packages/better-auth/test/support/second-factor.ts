import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import { PASSWORD, type HttpApp } from './http.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(text: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/**
 * El código de seis dígitos de una app de autenticación (RFC 6238: HMAC-SHA1, 30 s). Está escrito
 * aparte de Better Auth a propósito: si los dos coinciden, el plugin cumple el estándar.
 */
export function authenticatorCode(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const value =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(value % 1_000_000).padStart(6, '0');
}

/** El valor de una cookie dentro de un `nombre=valor; nombre=valor`. */
export function cookiePair(cookies: string, name: string): string | undefined {
  return cookies.split('; ').find((pair) => pair.startsWith(`${name}=`));
}

/** Activa el 2FA con el plugin real. Devuelve la sesión nueva que Better Auth emite y el secreto. */
export async function turnOnTwoFactor(
  app: HttpApp,
  person: { readonly cookie: string },
): Promise<{ readonly cookie: string; readonly secret: string }> {
  const enable = await app.post('/two-factor/enable', { password: PASSWORD }, person.cookie);
  expect(enable.status, JSON.stringify(enable.json)).toBe(200);
  const secret = new URL(enable.json.totpURI as string).searchParams.get('secret');
  if (secret === null) throw new Error('the 2FA enrolment gave no secret');
  const verify = await app.post(
    '/two-factor/verify-totp',
    { code: authenticatorCode(secret) },
    person.cookie,
  );
  expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  return { cookie: verify.cookies, secret };
}

/** Inicia sesión como lo haría una persona con 2FA: contraseña y luego el código. */
export async function signInWithSecondFactor(
  app: HttpApp,
  input: { readonly email: string; readonly secret: string; readonly trustDevice?: boolean },
): Promise<{ readonly cookie: string; readonly trustedDevice: string | undefined }> {
  const first = await app.post('/sign-in/email', { email: input.email, password: PASSWORD });
  expect(first.json.twoFactorRedirect, JSON.stringify(first.json)).toBe(true);
  const second = await app.post(
    '/two-factor/verify-totp',
    { code: authenticatorCode(input.secret), trustDevice: input.trustDevice === true },
    first.cookies,
  );
  expect(second.status, JSON.stringify(second.json)).toBe(200);
  return {
    cookie: second.cookies,
    trustedDevice: cookiePair(second.cookies, 'better-auth.trust_device'),
  };
}
