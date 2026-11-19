import type { PinHasher } from '@teamblind/axeda-core';

const PREFIX = 'test-sha256:';

async function digest(pin: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`test-pin:${pin}`),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash de PIN para las pruebas: rápido y **sin** clave del servidor. Nunca en producción: un PIN de
 * 6 dígitos se rompe al instante con él. Con Better Auth el plugin pone uno lento y con _pepper_.
 */
export function createTestPinHasher(): PinHasher & {
  readonly calls: { hash: number; verify: number };
} {
  const calls = { hash: 0, verify: 0 };
  return {
    calls,
    async hash(pin) {
      calls.hash += 1;
      return PREFIX + (await digest(pin));
    },
    async verify(pin, hash) {
      calls.verify += 1;
      return hash === PREFIX + (await digest(pin));
    },
  };
}
