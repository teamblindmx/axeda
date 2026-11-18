import type { webcrypto } from 'node:crypto';
import type { PinHasher } from '@teamblind/axeda-core';

/** Lo que se usa del contexto de Better Auth: su secreto y su hash de contraseñas (scrypt). */
export interface PinHashingContext {
  readonly secret: string;
  readonly password: {
    hash(password: string): Promise<string>;
    verify(data: { password: string; hash: string }): Promise<boolean>;
  };
}

const encoder = new TextEncoder();

/**
 * El PIN se mezcla primero con una clave derivada del `secret` de Better Auth (HMAC-SHA256, el
 * _pepper_) y después pasa por el hash lento de contraseñas de Better Auth. Un PIN de 6 dígitos solo
 * tiene un millón de combinaciones: sin la clave, una copia de la base de datos no basta para
 * probarlas; con ella, cada prueba sigue costando un hash lento.
 */
export function createBetterAuthPinHasher(context: PinHashingContext): PinHasher {
  let key: Promise<webcrypto.CryptoKey> | undefined;
  const pepperKey = () =>
    (key ??= globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(`axeda-pin-pepper:${context.secret}`),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ));
  const peppered = async (pin: string): Promise<string> => {
    const mac = await globalThis.crypto.subtle.sign('HMAC', await pepperKey(), encoder.encode(pin));
    return Buffer.from(mac).toString('base64url');
  };

  return {
    async hash(pin) {
      return context.password.hash(await peppered(pin));
    },
    async verify(pin, hash) {
      try {
        return await context.password.verify({ password: await peppered(pin), hash });
      } catch {
        // Un hash mal formado (dato corrupto) no deja entrar a nadie.
        return false;
      }
    },
  };
}
