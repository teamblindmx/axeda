export type ScopeType = 'global' | 'company' | 'business';

/** Alcance con el que se guarda una asignación. */
export type AssignmentScope =
  | { readonly type: 'global' }
  | { readonly type: 'company'; readonly id: string }
  | { readonly type: 'business'; readonly id: string };

/**
 * Lugar sobre el que se decide un permiso. Para un negocio, la compañía debe haberse
 * leído de la base de datos, nunca de lo que envíe el cliente (ADR-0004).
 */
export type TargetScope =
  | { readonly type: 'global' }
  | { readonly type: 'company'; readonly companyId: string }
  | { readonly type: 'business'; readonly companyId: string; readonly businessId: string };

export const GLOBAL_SCOPE: AssignmentScope = Object.freeze({ type: 'global' });

/**
 * Herencia hacia abajo: una asignación global vale en todas partes; la de compañía, en esa
 * compañía y en sus negocios; la de negocio, solo en ese negocio.
 */
export function assignmentApplies(assignment: AssignmentScope, target: TargetScope): boolean {
  switch (assignment.type) {
    case 'global':
      return true;
    case 'company':
      return target.type !== 'global' && target.companyId === assignment.id;
    case 'business':
      return target.type === 'business' && target.businessId === assignment.id;
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
