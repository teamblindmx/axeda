import { createMemoryStorage } from '@teamblind/axeda-testing';
import { describe, expect, it } from 'vitest';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

const ok = <T>(response: { status: number; json: T }): T => {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
};

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

interface Ticket {
  uploadId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

async function world(kind: (typeof databaseKinds)[number]) {
  const storage = createMemoryStorage({ publicBaseUrl: 'https://images.acme.test' });
  const app = await createHttpApp({ kind, plugin: { storage } });
  const admin = await app.signUp('admin');
  await app.plugin.instance().bootstrap({ userId: admin.id });
  const company = ok(
    await app.post('/axeda/company/create', { slug: 'acme', name: 'ACME' }, admin.cookie),
  ) as { id: string };
  /** Lo que haría el frontend: pedir la subida, subir con PUT y completarla. */
  const upload = async (cookie: string, body: Record<string, unknown>, bytes = png(300, 100)) => {
    const ticket = ok(
      await app.post(
        '/axeda/image/upload',
        { contentType: 'image/png', size: bytes.length, ...body },
        cookie,
      ),
    ) as Ticket;
    await storage.upload(ticket, bytes);
    return {
      ticket,
      done: await app.post('/axeda/image/complete', { uploadId: ticket.uploadId }, cookie),
    };
  };
  return { app, storage, admin, company, upload };
}

describe.each(databaseKinds)('images over HTTP (%s)', (kind) => {
  it('sets a company logo with a signed upload, returning only the documented fields', async () => {
    const { app, admin, company, upload } = await world(kind);
    const { ticket, done } = await upload(admin.cookie, {
      purpose: 'company.logo',
      targetId: company.id,
    });
    expect(Object.keys(ticket).sort()).toEqual([
      'expiresAt',
      'headers',
      'method',
      'uploadId',
      'url',
    ]);
    expect(ticket.headers).toEqual({ 'content-type': 'image/png' });
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
    const image = ok(done) as { purpose: string; targetId: string; url: string };
    expect(Object.keys(image).sort()).toEqual(['purpose', 'targetId', 'url']);
    expect(image.url).toMatch(/^https:\/\/images\.acme\.test\/images\/[0-9a-f]{32}\.png$/);

    const got = ok(await app.get('/axeda/company/get', admin.cookie, { id: company.id })) as {
      logoUrl: string | null;
    };
    expect(got.logoUrl).toBe(image.url);

    const removed = ok(
      await app.post(
        '/axeda/image/remove',
        { purpose: 'company.logo', targetId: company.id },
        admin.cookie,
      ),
    );
    expect(removed).toEqual({ purpose: 'company.logo', targetId: company.id, url: null });
    const after = ok(await app.get('/axeda/company/get', admin.cookie, { id: company.id })) as {
      logoUrl: string | null;
    };
    expect(after.logoUrl).toBeNull();
  });

  it('refuses people who cannot edit the company, and validates the request', async () => {
    const { app, admin, company } = await world(kind);
    const alice = await app.signUp('alice');
    const asked = await app.post(
      '/axeda/image/upload',
      { purpose: 'company.logo', targetId: company.id, contentType: 'image/png', size: 64 },
      alice.cookie,
    );
    expect([asked.status, asked.json.code]).toEqual([404, 'AXEDA_COMPANY_NOT_FOUND']);
    for (const body of [
      { purpose: 'company.logo', targetId: company.id, contentType: 'image/svg+xml', size: 64 },
      { purpose: 'company.banner', targetId: company.id, contentType: 'image/png', size: 64 },
      { purpose: 'company.logo', targetId: company.id, contentType: 'image/png', size: 0 },
      { purpose: 'company.logo', targetId: company.id, contentType: 'image/png', size: 64, x: 1 },
    ]) {
      expect(
        (await app.post('/axeda/image/upload', body, admin.cookie)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('refuses a file that is not what it claims, and does not keep it', async () => {
    const { admin, company, storage, upload } = await world(kind);
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(64));
    const { done } = await upload(
      admin.cookie,
      { purpose: 'company.logo', targetId: company.id },
      html,
    );
    expect([done.status, done.json.code]).toEqual([400, 'AXEDA_IMAGE_INVALID']);
    expect(storage.keys()).toEqual([]);
  });

  it('only lets the person who asked complete an upload', async () => {
    const { app, admin, company, storage } = await world(kind);
    const other = await app.signUp('other');
    const ticket = ok(
      await app.post(
        '/axeda/image/upload',
        { purpose: 'company.logo', targetId: company.id, contentType: 'image/png', size: 64 },
        admin.cookie,
      ),
    ) as Ticket;
    await storage.upload(ticket, png(10, 10));
    const stolen = await app.post(
      '/axeda/image/complete',
      { uploadId: ticket.uploadId },
      other.cookie,
    );
    expect([stolen.status, stolen.json.code]).toEqual([400, 'AXEDA_UPLOAD_INVALID']);
  });

  it('lets a person set their own profile picture, visible in the user list', async () => {
    const { app, admin, upload } = await world(kind);
    const alice = await app.signUp('alice');
    const { done } = await upload(alice.cookie, { purpose: 'user.avatar', targetId: alice.id });
    const { url } = ok(done) as { url: string };
    const users = ok(await app.get('/axeda/user/list', admin.cookie)) as {
      items: { id: string; image: string | null }[];
    };
    expect(users.items.find((user) => user.id === alice.id)?.image).toBe(url);
    // Pero no la de otra persona.
    const bob = await app.signUp('bob');
    const denied = await app.post(
      '/axeda/image/upload',
      { purpose: 'user.avatar', targetId: bob.id, contentType: 'image/png', size: 64 },
      alice.cookie,
    );
    expect([denied.status, denied.json.code]).toEqual([403, 'AXEDA_FORBIDDEN']);
  });
});
