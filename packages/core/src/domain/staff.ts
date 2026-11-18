import type { AssignmentScope } from './scope.js';

/**
 * Personal con usuario y PIN: cuentas que crea un administrador para quien trabaja en una
 * compañía, un negocio o una sede (meseros, cocineros…), sin correo. Nunca administran Axeda.
 */

/** 3 a 32 caracteres: minúsculas, números, punto, guion y guion bajo; empieza y acaba en letra o número. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;

/** El usuario se compara sin mayúsculas ni espacios alrededor: `Mesero1 ` es `mesero1`. */
export const normalizeUsername = (username: string): string => username.trim().toLowerCase();

export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 8;
export const PIN_PATTERN = /^\d{6,8}$/;

/** Dominio del correo de relleno que Better Auth exige y que nunca se muestra. */
export const STAFF_EMAIL_DOMAIN = 'staff.invalid';
export const isStaffEmail = (email: string): boolean =>
  email.toLowerCase().endsWith(`@${STAFF_EMAIL_DOMAIN}`);

const isRun = (pin: string, step: 1 | -1): boolean =>
  [...pin].every((digit, index) => index === 0 || Number(digit) - Number(pin[index - 1]) === step);

/** Un bloque repetido que llena el PIN: `121212`, `123123`, `12341234`, `111111`. */
const isRepeatedBlock = (pin: string): boolean => {
  for (let size = 1; size <= pin.length / 2; size++) {
    if (pin.length % size === 0 && pin.slice(0, size).repeat(pin.length / size) === pin) {
      return true;
    }
  }
  return false;
};

/**
 * ¿Es un PIN fácil de adivinar? Todos los dígitos iguales, una escalera hacia arriba o hacia abajo
 * (`123456`, `987654`) o un bloque repetido (`121212`, `123123`).
 */
export function isWeakPin(pin: string): boolean {
  return isRepeatedBlock(pin) || isRun(pin, 1) || isRun(pin, -1);
}

/** Un dígito aleatorio uniforme: se descartan los bytes de 250 a 255 para no sesgar el 0–5. */
function randomDigit(): number {
  const byte = new Uint8Array(1);
  do globalThis.crypto.getRandomValues(byte);
  while ((byte[0] ?? 255) >= 250);
  return (byte[0] ?? 0) % 10;
}

/** Un PIN aleatorio de `length` dígitos (6 a 8) que no es débil. */
export function generatePin(length: number = MIN_PIN_LENGTH): string {
  if (!Number.isInteger(length) || length < MIN_PIN_LENGTH || length > MAX_PIN_LENGTH) {
    throw new RangeError(`A PIN has ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} digits.`);
  }
  for (;;) {
    const pin = Array.from({ length }, randomDigit).join('');
    if (!isWeakPin(pin)) return pin;
  }
}

/** Una cuenta de personal. Nunca contiene el hash del PIN. */
export interface StaffAccount {
  /** El usuario del sistema de identidad (Better Auth). */
  readonly userId: string;
  /** El lugar donde se creó: su compañía y, si se creó más abajo, su negocio y su sede. */
  readonly companyId: string;
  readonly businessId: string | null;
  readonly siteId: string | null;
  /** Normalizado (ver `normalizeUsername`); único dentro de su compañía. */
  readonly username: string;
  /** Intentos seguidos sin acierto desde el último acierto o el último bloqueo. */
  readonly failedAttempts: number;
  /** Bloqueada hasta esta fecha por demasiados intentos; `null` si no lo está. */
  readonly lockedUntil: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly pinChangedAt: Date;
}

/** Lo que guarda el almacén: la cuenta más el hash del PIN. */
export interface StoredStaffAccount extends StaffAccount {
  readonly pinHash: string;
}

/** El lugar de origen como alcance: la sede si la hay, si no el negocio, si no la compañía. */
export function homeScopeOf(
  account: Pick<StaffAccount, 'companyId' | 'businessId' | 'siteId'>,
): AssignmentScope {
  if (account.siteId !== null) return { type: 'site', id: account.siteId };
  if (account.businessId !== null) return { type: 'business', id: account.businessId };
  return { type: 'company', id: account.companyId };
}

/** La cuenta sin el hash del PIN, con los campos enumerados a propósito. */
export const withoutPin = (account: StoredStaffAccount): StaffAccount => ({
  userId: account.userId,
  companyId: account.companyId,
  businessId: account.businessId,
  siteId: account.siteId,
  username: account.username,
  failedAttempts: account.failedAttempts,
  lockedUntil: account.lockedUntil,
  createdBy: account.createdBy,
  createdAt: account.createdAt,
  pinChangedAt: account.pinChangedAt,
});
