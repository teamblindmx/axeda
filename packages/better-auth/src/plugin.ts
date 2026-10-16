import type { BetterAuthPlugin } from '@better-auth/core';
import {
  AxedaError,
  createAxeda,
  type Axeda,
  type AxedaOptions,
  type AxedaPersistence,
  type Clock,
  type InvitationMessage,
} from '@axeda/core';
import { createEndpoints } from './endpoints.js';
import {
  createInvitationEndpoints,
  createPublicEndpoints,
  createTenantEndpoints,
} from './endpoints-tenants.js';
import { axedaSchema } from './schema.js';
import { createBetterAuthPersistence } from './stores.js';
import { createBetterAuthUserDirectory } from './users.js';

/** Cómo hacer llegar una invitación. Sin esto las invitaciones están desactivadas. */
export interface InvitationDeliveryOptions {
  /**
   * El enlace de aceptación a partir del secreto. Lo construye la aplicación con su URL base
   * configurada: nunca debe salir de la cabecera `Host` de una petición.
   */
  readonly acceptUrl: (token: string) => string;
  /** Envía el correo. Recibe datos, no HTML: escapa lo que muestres. */
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
}

/** Las opciones del núcleo: todo menos lo que es propio del plugin (reloj, envío, identidad pública). */
function coreOptions(options: AxedaPluginOptions): AxedaOptions {
  return {
    permissions: options.permissions,
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    ...(options.invitations === undefined ? {} : { invitations: options.invitations }),
  };
}

/** Límites de peticiones por IP y minuto de los endpoints de administración. */
const RATE_LIMITS = [
  // El único endpoint sin sesión, más estricto (T10: enumeración).
  { pathMatcher: (path: string) => path.startsWith('/axeda/public/'), max: 30, window: 60 },
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
      ...createInvitationEndpoints(instance),
      // Siempre registrado (los tipos del cliente no dependen de la configuración); si está
      // desactivado responde 404, igual que una compañía que no existe.
      ...createPublicEndpoints(instance, () => options.publicIdentity === true),
    },
    rateLimit: RATE_LIMITS,
    init(ctx) {
      // La caché de cookie de sesión haría que `authzVersion` llegue desactualizado y que una
      // sesión revocada siga siendo válida (ADR-0005, ADR-0009): Axeda no arranca con ella.
      if (ctx.options.session?.cookieCache?.enabled === true) {
        throw new AxedaError(
          'AXEDA_INVALID_CONFIG',
          'Axeda cannot run with session.cookieCache enabled: a revoked session or a changed ' +
            'permission would stay valid until the cookie expires. Disable it.',
        );
      }
      const stores = createBetterAuthPersistence(ctx.adapter, {
        ...(options.clock === undefined ? {} : { now: () => options.clock?.now() ?? new Date() }),
      });
      persistence = stores;
      const { clock, invitationDelivery } = options;
      core = createAxeda(coreOptions(options), {
        persistence: stores,
        users: createBetterAuthUserDirectory(ctx.adapter),
        ...(clock === undefined ? {} : { clock }),
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
            user: {
              delete: {
                // Las claves foráneas ya lo hacen en SQL; MongoDB no las tiene. Se deja constancia.
                after: async (user: { id: string }) => {
                  await stores.assignments.deleteForUser(user.id);
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
