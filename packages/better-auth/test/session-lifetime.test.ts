import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeda } from '../src/index.js';
import { cappedExpiry, resolveMaxSessionAge } from '../src/session-lifetime.js';
import { createHttpApp, type HttpAppOptions } from './support/http.js';
import { memoryStorage } from './support/memory-storage.js';

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-01T12:00:00Z').getTime();

// Solo se falsea `Date`: los temporizadores reales siguen corriendo.
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: START }));
afterEach(() => vi.useRealTimers());

const atDay = (days: number) => vi.setSystemTime(START + days * DAY);

/** Better Auth renueva la sesión mientras se usa: 7 días sin actividad, no más de uno entre renovaciones. */
const SESSION = { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 };

async function appWith(options: HttpAppOptions = {}) {
  const app = await createHttpApp({
    ...options,
    betterAuth: { session: SESSION, ...options.betterAuth },
  });
  const alice = await app.signUp('alice');
  const status = async (cookie: string) => (await app.get('/axeda/me', cookie)).status;
  const nativeSession = async (cookie: string) =>
    (await app.get('/get-session', cookie)).json as { session: { expiresAt: string } } | null;
  return { app, alice, status, nativeSession };
}

describe.each([
  ['sessions in the database', false],
  ['sessions in secondaryStorage', true],
])('the absolute lifetime of a session (%s)', (_label, secondaryStorage) => {
  const storage: HttpAppOptions = secondaryStorage
    ? { betterAuth: { secondaryStorage: memoryStorage() } }
    : {};

  it('ends a session in daily use after thirty days, by default', async () => {
    const { alice, status, nativeSession } = await appWith(storage);

    // Se usa cada día. Sin límite absoluto, la renovación la mantendría viva para siempre.
    for (let day = 1; day <= 29; day += 1) {
      atDay(day);
      expect(await status(alice.cookie), `day ${day}`).toBe(200);
    }
    // Más allá de los siete días sin actividad: sigue viva solo porque se renovó.
    const expires = (await nativeSession(alice.cookie))?.session.expiresAt;
    expect(new Date(expires ?? 0).getTime()).toBeLessThanOrEqual(START + 30 * DAY);

    atDay(30.5);
    expect(await status(alice.cookie)).toBe(401);
    // Y no solo en las rutas de Axeda: la propia Better Auth ya no la reconoce.
    expect(await nativeSession(alice.cookie)).toBeNull();
  });

  it('does not stop a session in daily use before that', async () => {
    const { alice, status } = await appWith(storage);
    atDay(8);
    expect(await status(alice.cookie)).toBe(401);
  });

  it('asks for a new sign-in, and a new sign-in starts the clock again', async () => {
    const { app, alice, status } = await appWith(storage);
    for (let day = 1; day <= 29; day += 1) {
      atDay(day);
      await status(alice.cookie);
    }
    atDay(29.5);
    const again = await app.post('/sign-in/email', {
      email: 'alice@test.dev',
      password: 'correct-horse-battery-12',
    });
    expect(again.status).toBe(200);

    atDay(31);
    expect(await status(alice.cookie)).toBe(401);
    expect(await status(again.cookies)).toBe(200);
  });

  it('can be shorter than the idle time: the session is cut when it is created', async () => {
    const { alice, status } = await appWith({
      ...storage,
      plugin: { maxSessionAge: 2 * 24 * 60 * 60 },
    });
    // Nadie la usa entre medias, así que no hay ninguna renovación que la recorte: sin el recorte
    // al crearla, seguiría viva hasta los siete días sin actividad.
    atDay(2.5);
    expect(await status(alice.cookie)).toBe(401);
  });

  it('can be shorter than the idle time: and a renewal does not move it past that', async () => {
    const { alice, status } = await appWith({
      ...storage,
      plugin: { maxSessionAge: 2 * 24 * 60 * 60 },
    });
    atDay(1);
    expect(await status(alice.cookie)).toBe(200);
    atDay(2.5);
    expect(await status(alice.cookie)).toBe(401);
  });

  it('can be turned off with false', async () => {
    const { alice, status } = await appWith({ ...storage, plugin: { maxSessionAge: false } });
    for (let day = 1; day <= 40; day += 1) {
      atDay(day);
      expect(await status(alice.cookie), `day ${day}`).toBe(200);
    }
  });
});

describe('the maxSessionAge option', () => {
  it('is thirty days when it is not given, and false means no limit', () => {
    expect(resolveMaxSessionAge(undefined)).toBe(30 * 24 * 60 * 60);
    expect(resolveMaxSessionAge(false)).toBeUndefined();
    expect(resolveMaxSessionAge(3600)).toBe(3600);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s instead of quietly ignoring it',
    (value) => {
      expect(() => axeda({ permissions: ['a:b'], maxSessionAge: value })).toThrow(
        expect.objectContaining({ code: 'AXEDA_INVALID_CONFIG' }),
      );
    },
  );
});

describe('cappedExpiry', () => {
  const created = new Date(START);
  it('cuts what goes past the limit and leaves the rest alone', () => {
    expect(cappedExpiry(new Date(START + 40 * DAY), created, 30 * 24 * 3600)).toEqual(
      new Date(START + 30 * DAY),
    );
    expect(cappedExpiry(new Date(START + 10 * DAY), created, 30 * 24 * 3600)).toBeUndefined();
    expect(cappedExpiry(new Date(START + 30 * DAY), created, 30 * 24 * 3600)).toBeUndefined();
  });

  it('does nothing when it cannot tell the dates', () => {
    expect(cappedExpiry(undefined, created, 100)).toBeUndefined();
    expect(cappedExpiry(new Date(START + DAY), 'not a date', 100)).toBeUndefined();
  });
});
