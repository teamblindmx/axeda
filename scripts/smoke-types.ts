// Se compila DENTRO del proyecto vacío de `scripts/smoke.mjs`: la API pública, con sus tipos,
// tal como la ve quien instala los paquetes. No se ejecuta.
import { createAxeda, type Axeda, type Principal } from '@teamblind/axeda-core';
import {
  axeda,
  principalFromUser,
  secureAuthOptions,
  sessionPrincipal,
  type AxedaPlugin,
} from '@teamblind/axeda-better-auth';
import { axedaClient } from '@teamblind/axeda-better-auth/client';
import { createAxedaExpress, resolveScope, type AxedaExpress } from '@teamblind/axeda-express';
import { createMemoryPersistence, createMemoryUserDirectory } from '@teamblind/axeda-testing';

const plugin: AxedaPlugin = axeda({ permissions: ['invoice:read'] });
const users = createMemoryUserDirectory([]);
const core: Axeda = createAxeda(
  { permissions: ['invoice:read'] },
  { persistence: createMemoryPersistence(), users, userAdmin: users },
);
const principal: Principal = principalFromUser({ id: 'u1', twoFactorEnabled: true });
const options = secureAuthOptions({
  baseURL: 'https://api.example.com',
  secret: 'k3Jx9Qp2Zr7Lm4Vb8Nc1Td6Wy5Hs0Ga3Fe9Uo2Ri7Pq',
  trustedOrigins: ['https://app.example.com'],
});
const x: AxedaExpress = createAxedaExpress({
  axeda: core,
  principal: async () => principal,
  trustedOrigins: ['https://app.example.com'],
});
x.requirePermission('invoice:read', { scope: resolveScope({ company: 'companyId' }) });

// La decisión sobre CSRF es obligatoria: omitirla no compila.
// @ts-expect-error neither trustedOrigins nor csrf: false
createAxedaExpress({ axeda: core, principal: async () => principal });

// Un cliente de Better Auth con el plugin de Axeda.
const client = axedaClient();
const session: typeof sessionPrincipal = sessionPrincipal;

export { client, options, plugin, session };
