import { describe, expect, it } from 'vitest';
import { createAxeda } from '@teamblind/axeda-core';
import { createMemoryPersistence, createMemoryUserDirectory } from '../src/index.js';

// El ejemplo de la guía de pruebas (docs/en y docs/es), tal cual: si deja de funcionar, la guía miente.
describe('the testing guide snippet', () => {
  it('works as documented', async () => {
    const users = createMemoryUserDirectory([]);
    const axeda = createAxeda(
      { permissions: ['invoice:read'], roles: { viewer: ['invoice:read'] } },
      { persistence: createMemoryPersistence(), users, userAdmin: users },
    );

    users.add({ id: 'root' });
    users.add({ id: 'ana' });
    await axeda.start();
    await axeda.bootstrap({ userId: 'root' });
    const root = { userId: 'root' };
    const viewer = (await axeda.roles.list(root, { limit: 50 })).items.find(
      (role) => role.key === 'viewer',
    );
    await axeda.assignments.assign(root, {
      userId: 'ana',
      roleId: viewer?.id ?? '',
      scope: { type: 'global' },
    });

    expect(await axeda.can({ userId: 'ana' }, 'invoice:read')).toBe(true);
    expect(await axeda.can({ userId: 'nobody' }, 'invoice:read')).toBe(false);
  });
});
