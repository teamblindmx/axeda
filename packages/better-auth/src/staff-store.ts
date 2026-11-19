import {
  AxedaError,
  withoutPin,
  type StaffAccount,
  type StaffFilter,
  type StaffStore,
  type StoredStaffAccount,
  lockDuration,
} from '@teamblind/axeda-core';
import { isUniqueViolation } from './errors.js';
import { MODELS } from './schema.js';
import { MAX_ROWS, decodeCursor, encodeCursor, type Adapter } from './shared.js';

interface StaffRow {
  id: string;
  userId: string;
  companyId: string;
  businessId?: string | null;
  siteId?: string | null;
  username: string;
  pinHash: string;
  failedAttempts: number;
  lockedUntil?: Date | string | null;
  lockCount?: number | null;
  createdBy: string;
  createdAt: Date | string;
  pinChangedAt: Date | string;
}

const model = MODELS.staff;

const asDate = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

const toStaff = (row: StaffRow): StoredStaffAccount => ({
  userId: row.userId,
  companyId: row.companyId,
  businessId: row.businessId ?? null,
  siteId: row.siteId ?? null,
  username: row.username,
  pinHash: row.pinHash,
  failedAttempts: row.failedAttempts,
  lockedUntil: asDate(row.lockedUntil),
  lockCount: row.lockCount ?? 0,
  createdBy: row.createdBy,
  createdAt: asDate(row.createdAt) ?? new Date(0),
  pinChangedAt: asDate(row.pinChangedAt) ?? new Date(0),
});

const taken = () =>
  new AxedaError('AXEDA_USERNAME_TAKEN', 'That username is already used in this company.');
const missing = (userId: string) =>
  new AxedaError('AXEDA_STAFF_NOT_FOUND', `Staff account "${userId}" does not exist.`);

const byUser = (userId: string) => [{ field: 'userId', value: userId }];

export function createStaffStore(adapter: Adapter, now: () => Date): StaffStore {
  const find = async (userId: string) => {
    const row = await adapter.findOne<StaffRow>({ model, where: byUser(userId) });
    return row === null ? null : toStaff(row);
  };
  const need = async (userId: string) => {
    const account = await find(userId);
    if (account === null) throw missing(userId);
    return account;
  };
  const filterOf = (filter: StaffFilter) => [
    { field: 'companyId', value: filter.companyId },
    ...(filter.businessId === undefined ? [] : [{ field: 'businessId', value: filter.businessId }]),
    ...(filter.siteId === undefined ? [] : [{ field: 'siteId', value: filter.siteId }]),
  ];

  return {
    get: find,

    async findByUsername(companyId, username) {
      const row = await adapter.findOne<StaffRow>({
        model,
        where: [
          { field: 'companyId', value: companyId },
          { field: 'username', value: username },
        ],
      });
      return row === null ? null : toStaff(row);
    },

    async create(input) {
      const at = now();
      try {
        const row = await adapter.create<Omit<StaffRow, 'id'>, StaffRow>({
          model,
          data: {
            userId: input.userId,
            companyId: input.companyId,
            businessId: input.businessId,
            siteId: input.siteId,
            username: input.username,
            pinHash: input.pinHash,
            failedAttempts: 0,
            lockedUntil: null,
            lockCount: 0,
            createdBy: input.createdBy,
            createdAt: at,
            pinChangedAt: at,
          },
        });
        return withoutPin(toStaff(row));
      } catch (error) {
        if (isUniqueViolation(error)) throw taken();
        throw error;
      }
    },

    async list(filter, page) {
      const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
      const rows = await adapter.findMany<StaffRow>({
        model,
        where: [
          ...filterOf(filter),
          ...(after === null ? [] : [{ field: 'username', operator: 'gt' as const, value: after }]),
        ],
        sortBy: { field: 'username', direction: 'asc' },
        limit: page.limit + 1,
      });
      const kept = rows.slice(0, page.limit);
      const last = kept.at(-1);
      return {
        items: kept.map((row) => withoutPin(toStaff(row))),
        nextCursor: rows.length > kept.length && last ? encodeCursor(last.username) : null,
      };
    },

    async rename(userId, username) {
      await need(userId);
      try {
        const row = await adapter.update<StaffRow>({
          model,
          where: byUser(userId),
          update: { username },
        });
        if (row === null) throw missing(userId);
        return withoutPin(toStaff(row));
      } catch (error) {
        if (isUniqueViolation(error)) throw taken();
        throw error;
      }
    },

    async setPin(userId, pinHash, at) {
      const row = await adapter.update<StaffRow>({
        model,
        where: byUser(userId),
        update: { pinHash, pinChangedAt: at, failedAttempts: 0, lockedUntil: null, lockCount: 0 },
      });
      if (row === null) throw missing(userId);
    },

    async consumeAttempt(userId, at, policy) {
      const account = await need(userId);
      if (account.lockedUntil !== null && account.lockedUntil > at) return 'locked';
      if (account.lockedUntil !== null) {
        // Un bloqueo vencido se levanta (solo si nadie lo cambió entre tanto).
        await adapter.updateMany({
          model,
          where: [...byUser(userId), { field: 'lockedUntil', value: account.lockedUntil }],
          update: { lockedUntil: null, failedAttempts: 0 },
        });
      }
      // El tope va en la propia sentencia: de varios intentos a la vez solo pasan los que quedan.
      const spent = await adapter.incrementOne<StaffRow>({
        model,
        where: [
          ...byUser(userId),
          { field: 'failedAttempts', operator: 'lt', value: policy.maxAttempts },
        ],
        increment: { failedAttempts: 1 },
      });
      if (spent === null) return 'locked';
      if (spent.failedAttempts >= policy.maxAttempts) {
        // Solo el intento que llegó al tope pasa por aquí (los demás no pasaron la guarda de arriba).
        const lockCount = spent.lockCount ?? 0;
        await adapter.update({
          model,
          where: byUser(userId),
          update: {
            lockedUntil: new Date(at.getTime() + lockDuration(policy, lockCount)),
            lockCount: lockCount + 1,
          },
        });
      }
      return 'allowed';
    },

    async resetAttempts(userId) {
      await adapter.updateMany({
        model,
        where: byUser(userId),
        update: { failedAttempts: 0, lockedUntil: null, lockCount: 0 },
      });
    },

    async delete(userId) {
      return (await adapter.deleteMany({ model, where: byUser(userId) })) > 0;
    },

    async deleteOwnedBy(owners) {
      // Una tras otra: se llama dentro de la transacción de purga, y MongoDB no admite varias
      // operaciones a la vez en la misma transacción.
      const groups: StaffRow[][] = [];
      for (const [field, ids] of [
        ['companyId', owners.companyIds],
        ['businessId', owners.businessIds],
        ['siteId', owners.siteIds],
      ] as const) {
        if (ids.length === 0) continue;
        groups.push(
          await adapter.findMany<StaffRow>({
            model,
            where: [{ field, operator: 'in', value: [...ids] }],
            limit: MAX_ROWS,
          }),
        );
      }
      const unique = new Map<string, StaffAccount>();
      for (const row of groups.flat()) unique.set(row.userId, withoutPin(toStaff(row)));
      if (unique.size > 0) {
        await adapter.deleteMany({
          model,
          where: [{ field: 'userId', operator: 'in', value: [...unique.keys()] }],
        });
      }
      return [...unique.values()];
    },
  };
}
