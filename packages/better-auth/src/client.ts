import type { BetterAuthClientPlugin } from 'better-auth/client';
import type { axeda } from './plugin.js';

/**
 * Plugin de cliente: infiere los endpoints del servidor, de modo que
 * `authClient.axeda.role.create({ … })` está tipado de punta a punta. Solo importa tipos del
 * servidor: no lleva código de servidor al navegador.
 */
export const axedaClient = () =>
  ({
    id: 'axeda',
    $InferServerPlugin: {} as ReturnType<typeof axeda>,
  }) satisfies BetterAuthClientPlugin;
