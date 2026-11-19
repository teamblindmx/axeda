import type { ResolvedFeature } from '../config/features.js';
import { AXEDA_PERMISSIONS } from '../domain/axeda-permissions.js';
import type { Actor } from '../domain/role.js';
import { GLOBAL_TARGET } from '../domain/scope.js';
import { AxedaError } from '../errors.js';
import type { CompanyFeature } from '../ports/features.js';
import { auditDenials, markDenied, writeAudit } from './audit.js';
import { actorPermissions, lockUsers, type Services } from './services.js';
import type { CompanyService } from './tenants.js';

/** Una funcionalidad tal como la ve una compañía. */
export interface CompanyFeatureState {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: boolean;
  /** `default` si vale el valor por omisión; `set` si la plataforma lo cambió. */
  readonly source: 'default' | 'set';
}

export interface FeatureService {
  /** Las funcionalidades declaradas y si esa compañía las tiene. Para quien ve la compañía. */
  list(actor: Actor, companyId: string): Promise<readonly CompanyFeatureState[]>;
  /** Solo la plataforma (`axeda:feature:manage` global). Lo audita e invalida las cachés. */
  set(
    actor: Actor,
    companyId: string,
    feature: string,
    enabled: boolean,
  ): Promise<CompanyFeatureState>;
}

const stateOf = (
  feature: ResolvedFeature,
  saved: CompanyFeature | undefined,
): CompanyFeatureState => ({
  key: feature.key,
  name: feature.name,
  description: feature.description,
  enabled: saved?.enabled ?? feature.enabledByDefault,
  source: saved === undefined ? 'default' : 'set',
});

export function createFeatureService(
  services: Services,
  companies: CompanyService,
): FeatureService {
  const { persistence, options } = services;

  function declared(feature: unknown): ResolvedFeature {
    const found = typeof feature === 'string' ? options.features.get(feature) : undefined;
    if (found === undefined) {
      throw new AxedaError(
        'AXEDA_INVALID_INPUT',
        `"${String(feature)}" is not a declared feature.`,
      );
    }
    return found;
  }

  async function statesOf(companyId: string): Promise<CompanyFeatureState[]> {
    const saved = await persistence.features.listForCompanies([companyId]);
    return [...options.features.values()].map((feature) =>
      stateOf(
        feature,
        saved.find((item) => item.feature === feature.key),
      ),
    );
  }

  return {
    async list(actor, companyId) {
      // Visibilidad de siempre: quien no ve la compañía recibe 404.
      await companies.get(actor, companyId);
      return statesOf(companyId);
    },

    async set(actor, companyId, feature, enabled) {
      await services.ready();
      const forbid = () =>
        markDenied(
          new AxedaError('AXEDA_FORBIDDEN', 'Only the platform can switch features.', {
            details: { reason: 'missing_feature_permission' },
          }),
        );
      const base = {
        actorId: actor.userId,
        action: 'feature.set' as const,
        targetType: 'company' as const,
        targetId: companyId,
        scope: { type: 'company' as const, id: companyId },
        meta: actor,
        metadata: { feature: String(feature), enabled },
      };
      return auditDenials(persistence, base, async () => {
        // Autorizar antes de validar: quien no administra la plataforma no averigua nada.
        const held = await actorPermissions(persistence, services, actor, GLOBAL_TARGET);
        if (!held.allows(AXEDA_PERMISSIONS.featureManage)) throw forbid();
        const definition = declared(feature);
        if (typeof enabled !== 'boolean') {
          throw new AxedaError('AXEDA_INVALID_INPUT', 'enabled must be true or false.');
        }
        if ((await persistence.companies.get(companyId)) === null) {
          throw new AxedaError('AXEDA_COMPANY_NOT_FOUND', `Company "${companyId}" does not exist.`);
        }
        const saved = await persistence.transaction(async (stores) => {
          const fresh = await actorPermissions(stores, services, actor, GLOBAL_TARGET);
          if (!fresh.allows(AXEDA_PERMISSIONS.featureManage)) throw forbid();
          await lockUsers(stores, [actor.userId]);
          // Cambia lo que vale en esa compañía para todos: ninguna caché puede servir lo anterior.
          await stores.authz.bumpPolicyVersion();
          const result = await stores.features.set({
            companyId,
            feature: definition.key,
            enabled,
            updatedBy: actor.userId,
          });
          await writeAudit(stores, base, 'success');
          return result;
        });
        return stateOf(definition, saved);
      });
    },
  };
}

/** ¿Tiene esa compañía la funcionalidad? Para el servidor: no comprueba a nadie. */
export async function hasFeature(
  services: Services,
  companyId: string,
  feature: string,
): Promise<boolean> {
  await services.ready();
  const definition = services.options.features.get(feature);
  if (definition === undefined) {
    throw new AxedaError('AXEDA_INVALID_INPUT', `"${feature}" is not a declared feature.`);
  }
  const [saved] = (await services.persistence.features.listForCompanies([companyId])).filter(
    (item) => item.feature === feature,
  );
  return saved?.enabled ?? definition.enabledByDefault;
}
