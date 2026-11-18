export type ScopeType = 'global' | 'company' | 'business' | 'site';

/** Alcance con el que se guarda una asignación. */
export type AssignmentScope =
  | { readonly type: 'global' }
  | { readonly type: 'company'; readonly id: string }
  | { readonly type: 'business'; readonly id: string }
  | { readonly type: 'site'; readonly id: string };

/**
 * Lugar sobre el que se decide un permiso. Para un negocio o una sede, la compañía (y el negocio
 * de la sede) deben haberse leído de la base de datos, nunca de lo que envíe el cliente.
 */
export type TargetScope =
  | { readonly type: 'global' }
  | { readonly type: 'company'; readonly companyId: string }
  | { readonly type: 'business'; readonly companyId: string; readonly businessId: string }
  | {
      readonly type: 'site';
      readonly companyId: string;
      /** El negocio del que cuelga la sede, o `null` si cuelga directamente de la compañía. */
      readonly businessId: string | null;
      readonly siteId: string;
    };

export const GLOBAL_SCOPE: AssignmentScope = Object.freeze({ type: 'global' });

/**
 * Herencia hacia abajo: una asignación global vale en todas partes; la de compañía, en esa
 * compañía, en sus negocios y en todas sus sedes; la de negocio, en ese negocio y en sus sedes;
 * la de sede, solo en esa sede. Una sede sin negocio no hereda de ningún negocio.
 */
export function assignmentApplies(assignment: AssignmentScope, target: TargetScope): boolean {
  switch (assignment.type) {
    case 'global':
      return true;
    case 'company':
      return target.type !== 'global' && target.companyId === assignment.id;
    case 'business':
      return (
        (target.type === 'business' || target.type === 'site') &&
        target.businessId === assignment.id
      );
    case 'site':
      return target.type === 'site' && target.siteId === assignment.id;
  }
}

/** Clave estable de un alcance (para comparar y para el índice único de asignaciones). */
export function scopeKey(scope: AssignmentScope): string {
  return scope.type === 'global' ? 'global' : `${scope.type}:${scope.id}`;
}

export function sameAssignmentScope(a: AssignmentScope, b: AssignmentScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** Objetivo global, para comprobaciones que no pertenecen a una compañía ni a un negocio. */
export const GLOBAL_TARGET: TargetScope = Object.freeze({ type: 'global' });

/**
 * ¿Contiene `container` a `inner`? (un alcance es la herencia hacia abajo de otro). Un alcance de
 * compañía contiene a los negocios y a las sedes de esa compañía, y uno de negocio a las sedes de
 * ese negocio, pero eso exige saber de quién es `inner`: `companyOfInner` y `businessOfInner` lo
 * aportan cuando se conoce (si no, solo se compara por igualdad).
 */
export function scopeContains(
  container: AssignmentScope,
  inner: AssignmentScope,
  companyOfInner?: string,
  businessOfInner?: string | null,
): boolean {
  if (container.type === 'global') return true;
  if (scopeKey(container) === scopeKey(inner)) return true;
  if (inner.type !== 'business' && inner.type !== 'site') return false;
  if (container.type === 'company') return companyOfInner === container.id;
  return container.type === 'business' && inner.type === 'site' && businessOfInner === container.id;
}
