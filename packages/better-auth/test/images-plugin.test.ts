import { createMemoryStorage } from '@teamblind/axeda-testing';
import { describe, expect, it } from 'vitest';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

/** Una cabecera PNG válida de `width` × `height`. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

async function imageApp(kind: (typeof databaseKinds)[number]) {
  const storage = createMemoryStorage({ publicBaseUrl: 'https://images.acme.test' });
  const app = await createHttpApp({ kind, plugin: { storage, images: { maxBytes: 4096 } } });
  const axeda = app.plugin.instance();
  /** Sube y completa una foto de perfil por el núcleo, como lo harían los endpoints. */
  const setAvatar = async (actorId: string, userId: string) => {
    const bytes = png(128, 128);
    const ticket = await axeda.images.createUpload(
      { userId: actorId },
      { purpose: 'user.avatar', targetId: userId, contentType: 'image/png', size: bytes.length },
    );
    await storage.upload(ticket, bytes);
    return axeda.images.completeUpload({ userId: actorId }, ticket.uploadId);
  };
  return { app, axeda, storage, setAvatar };
}

describe.each(databaseKinds)('images on a real Better Auth (%s)', (kind) => {
  it('passes the storage and the image limits to the core', async () => {
    const { app, axeda } = await imageApp(kind);
    const alice = await app.signUp('alice');
    const ask = (size: number) =>
      axeda.images.createUpload(
        { userId: alice.id },
        { purpose: 'user.avatar', targetId: alice.id, contentType: 'image/png', size },
      );
    await expect(ask(4096)).resolves.toMatchObject({ method: 'PUT' });
    await expect(ask(4097)).rejects.toMatchObject({ code: 'AXEDA_INVALID_INPUT' });
  });

  it('writes the profile picture to the Better Auth user, and removes it', async () => {
    const { app, axeda, setAvatar } = await imageApp(kind);
    const alice = await app.signUp('alice');
    const { url } = await setAvatar(alice.id, alice.id);
    const context = await app.auth.$context;
    const read = async () =>
      ((await context.internalAdapter.findUserById(alice.id)) as { image?: string | null }).image;
    expect(await read()).toBe(url);
    // La sesión de Better Auth también la ve.
    const session = await app.get('/get-session', alice.cookie);
    expect(session.json.user.image).toBe(url);

    await axeda.images.remove({ userId: alice.id }, { purpose: 'user.avatar', targetId: alice.id });
    expect(await read()).toBeNull();
  });

  it('deletes the picture and its object when Better Auth deletes the user', async () => {
    const { app, storage, setAvatar } = await imageApp(kind);
    const alice = await app.signUp('alice');
    const bob = await app.signUp('bob');
    await setAvatar(alice.id, alice.id);
    await setAvatar(bob.id, bob.id);
    expect(storage.keys()).toHaveLength(2);
    await (await app.auth.$context).internalAdapter.deleteUser(alice.id);
    expect(storage.keys()).toHaveLength(1);
    const persistence = app.plugin.persistence();
    expect(await persistence.images.findCurrent('user.avatar', alice.id)).toBeNull();
    expect(await persistence.images.findCurrent('user.avatar', bob.id)).not.toBeNull();
  });
});

describe('images without a storage', () => {
  it('are off, and deleting a user still works', async () => {
    const app = await createHttpApp();
    const alice = await app.signUp('alice');
    await expect(
      app.plugin
        .instance()
        .images.createUpload(
          { userId: alice.id },
          { purpose: 'user.avatar', targetId: alice.id, contentType: 'image/png', size: 10 },
        ),
    ).rejects.toMatchObject({ code: 'AXEDA_FEATURE_DISABLED' });
    await (await app.auth.$context).internalAdapter.deleteUser(alice.id);
  });
});
