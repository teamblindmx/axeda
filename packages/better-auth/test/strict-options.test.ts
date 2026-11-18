import { describe, expect, it } from 'vitest';
import { axeda, secureAuthOptions, securePhoneNumberOptions } from '../src/index.js';

const SECRET = 'k3Jx9Qp2Zr7Lm4Vb8Nc1Td6Wy5Hs0Ga3Fe9Uo2Ri7Pq';

const messageOf = (run: () => unknown) => {
  try {
    run();
  } catch (caught) {
    return (caught as Error).message;
  }
  return null;
};

describe('a misspelled option is an error, never silently ignored', () => {
  it('in axeda(), with the option it probably meant', () => {
    const message = messageOf(() =>
      axeda({ permissions: ['invoice:read'], publicIdentiy: true } as never),
    );
    expect(message).toContain('axeda(): unknown option "publicIdentiy".');
    expect(message).toContain('Did you mean "publicIdentity"?');
    expect(() =>
      axeda({
        permissions: [],
        invitationDelibery: { acceptUrl: () => '', send: async () => {} },
      } as never),
    ).toThrow(/Did you mean "invitationDelivery"/);
  });

  it('inside invitationDelivery', () => {
    expect(() =>
      axeda({
        permissions: [],
        invitationDelivery: { acceptURL: () => '', send: async () => {} } as never,
      }),
    ).toThrow(
      /axeda\(\{ invitationDelivery \}\): unknown option "acceptURL"\. Did you mean "acceptUrl"/,
    );
  });

  it('in the options the core reads (images, staff, limits…)', () => {
    // El núcleo las valida al crear Better Auth; aquí basta con que el plugin no las deje pasar.
    expect(() => axeda({ permissions: [], imagez: {} } as never)).toThrow(/Did you mean "images"/);
  });

  it('in secureAuthOptions() and securePhoneNumberOptions()', () => {
    expect(() =>
      secureAuthOptions({
        baseURL: 'https://api.example.com',
        secret: SECRET,
        trustedOrigins: ['https://app.example.com'],
        trustedProxys: ['10.0.0.1'],
      } as never),
    ).toThrow(
      /secureAuthOptions\(\): unknown option "trustedProxys"\. Did you mean "trustedProxies"/,
    );
    expect(() =>
      securePhoneNumberOptions({ sendOTP: () => {}, maxSendPerNumber: 3 } as never),
    ).toThrow(/Did you mean "maxSendsPerNumber"/);
  });

  it('accepts every option that exists', () => {
    expect(() =>
      axeda({
        permissions: ['invoice:read'],
        publicIdentity: true,
        maxSessionAge: false,
        invitationDelivery: {
          acceptUrl: (token) => `https://app.example.com/${token}`,
          send: async () => {},
        },
      }),
    ).not.toThrow();
  });
});
