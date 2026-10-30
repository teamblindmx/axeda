import { z } from 'zod';
import { MAX_AUDIT_METADATA_BYTES } from '../domain/audit.js';
import { SLUG_PATTERN } from '../domain/tenant.js';
import { invalidInput } from './services.js';

const MAX_DEPTH = 4;
const MAX_KEYS = 50;

function depthOf(value: unknown, depth = 0): number {
  if (typeof value !== 'object' || value === null) return depth;
  const children = Object.values(value);
  return children.length === 0
    ? depth + 1
    : Math.max(...children.map((c) => depthOf(c, depth + 1)));
}

/** `metadata` acotado en tamaño, profundidad y número de claves (S12). */
const metadata = z
  .record(z.string().max(100), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_KEYS, `at most ${MAX_KEYS} keys`)
  .refine((value) => depthOf(value) <= MAX_DEPTH, `at most ${MAX_DEPTH} levels deep`)
  .refine(
    (value) => JSON.stringify(value).length <= MAX_AUDIT_METADATA_BYTES,
    `at most ${MAX_AUDIT_METADATA_BYTES} bytes`,
  );

/**
 * Las URL de logo se muestran en `<img>`: solo `https:` (o `http:` hacia la propia máquina, para
 * desarrollo). Nada de `javascript:`, `data:` ni rutas relativas.
 */
const imageUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    } catch {
      return false;
    }
  }, 'must be an https URL');

const slug = z.string().regex(SLUG_PATTERN, 'must be lowercase letters, digits and dashes');
const name = z.string().min(1).max(200);

export const companyInputSchema = z.strictObject({
  slug,
  name,
  legalName: z.string().min(1).max(200).nullish(),
  logoUrl: imageUrl.nullish(),
  faviconUrl: imageUrl.nullish(),
  metadata: metadata.optional(),
});

export const companyChangesSchema = z.strictObject({
  name: name.optional(),
  legalName: z.string().min(1).max(200).nullish(),
  logoUrl: imageUrl.nullish(),
  faviconUrl: imageUrl.nullish(),
  metadata: metadata.optional(),
});

export const businessInputSchema = z.strictObject({
  slug,
  name,
  logoUrl: imageUrl.nullish(),
  faviconUrl: imageUrl.nullish(),
  metadata: metadata.optional(),
});

export const businessChangesSchema = z.strictObject({
  name: name.optional(),
  logoUrl: imageUrl.nullish(),
  faviconUrl: imageUrl.nullish(),
  metadata: metadata.optional(),
});

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw invalidInput(
    result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  );
}

/** Quita las claves con valor `undefined` (los cambios solo llevan lo que se quiere cambiar). */
export function onlyDefined<T extends object>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
