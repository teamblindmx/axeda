import type { DBAdapter } from '@better-auth/core/db/adapter';
import { APIError } from 'better-auth/api';
import type { PhoneNumberOptions } from 'better-auth/plugins';
import { AxedaError, E164_PATTERN } from '@teamblind/axeda-core';
import { isUniqueViolation } from './errors.js';
import { MODELS } from './schema.js';

/** Un número en formato E.164: `+`, el código de país y hasta 15 dígitos en total. */
export const E164 = E164_PATTERN;

/** El dominio reservado (RFC 2606) de los correos que se inventan para quien solo tiene teléfono. */
export const PHONE_EMAIL_DOMAIN = 'phone.invalid';

/** ¿Es un correo inventado para un usuario que se registró solo con su teléfono? */
export const isPhoneOnlyEmail = (email: string): boolean =>
  email.toLowerCase().endsWith(`@${PHONE_EMAIL_DOMAIN}`);

export interface SecurePhoneNumberInput {
  /** Envía el código por SMS (o WhatsApp…). Lo aporta tu aplicación: Axeda no envía mensajes. */
  readonly sendOTP: PhoneNumberOptions['sendOTP'];
  /** Códigos que se envían como mucho a un mismo número dentro de `sendWindowSeconds`. Por omisión 5. */
  readonly maxSendsPerNumber?: number;
  /** La ventana de ese límite, en segundos. Por omisión una hora. */
  readonly sendWindowSeconds?: number;
  /**
   * Con `true` (por omisión), el primer código verificado crea la cuenta y abre la sesión: registro e
   * inicio de sesión en un solo paso. Con `false`, solo puede entrar quien ya tiene ese número.
   */
  readonly signUpOnVerification?: boolean;
}

/** Lo que el ayudante fija del plugin `phoneNumber` de Better Auth. */
export type SecurePhoneNumberOptions = Pick<
  PhoneNumberOptions,
  | 'sendOTP'
  | 'otpLength'
  | 'expiresIn'
  | 'allowedAttempts'
  | 'phoneNumberValidator'
  | 'requireVerification'
  | 'signUpOnVerification'
>;

const DEFAULT_MAX_SENDS = 5;
const DEFAULT_WINDOW_SECONDS = 60 * 60;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AxedaError('AXEDA_INVALID_CONFIG', `${name} must be a positive whole number.`);
  }
  return value;
}

interface ThrottleRow {
  key: string;
  count: number;
  windowStartsAt: Date;
}

/**
 * Cuenta un envío para `key` en una ventana fija y devuelve cuántos lleva. Es atómico y vale entre
 * varias instancias: el incremento lleva la ventana como guarda, reiniciar una ventana vencida
 * también, y la primera fila depende del índice único de la clave.
 */
export async function countInWindow(
  adapter: DBAdapter,
  key: string,
  now: Date,
  windowMs: number,
  retried = false,
): Promise<number> {
  const model = MODELS.throttle;
  const opened = new Date(now.getTime() - windowMs);
  const live = await adapter.incrementOne<ThrottleRow>({
    model,
    where: [
      { field: 'key', value: key },
      { field: 'windowStartsAt', operator: 'gt', value: opened },
    ],
    increment: { count: 1 },
  });
  if (live) return live.count;
  // No hay ventana viva: se reinicia una vencida (solo una de dos peticiones a la vez lo logra)…
  const reset = await adapter.update<ThrottleRow>({
    model,
    where: [
      { field: 'key', value: key },
      { field: 'windowStartsAt', operator: 'lte', value: opened },
    ],
    update: { count: 1, windowStartsAt: now },
  });
  if (reset) return 1;
  // …o se crea la primera. Si otra petición la creó a la vez, se cuenta en la suya.
  try {
    await adapter.create<ThrottleRow>({ model, data: { key, count: 1, windowStartsAt: now } });
    return 1;
  } catch (error) {
    if (!isUniqueViolation(error) || retried) throw error;
    return countInWindow(adapter, key, now, windowMs, true);
  }
}

/**
 * Las opciones del plugin `phoneNumber` de Better Auth que Axeda recomienda:
 *
 * ```ts
 * import { phoneNumber } from 'better-auth/plugins';
 * plugins: [axedaPlugin, phoneNumber(securePhoneNumberOptions({ sendOTP: sms.send }))];
 * ```
 *
 * Código de 6 dígitos, válido 5 minutos y con 3 intentos; solo números en formato E.164; registro e
 * inicio de sesión en un paso, con un correo inventado de un dominio reservado para quien no tiene
 * correo; y un tope de envíos **por número** (Better Auth solo limita por IP), porque cada SMS cuesta
 * dinero y un atacante puede pedir códigos para números ajenos. Pasado el tope responde 429.
 */
export function securePhoneNumberOptions(input: SecurePhoneNumberInput): SecurePhoneNumberOptions {
  const maxSends = positiveInteger(input.maxSendsPerNumber, DEFAULT_MAX_SENDS, 'maxSendsPerNumber');
  const windowMs =
    positiveInteger(input.sendWindowSeconds, DEFAULT_WINDOW_SECONDS, 'sendWindowSeconds') * 1000;
  const send = input.sendOTP;

  return {
    otpLength: 6,
    expiresIn: 5 * 60,
    allowedAttempts: 3,
    phoneNumberValidator: (phoneNumber) => E164.test(phoneNumber),
    requireVerification: true,
    ...(input.signUpOnVerification === false
      ? {}
      : {
          signUpOnVerification: {
            getTempEmail: (phoneNumber) =>
              `${phoneNumber.replace(/\D/g, '')}@${PHONE_EMAIL_DOMAIN}`,
            getTempName: (phoneNumber) => phoneNumber,
          },
        }),
    async sendOTP(data, ctx) {
      // Sin el contexto no se puede contar: ante la duda, no se envía nada.
      if (ctx === undefined) {
        throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Cannot limit this send.' });
      }
      const sent = await countInWindow(
        ctx.context.adapter as unknown as DBAdapter,
        `phone-otp:${data.phoneNumber}`,
        new Date(),
        windowMs,
      );
      if (sent > maxSends) {
        throw new APIError('TOO_MANY_REQUESTS', {
          message: 'Too many codes for this number. Try again later.',
        });
      }
      await send(data, ctx);
    },
  };
}
