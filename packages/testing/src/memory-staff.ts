import {
  AxedaError,
  withoutPin,
  type StaffAccount,
  type StaffStore,
  type StoredStaffAccount,
} from '@teamblind/axeda-core';
import { paginate, type Run } from './memory-tenants.js';

export interface StaffState {
  staff: Map<string, StoredStaffAccount>;
}

const taken = () =>
  new AxedaError('AXEDA_USERNAME_TAKEN', 'That username is already used in this company.');
const missing = (userId: string) =>
  new AxedaError('AXEDA_STAFF_NOT_FOUND', `Staff account "${userId}" does not exist.`);

/** Cuentas de personal en memoria (parte de `createMemoryPersistence`). */
export function createStaffStore(state: StaffState, run: Run, now: () => Date): StaffStore {
  const all = () => [...state.staff.values()];
  const byName = (companyId: string, username: string) =>
    all().find((account) => account.companyId === companyId && account.username === username);
  const need = (userId: string) => {
    const account = state.staff.get(userId);
    if (account === undefined) throw missing(userId);
    return account;
  };
  const put = (account: StoredStaffAccount) => {
    state.staff.set(account.userId, account);
    return account;
  };

  return {
    get: (userId) => run(async () => state.staff.get(userId) ?? null),
    findByUsername: (companyId, username) => run(async () => byName(companyId, username) ?? null),
    create: (input) =>
      run(async () => {
        if (byName(input.companyId, input.username) !== undefined) throw taken();
        const at = now();
        return withoutPin(
          put({
            ...input,
            failedAttempts: 0,
            lockedUntil: null,
            createdAt: at,
            pinChangedAt: at,
          }),
        );
      }),
    list: (filter, page) =>
      run(async () => {
        const sorted = all()
          .filter((account) => account.companyId === filter.companyId)
          .filter(
            (account) =>
              filter.businessId === undefined || account.businessId === filter.businessId,
          )
          .filter((account) => filter.siteId === undefined || account.siteId === filter.siteId)
          .sort((a, b) => a.username.localeCompare(b.username));
        const result = paginate(sorted, (account) => account.username, page);
        return { items: result.items.map(withoutPin), nextCursor: result.nextCursor };
      }),
    rename: (userId, username) =>
      run(async () => {
        const account = need(userId);
        const other = byName(account.companyId, username);
        if (other !== undefined && other.userId !== userId) throw taken();
        return withoutPin(put({ ...account, username }));
      }),
    setPin: (userId, pinHash, at) =>
      run(async () => {
        put({ ...need(userId), pinHash, pinChangedAt: at, failedAttempts: 0, lockedUntil: null });
      }),
    consumeAttempt: (userId, at, policy) =>
      run(async () => {
        let account = need(userId);
        if (account.lockedUntil !== null && account.lockedUntil > at) return 'locked';
        // Un bloqueo vencido se levanta y la cuenta vuelve a tener todos sus intentos.
        if (account.lockedUntil !== null)
          account = put({ ...account, lockedUntil: null, failedAttempts: 0 });
        if (account.failedAttempts >= policy.maxAttempts) return 'locked';
        const failedAttempts = account.failedAttempts + 1;
        put({
          ...account,
          failedAttempts,
          lockedUntil:
            failedAttempts >= policy.maxAttempts ? new Date(at.getTime() + policy.lockMs) : null,
        });
        return 'allowed';
      }),
    resetAttempts: (userId) =>
      run(async () => {
        const account = state.staff.get(userId);
        if (account !== undefined) put({ ...account, failedAttempts: 0, lockedUntil: null });
      }),
    delete: (userId) => run(async () => state.staff.delete(userId)),
    deleteOwnedBy: (owners) =>
      run(async () => {
        const doomed: StaffAccount[] = all()
          .filter(
            (account) =>
              owners.companyIds.includes(account.companyId) ||
              (account.businessId !== null && owners.businessIds.includes(account.businessId)) ||
              (account.siteId !== null && owners.siteIds.includes(account.siteId)),
          )
          .map(withoutPin);
        for (const account of doomed) state.staff.delete(account.userId);
        return doomed;
      }),
  };
}
