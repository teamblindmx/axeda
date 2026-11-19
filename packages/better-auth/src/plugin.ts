import type { BetterAuthPlugin } from '@better-auth/core';
import {
  AxedaError,
  createAxeda,
  isBanned,
  type Axeda,
  type AxedaOptions,
  type AxedaPersistence,
  type Clock,
  type ImageProcessor,
  type InvitationMessage,
  type ObjectStorage,
  rejectUnknownOptions,
} from '@teamblind/axeda-core';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { createEndpoints } from './endpoints.js';
import { createUserEndpoints } from './endpoints-users.js';
import { createImageEndpoints } from './endpoints-images.js';
import { createStaffEndpoints } from './endpoints-staff.js';
import { createFeatureEndpoints } from './endpoints-features.js';
import {
  createInvitationEndpoints,
  createSiteEndpoints,
  createPublicEndpoints,
  createTenantEndpoints,
} from './endpoints-tenants.js';
import { axedaSchema } from './schema.js';
import { cappedExpiry, resolveMaxSessionAge, sessionBeingRefreshed } from './session-lifetime.js';
import { createBetterAuthPersistence } from './stores.js';
import { createBetterAuthUserAdmin } from './user-admin.js';
import { createBetterAuthPinHasher } from './pin-hasher.js';
import { createBetterAuthUserDirectory } from './users.js';

/** Cómo hacer llegar una invitación. Sin esto las invitaciones están desactivadas. */
export interface InvitationDeliveryOptions {
  /**
   * El enlace de aceptación a partir del secreto. Lo construye la aplicación con su URL base
   * configurada: nunca debe salir de la cabecera `Host` de una petición.
   */
  readonly acceptUrl: (token: string) => string;
  /**
   * Envía la invitación: un correo a `email`, o un SMS a `phoneNumber` si `channel` es `phone`.
   * Recibe datos, no HTML: escapa lo que muestres.
   */
  readonly send: (message: InvitationMessage & { readonly link: string }) => Promise<void>;
}

export interface AxedaPluginOptions extends AxedaOptions {
  /** Solo para pruebas. */
  readonly clock?: Clock;
  /** Cómo enviar las invitaciones. Sin esto están desactivadas. */
  readonly invitationDelivery?: InvitationDeliveryOptions;
  /**
   * Publica `GET /axeda/public/identity` (nombre y logos de una compañía o negocio activo, sin
   * sesión). Desactivado por defecto: es el único endpoint que no exige iniciar sesión.
   */
  readonly publicIdentity?: boolean;
  /**
   * La vida máxima de una sesión, en segundos, contada desde que se abrió. Better Auth renueva la
   * sesión mientras se usa (`session.expiresIn` es el tiempo sin actividad), así que sin esto una
   * sesión usada a diario no caducaría nunca. Pasado este tiempo hay que volver a iniciar sesión.
   * Por defecto 30 días; `false` lo desactiva.
   */
  readonly maxSessionAge?: number | false;
  /**
   * Dónde se guardan logos, favicons y fotos de perfil (Cloudflare R2, S3, MinIO…; ver
   * `s3Storage()` de `@teamblind/axeda-storage`). Sin esto los endpoints `/axeda/image/*`
   * responden `AXEDA_FEATURE_DISABLED`.
   */
  readonly storage?: ObjectStorage;
  /** Recodifica cada imagen al completarla (p. ej. `sharpImageProcessor()`). Opcional. */
  readonly imageProcessor?: ImageProcessor;
}

/**
 * Las opciones que existen. El `satisfies` obliga a tenerlas todas y solo esas: una opción nueva
 * que no se añada aquí no compila.
 */
const PLUGIN_OPTIONS = Object.keys({
  permissions: true,
  roles: true,
  menus: true,
  retention: true,
  invitations: true,
  limits: true,
  images: true,
  staff: true,
  features: true,
  clock: true,
  invitationDelivery: true,
  publicIdentity: true,
  maxSessionAge: true,
  storage: true,
  imageProcessor: true,
} satisfies Record<keyof AxedaPluginOptions, true>);

const DELIVERY_OPTIONS = Object.keys({
  acceptUrl: true,
  send: true,
} satisfies Record<keyof InvitationDeliveryOptions, true>);

interface BanRow {
  banned?: boolean | null;
  banExpires?: Date | string | null;
}

/** Las opciones del núcleo: todo menos lo que es propio del plugin (reloj, envío, identidad pública). */
function coreOptions(options: AxedaPluginOptions): AxedaOptions {
  return {
    permissions: options.permissions,
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    ...(options.invitations === undefined ? {} : { invitations: options.invitations }),
    ...(options.menus === undefined ? {} : { menus: options.menus }),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.staff === undefined ? {} : { staff: options.staff }),
    ...(options.features === undefined ? {} : { features: options.features }),
  };
}

/**
 * Opciones de Better Auth con las que Axeda se niega a arrancar. Cada una anula algo que protege
 * a los endpoints `/axeda/*` (todos con cookie de sesión) o a la propia autorización.
 */
const UNSAFE_AUTH_OPTIONS: ReadonlyArray<{
  readonly path: readonly string[];
  readonly why: string;
}> = [
  {
    // La caché de cookie de sesión haría que `authzVersion` llegue desactualizado y que una
    // sesión revocada siga siendo válida.
    path: ['session', 'cookieCache', 'enabled'],
    why: 'a revoked session or a changed permission would stay valid until the cookie expires.',
  },
  {
    path: ['advanced', 'disableCSRFCheck'],
    why: 'every /axeda/* endpoint is authenticated by a cookie and would be open to cross-site requests.',
  },
  {
    path: ['advanced', 'disableOriginCheck'],
    why: 'callback and redirect URLs would no longer be validated against trustedOrigins.',
  },
  {
    path: ['advanced', 'ipAddress', 'disableIpTracking'],
    why: 'rate limits and the audit log depend on the client address.',
  },
];

function assertSafeAuthOptions(options: object): void {
  for (const { path, why } of UNSAFE_AUTH_OPTIONS) {
    const value = path.reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      options,
    );
    if (value === true) {
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        `Axeda cannot run with ${path.join('.')}: ${why} Remove the option.`,
      );
    }
  }
}

/** Límites de peticiones por IP y minuto de los endpoints de administración. */
const RATE_LIMITS = [
  // El único endpoint sin sesión, más estricto (T10: enumeración).
  { pathMatcher: (path: string) => path.startsWith('/axeda/public/'), max: 30, window: 60 },
  // Entrar con PIN: además del bloqueo por cuenta, pocos intentos por dirección (T4: fuerza bruta).
  { pathMatcher: (path: string) => path === '/axeda/staff/sign-in', max: 10, window: 60 },
  { pathMatcher: (path: string) => path.startsWith('/axeda/'), max: 120, window: 60 },
];

/**
 * Plugin de Axeda para Better Auth: esquema, endpoints `/axeda/*`, el hook de borrado de usuario
 * y la conexión de la persistencia de Axeda al adaptador de base de datos de Better Auth.
 *
 * ```ts
 * const axedaPlugin = axeda({ permissions: ['invoice:read'], roles: { viewer: ['invoice:read'] } });
 * const auth = betterAuth({ plugins: [axedaPlugin] });
 * await axedaPlugin.start(); // tras migrar la base de datos
 * ```
 */
export function axeda(options: AxedaPluginOptions) {
  // Una opción mal escrita no puede apagar algo en silencio.
  rejectUnknownOptions('axeda()', options, PLUGIN_OPTIONS);
  rejectUnknownOptions(
    'axeda({ invitationDelivery })',
    options.invitationDelivery,
    DELIVERY_OPTIONS,
  );
  const maxSessionAge = resolveMaxSessionAge(options.maxSessionAge);
  let core: Axeda | undefined;
  let persistence: AxedaPersistence | undefined;

  const instance = (): Axeda => {
    if (core === undefined) {
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        'Axeda is not initialised yet: create the Better Auth instance with this plugin first.',
      );
    }
    return core;
  };

  const plugin = {
    id: 'axeda',
    schema: axedaSchema,
    endpoints: {
      ...createEndpoints(instance),
      ...createTenantEndpoints(instance),
      ...createSiteEndpoints(instance),
      ...createInvitationEndpoints(instance),
      ...createUserEndpoints(instance),
      ...createImageEndpoints(instance),
      ...createStaffEndpoints(instance),
      ...createFeatureEndpoints(instance),
      // Siempre registrado (los tipos del cliente no dependen de la configuración); si está
      // desactivado responde 404, igual que una compañía que no existe.
      ...createPublicEndpoints(instance, () => options.publicIdentity === true),
    },
    rateLimit: RATE_LIMITS,
    hooks: {
      after: [
        {
          // Todo lo que contesta Axeda (permisos, usuarios, auditoría, invitaciones) es de una
          // persona concreta: ni el navegador ni una caché intermedia deben guardarlo (ASVS V14.3.2).
          // También las respuestas de error.
          matcher: (context) => context.path?.startsWith('/axeda/') === true,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.setHeader('Cache-Control', 'no-store');
          }),
        },
      ],
    },
    init(ctx) {
      assertSafeAuthOptions(ctx.options);
      const stores = createBetterAuthPersistence(ctx.adapter, {
        ...(options.clock === undefined ? {} : { now: () => options.clock?.now() ?? new Date() }),
      });
      persistence = stores;
      const { clock, invitationDelivery, storage, imageProcessor } = options;
      const clockOption = clock === undefined ? {} : { now: () => clock.now() };
      core = createAxeda(coreOptions(options), {
        persistence: stores,
        users: createBetterAuthUserDirectory(ctx.adapter, clockOption),
        userAdmin: createBetterAuthUserAdmin(ctx, clockOption),
        ...(clock === undefined ? {} : { clock }),
        ...(storage === undefined ? {} : { storage }),
        ...(imageProcessor === undefined ? {} : { imageProcessor }),
        // El PIN del personal: el hash de contraseñas de Better Auth con una clave de su `secret`.
        pinHasher: createBetterAuthPinHasher(ctx),
        ...(invitationDelivery === undefined
          ? {}
          : {
              invitations: {
                send: (message) =>
                  invitationDelivery.send({
                    ...message,
                    link: invitationDelivery.acceptUrl(message.token),
                  }),
              },
            }),
      });

      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                // Un usuario bloqueado no puede abrir sesión (las que tenía se cerraron al bloquearlo).
                // Se consulta con `internalAdapter`, que usa la transacción en curso: Better Auth abre
                // sesión DENTRO de la transacción del registro, y con el adaptador raíz la consulta
                // esperaría para siempre a una conexión que la propia transacción tiene tomada.
                before: async (session: { userId: string }) => {
                  const row = (await ctx.internalAdapter.findUserById(
                    session.userId,
                  )) as BanRow | null;
                  const now = clock?.now() ?? new Date();
                  const banExpires = row?.banExpires ? new Date(row.banExpires) : null;
                  if (row !== null && isBanned({ banned: row.banned === true, banExpires }, now)) {
                    throw new APIError('FORBIDDEN', {
                      code: 'AXEDA_USER_BANNED',
                      message: 'This account is suspended.',
                    });
                  }
                  // La vida máxima también recorta la sesión que nace (p. ej. si es menor que
                  // `session.expiresIn`).
                  const expiresAt =
                    maxSessionAge === undefined
                      ? undefined
                      : cappedExpiry(
                          (session as { expiresAt?: unknown }).expiresAt,
                          (session as { createdAt?: unknown }).createdAt ?? new Date(),
                          maxSessionAge,
                        );
                  return expiresAt === undefined ? undefined : { data: { expiresAt } };
                },
              },
              update: {
                // Better Auth renueva la sesión moviendo su caducidad hacia delante cada vez que
                // se usa. Aquí se recorta para que nunca pase de su creación más la vida máxima, y
                // su propia caducidad hace el resto, en sus endpoints y en tus rutas.
                before: (session: { expiresAt?: unknown }, context: unknown) => {
                  const current = sessionBeingRefreshed(context);
                  const expiresAt =
                    maxSessionAge === undefined || current === undefined
                      ? undefined
                      : cappedExpiry(session.expiresAt, current.createdAt, maxSessionAge);
                  return Promise.resolve(
                    expiresAt === undefined ? undefined : { data: { expiresAt } },
                  );
                },
              },
            },
            user: {
              delete: {
                // Las claves foráneas ya lo hacen en SQL; MongoDB no las tiene. Se deja constancia.
                after: async (user: { id: string }) => {
                  await stores.assignments.deleteForUser(user.id);
                  // Su cuenta de personal, si la tenía (en SQL ya la borra la clave foránea).
                  await stores.staff.delete(user.id);
                  // Su foto de perfil: el registro y el objeto. Un fallo del almacén no impide el
                  // borrado del usuario; el objeto queda huérfano, sin nadie que lo enlace.
                  await core?.images.forgetUser(user.id).catch(() => 0);
                  await stores.audit.append({
                    actorId: null,
                    action: 'user.delete',
                    targetType: 'user',
                    targetId: user.id,
                    scope: null,
                    outcome: 'success',
                    ip: null,
                    userAgent: null,
                    metadata: {},
                  });
                },
              },
            },
          },
        },
      };
    },
  } satisfies BetterAuthPlugin;

  return Object.assign(plugin, {
    /** El núcleo de Axeda (`can`, `scopesFor`, `bootstrap`…). Disponible tras crear Better Auth. */
    instance,
    /** Comprueba la base de datos y sincroniza las funciones declaradas. Llamar tras migrar. */
    start: (): Promise<void> => instance().start(),
    /** La persistencia, para herramientas de la propia aplicación. */
    persistence: (): AxedaPersistence => {
      if (persistence === undefined)
        throw new AxedaError('AXEDA_INVALID_CONFIG', 'Not initialised.');
      return persistence;
    },
  });
}

export type AxedaPlugin = ReturnType<typeof axeda>;
