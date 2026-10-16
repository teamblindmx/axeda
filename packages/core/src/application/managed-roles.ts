import type { ResolvedRoleDefinition } from '../config/options.js';
import type { Role } from '../domain/role.js';
import { GLOBAL_SCOPE } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { AxedaStores } from '../ports/persistence.js';
import { writeAudit } from './audit.js';
import { SUPER_ADMIN_ROLE_KEY, type Services } from './services.js';

type Change =
  | { readonly kind: 'create'; readonly definition: ResolvedRoleDefinition }
  | { readonly kind: 'update'; readonly role: Role; readonly definition: ResolvedRoleDefinition }
  | { readonly kind: 'deactivate'; readonly role: Role };

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item) => b.includes(item));

/** ¿La función guardada ya coincide con lo declarado en el código? */
const isCurrent = (role: Role, definition: ResolvedRoleDefinition): boolean =>
  role.status === 'active' &&
  role.name === definition.name &&
  role.description === definition.description &&
  role.requireMfa === definition.requireMfa &&
  sameSet(role.permissions, definition.permissions);

async function readAllRoles(stores: AxedaStores): Promise<Role[]> {
  const all: Role[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.roles.list({
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/** Diferencias entre las funciones declaradas en el código y las guardadas. */
function planChanges(
  declared: ReadonlyMap<string, ResolvedRoleDefinition>,
  stored: Role[],
): Change[] {
  const byKey = new Map(stored.map((role) => [role.key, role]));
  const changes: Change[] = [];

  for (const definition of declared.values()) {
    const role = byKey.get(definition.key);
    if (role === undefined) {
      changes.push({ kind: 'create', definition });
    } else if (!role.managed) {
      // Una función creada a mano con la clave de una declarada en el código: no se pisa.
      throw new AxedaError(
        'AXEDA_INVALID_CONFIG',
        `Role "${definition.key}" is declared in code but a runtime role with that key already exists. Rename or delete one of them.`,
      );
    } else if (!isCurrent(role, definition)) {
      changes.push({ kind: 'update', role, definition });
    }
  }
  for (const role of stored) {
    const orphan = role.managed && role.status === 'active' && !declared.has(role.key);
    // Una función quitada del código deja de conceder (fail-safe); no se borra por si fue un error.
    if (orphan && role.key !== SUPER_ADMIN_ROLE_KEY) changes.push({ kind: 'deactivate', role });
  }
  return changes;
}

async function apply(stores: AxedaStores, change: Change): Promise<void> {
  const audit = (targetId: string, metadata: Record<string, unknown>) =>
    writeAudit(
      stores,
      {
        actorId: null,
        action: 'role.sync',
        targetType: 'role',
        targetId,
        scope: GLOBAL_SCOPE,
        metadata,
      },
      'success',
    );

  if (change.kind === 'create') {
    const { definition } = change;
    const role = await stores.roles.create({ ...definition, managed: true });
    await audit(role.id, { key: role.key, change: 'create' });
  } else if (change.kind === 'update') {
    const { definition, role } = change;
    await stores.roles.update(role.id, role.version, {
      name: definition.name,
      description: definition.description,
      permissions: definition.permissions,
      requireMfa: definition.requireMfa,
      status: 'active',
    });
    await audit(role.id, { key: role.key, change: 'update' });
  } else {
    await stores.roles.update(change.role.id, change.role.version, { status: 'inactive' });
    await audit(change.role.id, { key: change.role.key, change: 'deactivate' });
  }
}

/**
 * Deja las funciones guardadas como `managed` iguales a las declaradas en `createAxeda({ roles })`.
 *
 * Lo normal es que no haya nada que hacer (una lectura). Si hay cambios, se hacen en una
 * transacción cuya primera instrucción sube la versión de política: eso serializa a varias
 * instancias que arrancan a la vez, y la segunda, al releer, ya lo encuentra aplicado.
 */
export async function syncManagedRoles(services: Services): Promise<void> {
  const { persistence, options } = services;
  if (planChanges(options.roles, await readAllRoles(persistence)).length === 0) return;

  await persistence.transaction(async (stores) => {
    await stores.authz.bumpPolicyVersion();
    const changes = planChanges(options.roles, await readAllRoles(stores));
    for (const change of changes) await apply(stores, change);
  });
}
