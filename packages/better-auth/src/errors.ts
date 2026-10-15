/** Códigos de error que los controladores de base de datos usan para una violación de restricción. */
const UNIQUE_CODES = new Set([
  '23505', // PostgreSQL
  'ER_DUP_ENTRY', // MySQL / MariaDB
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  '11000', // MongoDB
]);

const FOREIGN_KEY_CODES = new Set([
  '23503', // PostgreSQL
  'ER_NO_REFERENCED_ROW_2', // MySQL / MariaDB
  'ER_NO_REFERENCED_ROW',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
]);

/** Recorre `error` y sus causas (Better Auth y Kysely envuelven los errores del controlador). */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, errno } = current as { code?: unknown; errno?: unknown };
    if (typeof code === 'string' || typeof code === 'number') codes.push(String(code));
    if (typeof errno === 'number') codes.push(String(errno));
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

export const isUniqueViolation = (error: unknown): boolean =>
  codesOf(error).some((code) => UNIQUE_CODES.has(code));

export const isForeignKeyViolation = (error: unknown): boolean =>
  codesOf(error).some((code) => FOREIGN_KEY_CODES.has(code));
