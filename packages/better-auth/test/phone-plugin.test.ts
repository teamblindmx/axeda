import type { DBAdapter } from '@better-auth/core/db/adapter';
import { phoneNumber } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import { securePhoneNumberOptions, type SecurePhoneNumberInput } from '../src/index.js';
import { countInWindow } from '../src/phone.js';
import { databaseKinds } from './support/databases.js';
import { createHttpApp } from './support/http.js';

/**
 * El plugin `phoneNumber` REAL de Better Auth con las opciones de `securePhoneNumberOptions`, junto
 * al de Axeda. Los SMS no salen: se guardan para leer el código.
 */
async function phoneApp(
  kind: (typeof databaseKinds)[number],
  extra: Partial<SecurePhoneNumberInput> = {},
) {
  const codes = new Map<string, string>();
  const sends: string[] = [];
  const app = await createHttpApp({
    kind,
    extraPlugins: [
      phoneNumber(
        securePhoneNumberOptions({
          sendOTP: ({ phoneNumber: number, code }) => {
            sends.push(number);
            codes.set(number, code);
          },
          ...extra,
        }),
      ),
    ],
  });
  const sendCode = (number: string) => app.post('/phone-number/send-otp', { phoneNumber: number });
  const verify = (number: string, code = codes.get(number) ?? '') =>
    app.post('/phone-number/verify', { phoneNumber: number, code });
  return { app, codes, sends, sendCode, verify };
}

const NUMBER = '+5215512345678';

describe.each(databaseKinds)('access by phone number with the real plugin (%s)', (kind) => {
  it('signs up and signs in with one code, and Axeda sees the new user', async () => {
    const { app, sendCode, verify } = await phoneApp(kind);
    expect((await sendCode(NUMBER)).status).toBe(200);
    const verified = await verify(NUMBER);
    expect(verified.status).toBe(200);
    expect(verified.json.user).toMatchObject({
      phoneNumber: NUMBER,
      phoneNumberVerified: true,
      email: '5215512345678@phone.invalid',
    });
    const me = await app.get('/axeda/me', verified.cookies);
    expect([me.status, me.json.userId]).toEqual([200, verified.json.user.id]);
  });

  it('refuses a number that is not in E.164 format, without sending anything', async () => {
    const { sendCode, sends } = await phoneApp(kind);
    for (const bad of ['5512345678', '+52 55 1234 5678', '+0123456789', 'abc']) {
      expect((await sendCode(bad)).status, bad).toBe(400);
    }
    expect(sends).toEqual([]);
  });

  it('caps the codes sent to one number, whatever the address asking', async () => {
    const { sendCode, sends } = await phoneApp(kind, { maxSendsPerNumber: 2 });
    expect((await sendCode(NUMBER)).status).toBe(200);
    expect((await sendCode(NUMBER)).status).toBe(200);
    const third = await sendCode(NUMBER);
    expect(third.status).toBe(429);
    expect(sends).toEqual([NUMBER, NUMBER]);
    // Otro número no comparte el tope.
    expect((await sendCode('+5215587654321')).status).toBe(200);
  });

  it('burns a code after three wrong attempts', async () => {
    const { sendCode, verify, codes } = await phoneApp(kind);
    await sendCode(NUMBER);
    const right = codes.get(NUMBER) ?? '';
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) expect((await verify(NUMBER, wrong)).status).not.toBe(200);
    expect((await verify(NUMBER, right)).status).not.toBe(200);
  });

  it('does not let a suspended person back in with a code', async () => {
    const { app, sendCode, verify } = await phoneApp(kind);
    const admin = await app.signUp('admin');
    await app.plugin.instance().bootstrap({ userId: admin.id });
    await sendCode(NUMBER);
    const first = await verify(NUMBER);
    await app.plugin.instance().users.ban({ userId: admin.id }, first.json.user.id);
    expect((await app.get('/axeda/me', first.cookies)).status).toBe(401);
    await sendCode(NUMBER);
    const again = await verify(NUMBER);
    expect([again.status, again.json.code]).toEqual([403, 'AXEDA_USER_BANNED']);
  });

  it('with sign-up off, a code for an unknown number creates nobody', async () => {
    const { app, sendCode, verify } = await phoneApp(kind, { signUpOnVerification: false });
    await sendCode(NUMBER);
    expect((await verify(NUMBER)).status).not.toBe(200);
    const context = await app.auth.$context;
    expect(await context.adapter.count({ model: 'user' })).toBe(0);
  });

  it('invites by number: the person signs up with a code and accepts, and admins see the number', async () => {
    const { app, sendCode, verify } = await phoneApp(kind);
    const admin = await app.signUp('admin');
    const axeda = app.plugin.instance();
    await axeda.bootstrap({ userId: admin.id });
    const boss = { userId: admin.id };
    const acme = await axeda.companies.create(boss, { slug: 'acme', name: 'Acme' });
    const cashier = await axeda.roles.create(boss, {
      key: 'cashier',
      name: 'Cashier',
      permissions: ['invoice:read'],
    });
    const invitation = await axeda.invitations.create(boss, {
      phoneNumber: NUMBER,
      scope: { type: 'company', id: acme.id },
      roleIds: [cashier.id],
    });
    expect(invitation).toMatchObject({ channel: 'phone', phoneNumber: NUMBER });
    const token = app.sent.at(-1)?.token ?? '';

    await sendCode(NUMBER);
    const person = await verify(NUMBER);
    const accepted = await app.post('/axeda/invitation/accept', { token }, person.cookies);
    expect(accepted.status).toBe(200);
    expect(accepted.json.assignments).toHaveLength(1);

    const listed = await axeda.users.list(boss, {}, { limit: 10 });
    expect(listed.items.find((user) => user.id === person.json.user.id)).toMatchObject({
      phoneNumber: NUMBER,
      phoneNumberVerified: true,
    });
  });

  it('an account with a different number cannot accept a phone invitation', async () => {
    const { app, sendCode, verify } = await phoneApp(kind);
    const admin = await app.signUp('admin');
    const axeda = app.plugin.instance();
    await axeda.bootstrap({ userId: admin.id });
    const boss = { userId: admin.id };
    const acme = await axeda.companies.create(boss, { slug: 'acme', name: 'Acme' });
    const cashier = await axeda.roles.create(boss, {
      key: 'cashier',
      name: 'Cashier',
      permissions: ['invoice:read'],
    });
    await axeda.invitations.create(boss, {
      phoneNumber: NUMBER,
      scope: { type: 'company', id: acme.id },
      roleIds: [cashier.id],
    });
    const token = app.sent.at(-1)?.token ?? '';
    const other = '+5215587654321';
    await sendCode(other);
    const intruder = await verify(other);
    const refused = await app.post('/axeda/invitation/accept', { token }, intruder.cookies);
    expect([refused.status, refused.json.code]).toEqual([400, 'AXEDA_INVITATION_INVALID']);
  });

  it('counts sends atomically and opens a new window when the old one ends', async () => {
    const { app } = await phoneApp(kind);
    const adapter = (await app.auth.$context).adapter as unknown as DBAdapter;
    const start = new Date('2026-01-01T00:00:00.000Z');
    const hour = 60 * 60 * 1000;
    const counts = await Promise.all(
      Array.from({ length: 8 }, () => countInWindow(adapter, 'k', start, hour)),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await countInWindow(adapter, 'k', new Date(start.getTime() + hour - 1), hour)).toBe(9);
    expect(await countInWindow(adapter, 'k', new Date(start.getTime() + hour + 1), hour)).toBe(1);
    expect(await countInWindow(adapter, 'other', start, hour)).toBe(1);
  });
});

describe('securePhoneNumberOptions', () => {
  it('refuses limits that are not positive whole numbers', () => {
    const sendOTP = () => {};
    for (const bad of [0, -1, 1.5]) {
      expect(() => securePhoneNumberOptions({ sendOTP, maxSendsPerNumber: bad })).toThrow(
        /positive whole number/,
      );
      expect(() => securePhoneNumberOptions({ sendOTP, sendWindowSeconds: bad })).toThrow(
        /positive whole number/,
      );
    }
  });
});
