import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SCOPE,
  assignmentApplies,
  sameAssignmentScope,
  scopeKey,
  type AssignmentScope,
  type TargetScope,
} from '../src/index.js';

const global: TargetScope = { type: 'global' };
const companyA: TargetScope = { type: 'company', companyId: 'A' };
const companyB: TargetScope = { type: 'company', companyId: 'B' };
const businessA1: TargetScope = { type: 'business', companyId: 'A', businessId: 'A1' };
const businessA2: TargetScope = { type: 'business', companyId: 'A', businessId: 'A2' };
const businessB1: TargetScope = { type: 'business', companyId: 'B', businessId: 'B1' };

describe('scope inheritance (downwards only)', () => {
  const cases: Array<[string, AssignmentScope, TargetScope, boolean]> = [
    ['global → global', GLOBAL_SCOPE, global, true],
    ['global → company', GLOBAL_SCOPE, companyA, true],
    ['global → business', GLOBAL_SCOPE, businessA1, true],
    ['company A → global', { type: 'company', id: 'A' }, global, false],
    ['company A → company A', { type: 'company', id: 'A' }, companyA, true],
    ['company A → company B', { type: 'company', id: 'A' }, companyB, false],
    ['company A → its business A1', { type: 'company', id: 'A' }, businessA1, true],
    ['company A → its business A2', { type: 'company', id: 'A' }, businessA2, true],
    ['company A → business of B', { type: 'company', id: 'A' }, businessB1, false],
    ['business A1 → global', { type: 'business', id: 'A1' }, global, false],
    ['business A1 → its company', { type: 'business', id: 'A1' }, companyA, false],
    ['business A1 → itself', { type: 'business', id: 'A1' }, businessA1, true],
    ['business A1 → sibling A2', { type: 'business', id: 'A1' }, businessA2, false],
    ['business A1 → business of B', { type: 'business', id: 'A1' }, businessB1, false],
  ];
  it.each(cases)('%s', (_label, assignment, target, expected) => {
    expect(assignmentApplies(assignment, target)).toBe(expected);
  });
});

describe('scope keys', () => {
  it('builds a stable key per scope', () => {
    expect(scopeKey(GLOBAL_SCOPE)).toBe('global');
    expect(scopeKey({ type: 'company', id: 'A' })).toBe('company:A');
    expect(scopeKey({ type: 'business', id: 'A1' })).toBe('business:A1');
  });

  it('distinguishes a company from a business with the same id', () => {
    expect(sameAssignmentScope({ type: 'company', id: 'X' }, { type: 'business', id: 'X' })).toBe(
      false,
    );
    expect(sameAssignmentScope({ type: 'company', id: 'X' }, { type: 'company', id: 'X' })).toBe(
      true,
    );
  });
});
