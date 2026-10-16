/**
 * El secreto de una invitación: 32 bytes aleatorios (256 bits). Con tanta entropía basta un hash
 * rápido (SHA-256) para guardarlo; no hace falta uno lento como el de las contraseñas.
 * Solo se usa la API Web Crypto estándar (el núcleo no importa módulos de Node).
 */

const SECRET_BYTES = 32;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

export function newSecret(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante (no se detiene en la primera diferencia). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** El token que recibe la persona invitada: `<id>.<secreto>`. */
export const buildToken = (id: string, secret: string): string => `${id}.${secret}`;

export function parseToken(token: unknown): { id: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { id: token.slice(0, dot), secret: token.slice(dot + 1) };
}
