import type { BetterAuthPlugin } from '@better-auth/core';
import { axedaSchema } from './schema.js';

/**
 * Plugin de Axeda para Better Auth. En esta fase solo declara el esquema (tablas y el contador
 * `authzVersion` del usuario); los endpoints, hooks y cliente llegan en las fases siguientes.
 */
export const axeda = () =>
  ({
    id: 'axeda',
    schema: axedaSchema,
  }) satisfies BetterAuthPlugin;
