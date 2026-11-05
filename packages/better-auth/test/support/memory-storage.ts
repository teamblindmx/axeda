import type { SecondaryStorage } from '@better-auth/core/db';

/** Un `secondaryStorage` en memoria, como lo usaría Redis. */
export function memoryStorage(): SecondaryStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    getAndDelete: (key) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    increment: (key) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    },
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
  };
}
