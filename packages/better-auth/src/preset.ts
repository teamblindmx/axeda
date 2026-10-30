import type { BetterAuthOptions } from '@better-auth/core';
import { AxedaError } from '@teamblind/axeda-core';

export interface SecureAuthInput {
  /** URL pública del servidor de autenticación. En producción, `https`. */
  readonly baseURL: string;
  /** Secreto de Better Auth: al menos 32 caracteres, aleatorio (p. ej. `openssl rand -base64 48`). */
  readonly secret: string;
  /**
   * Orígenes (`https://app.example.com`) desde los que se permiten peticiones con cookie y a los
   * que se puede redirigir. Sin comodines ni rutas. El `baseURL` ya cuenta como de confianza.
   */
  readonly trustedOrigins: readonly string[];
  /** `production` (por defecto) exige `https` y cookies `Secure`. `development` admite `localhost`. */
  readonly environment?: 'production' | 'development';
  /**
   * IPs o rangos CIDR de los proxies que tienes delante. Sin ellos solo se confía en una
   * cabecera `X-Forwarded-For` de un único valor: una cadena la puede falsificar el cliente y
   * evadir los límites de peticiones.
   */
  readonly trustedProxies?: readonly string[];
  /**
   * Dónde llevar la cuenta de los límites. `memory` (por defecto) es por proceso: con varias
   * instancias, el límite efectivo se multiplica. Con varias instancias usa `database`.
   */
  readonly rateLimitStorage?: 'memory' | 'database' | 'secondary-storage';
  /**
   * Exige correo verificado para iniciar sesión (por defecto sí). Las invitaciones de Axeda solo
   * las acepta quien tiene el correo verificado; desactivarlo solo tiene sentido en desarrollo.
   * Con esto activo tu aplicación debe configurar `emailVerification.sendVerificationEmail`.
   */
  readonly requireEmailVerification?: boolean;
}

/** La parte de la configuración de Better Auth que fija el preset. */
export interface SecureAuthOptions {
  readonly baseURL: string;
  readonly secret: string;
  readonly trustedOrigins: string[];
  readonly emailAndPassword: NonNullable<BetterAuthOptions['emailAndPassword']>;
  readonly session: NonNullable<BetterAuthOptions['session']>;
  readonly advanced: NonNullable<BetterAuthOptions['advanced']>;
  readonly rateLimit: NonNullable<BetterAuthOptions['rateLimit']>;
}

const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARACTERS = 8;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const DAY = 60 * 60 * 24;

function invalid(message: string): never {
  throw new AxedaError('AXEDA_INVALID_CONFIG', message);
}

function parseUrl(raw: string, label: string): URL {
  try {
    return new URL(raw);
  } catch {
    return invalid(`${label} "${raw}" is not a valid URL.`);
  }
}

/** Un origen es solo esquema, servidor y puerto: sin ruta, consulta, fragmento ni credenciales. */
function assertPlainOrigin(url: URL, raw: string, label: string): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    invalid(`${label} "${raw}" must use http or https.`);
  }
  const hasPath = url.pathname !== '/' || url.search !== '' || url.hash !== '';
  if (hasPath || url.username !== '' || url.password !== '') {
    invalid(`${label} "${raw}" must be just an origin (scheme, host and optional port).`);
  }
}

function assertTransport(url: URL, raw: string, label: string, production: boolean): void {
  if (url.protocol === 'https:') return;
  if (production || !LOCAL_HOSTS.has(url.hostname)) {
    invalid(
      `${label} "${raw}" must use https${production ? '' : ' (http is only for localhost)'}.`,
    );
  }
}

function parseOrigin(raw: string, production: boolean, label: string): string {
  if (raw.includes('*')) invalid(`${label} "${raw}" has a wildcard; list each origin explicitly.`);
  const url = parseUrl(raw, label);
  assertPlainOrigin(url, raw, label);
  assertTransport(url, raw, label, production);
  return url.origin;
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    invalid(`The secret must have at least ${MIN_SECRET_LENGTH} characters.`);
  }
  if (new Set(secret).size < MIN_DISTINCT_CHARACTERS) {
    invalid('The secret is too repetitive; generate a random one (openssl rand -base64 48).');
  }
}

function trustedOriginList(input: SecureAuthInput, production: boolean): string[] {
  // El `baseURL` puede llevar ruta (p. ej. `/api/auth`); solo se valida su origen.
  parseOrigin(parseUrl(input.baseURL, 'baseURL').origin, production, 'baseURL');
  if (input.trustedOrigins.length === 0) {
    invalid('List at least one trusted origin (the front end that will call the API).');
  }
  const origins = input.trustedOrigins.map((origin) =>
    parseOrigin(origin, production, 'trustedOrigins entry'),
  );
  return [...new Set(origins)];
}

/**
 * La configuración de Better Auth que Axeda recomienda, lista para extender:
 *
 * ```ts
 * betterAuth({
 *   ...secureAuthOptions({ baseURL, secret, trustedOrigins: ['https://app.example.com'] }),
 *   database,
 *   plugins: [axedaPlugin],
 * });
 * ```
 *
 * Fija orígenes de confianza explícitos, cookies `HttpOnly`/`SameSite=Lax`/`Secure`, sesiones de
 * 7 días, contraseñas de 12 a 128 caracteres, correo verificado, sesiones cerradas al restablecer
 * la contraseña y límites de peticiones más estrictos en el inicio de sesión y el registro.
 * **Se niega a devolver** una configuración débil: un secreto corto o repetitivo, orígenes con
 * comodín o sin `https` en producción.
 *
 * No añade plugins (2FA, passkeys…): las funciones que exigen 2FA (`requireMfa`) necesitan el
 * plugin `twoFactor` de Better Auth, y conviene desactivar «confiar en este dispositivo» en las
 * cuentas administrativas (ver la guía de seguridad).
 */
export function secureAuthOptions(input: SecureAuthInput): SecureAuthOptions {
  const production = (input.environment ?? 'production') === 'production';
  const requireEmailVerification = input.requireEmailVerification ?? true;
  assertSecret(input.secret);
  const trustedOrigins = trustedOriginList(input, production);
  if (!requireEmailVerification && production) {
    invalid(
      'requireEmailVerification: false is only for development: invitations rely on verified emails.',
    );
  }
  const proxies = input.trustedProxies ?? [];

  return {
    baseURL: input.baseURL,
    secret: input.secret,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      autoSignIn: !requireEmailVerification,
    },
    session: {
      expiresIn: 7 * DAY,
      updateAge: DAY,
      freshAge: 15 * 60,
      // Axeda no arranca con la caché de cookie activa (revocaciones tardías).
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: production,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: production },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ...(proxies.length === 0 ? {} : { ipAddress: { trustedProxies: [...proxies] } }),
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: input.rateLimitStorage ?? 'memory',
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 300, max: 5 },
        '/request-password-reset': { window: 300, max: 3 },
        '/reset-password': { window: 300, max: 5 },
        '/send-verification-email': { window: 300, max: 3 },
        '/two-factor/verify-totp': { window: 60, max: 5 },
      },
    },
  };
}
