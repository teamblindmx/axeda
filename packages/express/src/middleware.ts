import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  AxedaError,
  isWildcard,
  parsePermissionKey,
  type Actor,
  type Axeda,
  type Principal,
  type ScopeFilter,
  type TargetScope,
} from '@axeda/core';
import { isCrossSiteWrite, trustedOriginSet } from './csrf.js';
import { globalScope, type RequestedScope, type ScopeResolver } from './scope.js';

/** Cómo se sabe quién hace la petición: recibe las cabeceras y da el `Principal`, o `null` sin sesión. */
export type PrincipalResolver = (request: {
  readonly headers: Headers;
}) => Promise<Principal | null>;

/** Lo que recibió el cliente. */
export type DeniedReason = 'unauthenticated' | 'forbidden' | 'not-found' | 'cross-site';

/**
 * Por qué se denegó. El cliente NO lo sabe (una compañía que no existe y un permiso que falta
 * reciben la misma respuesta); quien administra la aplicación sí, para su registro.
 */
export type DeniedDetail =
  | 'no-session'
  | 'cross-site-write'
  | 'missing-permission'
  | 'scope-not-found'
  | 'scope-mismatch'
  | 'malformed-scope';

/**
 * Una petición denegada. Solo lleva lo necesario para investigarla: nunca cookies, cabeceras,
 * la cadena de consulta ni el cuerpo. Los textos salen de la petición (están recortados): regístralos
 * como datos de un registro estructurado, no pegados dentro de una línea de texto.
 */
export interface DeniedEvent {
  /** Lo que recibió el cliente. */
  readonly reason: DeniedReason;
  /** El estado HTTP que recibió. */
  readonly status: number;
  /** El motivo exacto. */
  readonly detail: DeniedDetail;
  /** El permiso que exigía la ruta, si lo había. */
  readonly permission: string | null;
  readonly method: string;
  /** La ruta, sin la cadena de consulta. */
  readonly path: string;
  /** Quien llamaba, si se llegó a saber. */
  readonly userId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

interface BaseOptions {
  readonly axeda: Axeda;
  /** Con Better Auth: `sessionPrincipal(auth)` de `@axeda/better-auth`. */
  readonly principal: PrincipalResolver;
  /**
   * Se llama cada vez que el middleware deniega una petición, para que la aplicación la registre
   * (Axeda no escribe registros). Corre después de responder: **no puede cambiar la respuesta**, y
   * si lanza un error o rechaza la promesa, se ignora.
   */
  readonly onDenied?: (event: DeniedEvent) => void | Promise<void>;
}

/**
 * Defensa contra CSRF: las peticiones que cambian cosas y viajan con cookie deben venir de un
 * origen de confianza. Se exige decidir: lista los orígenes de tu front end o, si esta API nunca
 * se autentica con cookies, di `csrf: false`.
 */
export type AxedaExpressOptions = BaseOptions &
  (
    | { readonly trustedOrigins: readonly string[]; readonly csrf?: undefined }
    | { readonly csrf: false; readonly trustedOrigins?: undefined }
  );

export interface RequirePermissionOptions {
  /** Dónde se comprueba el permiso (ver `resolveScope`). Por defecto, en global. */
  readonly scope?: ScopeResolver;
  /**
   * Qué responder al que no puede. `forbidden` (403, por defecto) o `not-found` (404). La
   * respuesta es la misma si el recurso no existe o si existe pero no es tuyo: no revela nada.
   */
  readonly onDeny?: 'forbidden' | 'not-found';
}

export interface AxedaExpress {
  /** Exige una sesión. Sin ella, 401. Deja a quien llama disponible en `principalOf(req)`. */
  requireAuth(): RequestHandler;
  /**
   * Exige sesión y el permiso en el alcance de la ruta. Se deniega por defecto: sin sesión 401;
   * sin permiso (o con un alcance que no existe o no cuadra) 403, o 404 con `onDeny: 'not-found'`.
   */
  requirePermission(permission: string, options?: RequirePermissionOptions): RequestHandler;
  /** Quien hace la petición. Solo en rutas con `requireAuth()` o `requirePermission()` delante. */
  principalOf(request: Request): Actor;
  /** Alcances donde quien llama tiene el permiso, para filtrar tus consultas (T5). */
  scopeFilter(request: Request, permission: string): Promise<ScopeFilter>;
}

const REPLIES = {
  unauthenticated: [401, 'AXEDA_UNAUTHENTICATED', 'Sign in to continue.'],
  forbidden: [403, 'AXEDA_FORBIDDEN', 'You are not allowed to do that.'],
  notFound: [404, 'AXEDA_NOT_FOUND', 'Not found.'],
  crossSite: [403, 'AXEDA_CROSS_SITE', 'This request comes from an origin that is not trusted.'],
} as const;

type Reply = keyof typeof REPLIES;

const REASONS: Readonly<Record<Reply, DeniedReason>> = {
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  notFound: 'not-found',
  crossSite: 'cross-site',
};

const MAX_PATH = 512;
const MAX_USER_AGENT = 255;
const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

function deny(response: Response, reply: Reply): void {
  const [status, code, message] = REPLIES[reply];
  // Una respuesta de autorización nunca se guarda en cachés compartidas.
  response.status(status).set('Cache-Control', 'no-store').json({ code, message });
}

export function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/** Valida el permiso al declarar la ruta: un error tipográfico falla al arrancar, no en producción. */
function checkedPermission(axeda: Axeda, permission: string): string {
  const key = parsePermissionKey(permission);
  if (isWildcard(key)) {
    throw new AxedaError(
      'AXEDA_INVALID_PERMISSION',
      `"${permission}" is a wildcard; a route needs a concrete permission.`,
    );
  }
  if (!axeda.catalog.includes(key)) {
    throw new AxedaError(
      'AXEDA_UNKNOWN_PERMISSION',
      `"${permission}" is not in the permission catalog. Declare it in axeda({ permissions }).`,
    );
  }
  return permission;
}

type Resolution =
  | { readonly target: TargetScope }
  | { readonly detail: 'scope-not-found' | 'scope-mismatch' | 'malformed-scope' };

/** Del alcance pedido al lugar donde decidir, leyendo la base de datos. */
async function resolve(axeda: Axeda, requested: RequestedScope): Promise<Resolution> {
  if (requested.kind === 'invalid') return { detail: 'malformed-scope' };
  if (requested.kind === 'global') return { target: { type: 'global' } };
  const target = await axeda.resolveTarget(requested.scope);
  if (target === null) return { detail: 'scope-not-found' };
  // /companies/:companyId/businesses/:businessId — el negocio debe ser de esa compañía.
  if (
    requested.companyMustBe !== undefined &&
    (target.type !== 'business' || target.companyId !== requested.companyMustBe)
  ) {
    return { detail: 'scope-mismatch' };
  }
  return { target };
}

export function createAxedaExpress(options: AxedaExpressOptions): AxedaExpress {
  const { axeda } = options;
  const trusted = options.csrf === false ? null : trustedOriginSet(options.trustedOrigins);
  const known = new WeakMap<object, Actor>();

  /** Quién es, una sola vez por petición (varios middlewares seguidos no repiten la consulta). */
  async function authenticate(request: Request): Promise<Actor | null> {
    const existing = known.get(request);
    if (existing !== undefined) return existing;
    const principal = await options.principal({ headers: toHeaders(request.headers) });
    if (principal === null) return null;
    const actor: Actor = {
      ...principal,
      ip: request.ip,
      userAgent: request.get('user-agent'),
    };
    known.set(request, actor);
    return actor;
  }

  /** Corre `work` y, ante cualquier fallo, no deja pasar la petición: se entrega al manejador de errores. */
  const guarded =
    (work: (request: Request, response: Response) => Promise<boolean>): RequestHandler =>
    (request: Request, response: Response, next: NextFunction) => {
      work(request, response).then(
        (proceed) => (proceed ? next() : undefined),
        (error: unknown) => next(error),
      );
    };

  const crossSite = (request: Request): boolean =>
    trusted !== null && isCrossSiteWrite(request.method, request.headers, trusted);

  /** Avisa a la aplicación. Nunca cambia la respuesta ni la tumba: lo que falle aquí se ignora. */
  function report(
    request: Request,
    reply: Reply,
    detail: DeniedDetail,
    permission: string | null,
  ): void {
    const hook = options.onDenied;
    if (hook === undefined) return;
    const event: DeniedEvent = {
      reason: REASONS[reply],
      status: REPLIES[reply][0],
      detail,
      permission,
      method: request.method,
      path: clip(request.path, MAX_PATH),
      userId: known.get(request)?.userId ?? null,
      ip: request.ip ?? null,
      userAgent: clip(request.get('user-agent') ?? '', MAX_USER_AGENT) || null,
    };
    try {
      Promise.resolve(hook(event)).catch(() => undefined);
    } catch {
      // Un registro que falla no debe convertirse en un fallo de la ruta ni en una puerta abierta.
    }
  }

  function refuse(
    request: Request,
    response: Response,
    reply: Reply,
    detail: DeniedDetail,
    permission: string | null = null,
  ): false {
    deny(response, reply);
    report(request, reply, detail, permission);
    return false;
  }

  function principalOf(request: Request): Actor {
    const actor = known.get(request);
    if (actor === undefined) {
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        'principalOf() needs requireAuth() or requirePermission() earlier in the route.',
      );
    }
    return actor;
  }

  return {
    requireAuth: () =>
      guarded(async (request, response) => {
        if (crossSite(request)) return refuse(request, response, 'crossSite', 'cross-site-write');
        return (await authenticate(request)) === null
          ? refuse(request, response, 'unauthenticated', 'no-session')
          : true;
      }),

    requirePermission(permission, permissionOptions = {}) {
      const checked = checkedPermission(axeda, permission);
      const resolver = permissionOptions.scope ?? globalScope;
      const denied: Reply = permissionOptions.onDeny === 'not-found' ? 'notFound' : 'forbidden';
      return guarded(async (request, response) => {
        if (crossSite(request)) {
          return refuse(request, response, 'crossSite', 'cross-site-write', checked);
        }
        const actor = await authenticate(request);
        if (actor === null) {
          return refuse(request, response, 'unauthenticated', 'no-session', checked);
        }
        const resolution = await resolve(axeda, resolver(request));
        // Alcance inexistente, incoherente o sin permiso: la misma respuesta al cliente.
        if ('detail' in resolution) {
          return refuse(request, response, denied, resolution.detail, checked);
        }
        if (!(await axeda.can(actor, checked, resolution.target))) {
          return refuse(request, response, denied, 'missing-permission', checked);
        }
        return true;
      });
    },

    principalOf,

    scopeFilter: (request, permission) =>
      axeda.scopeFilter(principalOf(request), checkedPermission(axeda, permission)),
  };
}
