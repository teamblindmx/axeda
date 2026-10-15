import { parsePermissionKey } from '../domain/permission-key.js';
import type { RequestMeta } from '../domain/role.js';
import { GLOBAL_SCOPE } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { AxedaStores } from '../ports/persistence.js';
import { runAudited, writeAudit, type AuditDraft } from './audit.js';
import { SUPER_ADMIN_ROLE_KEY, lockUsers, type Services } from './services.js';

export interface BootstrapInput extends RequestMeta {
  readonly userId: string;
}

export interface BootstrapResult {
  readonly roleId: string;
  readonly assignmentId: string;
}

const TOTAL = parsePermissionKey('*');

/** ¿Hay ya un administrador global vigente (función activa con el comodín total, en global)? */
async function hasGlobalAdministrator(stores: AxedaStores, services: Services): Promise<boolean> {
  const now = services.clock.now();
  let cursor: string | undefined;
  do {
    const page = await stores.assignments.listForScope(GLOBAL_SCOPE, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const live = page.items.filter(
      (assignment) => assignment.expiresAt === null || assignment.expiresAt > now,
    );
    const roles = await stores.roles.getMany([...new Set(live.map((item) => item.roleId))]);
    const admin = roles.some(
      (role) => role.status === 'active' && role.permissions.includes(TOTAL),
    );
    if (admin) return true;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return false;
}

/**
 * Crea el primer administrador global. Es una operación del **servidor** (no un endpoint):
 * quien puede ejecutarla ya controla el proceso. Sin contraseñas maestras.
 *
 * Se niega si ya existe un administrador global; si el último desaparece, vuelve a funcionar,
 * y esa es la vía de recuperación. Dos llamadas simultáneas no pueden crear dos: la primera
 * instrucción de la transacción sube la versión de política, que bloquea a la otra hasta que
 * la primera confirma, y entonces la otra ya ve al administrador.
 */
export async function bootstrapAdministrator(
  services: Services,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  await services.ready();
  const user = await services.users.find(input.userId);
  if (user === null) {
    throw new AxedaError('AXEDA_USER_NOT_FOUND', `User "${input.userId}" does not exist.`);
  }
  const draft: AuditDraft = {
    actorId: null,
    action: 'bootstrap',
    targetType: 'user',
    targetId: user.id,
    scope: GLOBAL_SCOPE,
    meta: input,
  };

  return runAudited(services.persistence, draft, async (stores) => {
    await stores.authz.bumpPolicyVersion();
    if (await hasGlobalAdministrator(stores, services)) {
      throw new AxedaError('AXEDA_ALREADY_BOOTSTRAPPED', 'A global administrator already exists.');
    }
    await lockUsers(stores, [user.id]);

    const existing = await stores.roles.getByKey(SUPER_ADMIN_ROLE_KEY);
    const role =
      existing ??
      (await stores.roles.create({
        key: SUPER_ADMIN_ROLE_KEY,
        name: 'Super administrator',
        description: 'Full access. Created by bootstrap.',
        permissions: [TOTAL],
        managed: true,
      }));
    if (role.status !== 'active' || !role.permissions.includes(TOTAL)) {
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        `The "${SUPER_ADMIN_ROLE_KEY}" role exists but is not an active role with "*". Fix or remove it before bootstrapping.`,
      );
    }

    const assignment = await stores.assignments.create({
      userId: user.id,
      roleId: role.id,
      scope: GLOBAL_SCOPE,
      grantedBy: null,
    });
    await writeAudit(
      stores,
      {
        ...draft,
        metadata: { roleId: role.id, assignmentId: assignment.id },
      },
      'success',
    );
    return { roleId: role.id, assignmentId: assignment.id };
  });
}
