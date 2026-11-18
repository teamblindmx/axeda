import { isAxedaError } from '@teamblind/axeda-core';
import { describe, expect, it } from 'vitest';
import { s3Storage, type S3StorageOptions } from '../src/index.js';
import { sha256Hex } from '../src/sigv4.js';

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
  readonly redirect: RequestInit['redirect'];
}

/** Un `fetch` falso que apunta cada llamada y responde lo que diga `reply`. */
function fakeFetch(reply: (call: Call) => Response = () => new Response(null, { status: 200 })) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: (init?.body as Uint8Array | undefined) ?? null,
      redirect: init?.redirect,
    };
    calls.push(call);
    return reply(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const OPTIONS: S3StorageOptions = {
  endpoint: 'https://account123.r2.cloudflarestorage.com',
  bucket: 'acme-images',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-key-that-is-long-enough',
  publicBaseUrl: 'https://images.acme.test/',
  now: () => new Date('2026-11-18T12:00:00.000Z'),
};

const storage = (reply?: (call: Call) => Response, extra: Partial<S3StorageOptions> = {}) => {
  const fake = fakeFetch(reply);
  return { store: s3Storage({ ...OPTIONS, fetch: fake.fetch, ...extra }), calls: fake.calls };
};

/** Un cuerpo que llega en trozos, sin `Content-Length` (como un servidor que ignora el Range). */
const streamed = (size: number, chunk = 1024) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (let sent = 0; sent < size; sent += chunk) {
          controller.enqueue(new Uint8Array(Math.min(chunk, size - sent)));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );

describe('the S3 storage', () => {
  it('refuses options that would be unsafe or wrong', () => {
    const bad: Partial<S3StorageOptions>[] = [
      { endpoint: 'http://account123.r2.cloudflarestorage.com' },
      { endpoint: 'https://account123.r2.cloudflarestorage.com/acme-images' },
      { endpoint: 'https://user:pass@example.com' },
      { endpoint: 'not a url' },
      { bucket: 'Acme_Images' },
      { bucket: 'ab' },
      { accessKeyId: ' ' },
      { secretAccessKey: '' },
      { publicBaseUrl: 'http://images.acme.test' },
      { publicBaseUrl: 'https://images.acme.test/?v=1' },
    ];
    for (const options of bad) {
      expect(() => s3Storage({ ...OPTIONS, ...options }), JSON.stringify(options)).toThrow(
        /Invalid storage options/,
      );
    }
    // Una opción mal escrita es un error, no se ignora.
    expect(() => s3Storage({ ...OPTIONS, publicBaseURL: 'x' } as never)).toThrow(
      /s3Storage\(\): unknown option "publicBaseURL"\. Did you mean "publicBaseUrl"/,
    );
    // http solo en esta máquina, p. ej. MinIO para desarrollo.
    expect(() => s3Storage({ ...OPTIONS, endpoint: 'http://localhost:9000' })).not.toThrow();
  });

  it('presigns a path-style PUT with the content type signed', async () => {
    const { store, calls } = storage();
    const upload = await store.signUpload('uploads/abc123', {
      contentType: 'image/png',
      contentLength: 2048,
      expiresInSeconds: 600,
    });
    const url = new URL(upload.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://account123.r2.cloudflarestorage.com/acme-images/uploads/abc123',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIDEXAMPLE/20261118/auto/s3/aws4_request',
    );
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
    // Firmar no habla con el almacén.
    expect(calls).toEqual([]);
    // Nunca sale la clave secreta.
    expect(upload.url).not.toContain('secret-key');
  });

  it('can also sign the content length, where the store enforces it', async () => {
    const { store } = storage(undefined, { signContentLength: true });
    const upload = await store.signUpload('uploads/abc123', {
      contentType: 'image/png',
      contentLength: 2048,
      expiresInSeconds: 600,
    });
    expect(new URL(upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
    expect(upload.headers).toEqual({ 'content-type': 'image/png' });
  });

  it('reads with a Range of one byte more than the cap, and never follows redirects', async () => {
    const { store, calls } = storage(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 206 }),
    );
    expect(await store.read('uploads/abc123', 100)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(calls[0]?.headers['range']).toBe('bytes=0-100');
    expect(calls[0]?.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261118\/auto\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('says too large without reading it all, even if the server ignores the Range', async () => {
    const declared = storage(
      () =>
        new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '5000' } }),
    );
    expect(await declared.store.read('uploads/abc123', 100)).toBe('too_large');
    const ignoring = storage(() => streamed(50_000));
    expect(await ignoring.store.read('uploads/abc123', 4096)).toBe('too_large');
    const fits = storage(() => streamed(3000));
    expect(((await fits.store.read('uploads/abc123', 4096)) as Uint8Array).length).toBe(3000);
  });

  it('answers null for what does not exist, and an empty file for an empty object', async () => {
    const missing = storage(() => new Response('<Error/>', { status: 404 }));
    expect(await missing.store.read('uploads/none', 100)).toBeNull();
    expect(await missing.store.head('uploads/none')).toBeNull();
    const empty = storage(() => new Response(null, { status: 416 }));
    expect(await empty.store.read('uploads/empty', 100)).toEqual(new Uint8Array());
  });

  it('heads an object', async () => {
    const { store, calls } = storage(
      () =>
        new Response(null, {
          status: 200,
          headers: { 'content-length': '1234', 'content-type': 'image/png' },
        }),
    );
    expect(await store.head('images/a.png')).toEqual({ size: 1234, contentType: 'image/png' });
    expect(calls[0]?.method).toBe('HEAD');
  });

  it('writes with the real hash of the body, its type and its cache policy', async () => {
    const { store, calls } = storage();
    const bytes = new TextEncoder().encode('image bytes');
    await store.write('images/a.webp', bytes, {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(calls[0]).toMatchObject({ method: 'PUT', body: bytes });
    expect(calls[0]?.headers).toMatchObject({
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-amz-content-sha256': await sha256Hex(bytes),
    });
    expect(calls[0]?.headers['authorization']).toContain(
      'SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date',
    );
  });

  it('deletes, and deleting what is not there is fine', async () => {
    for (const status of [204, 200, 404]) {
      const { store } = storage(() => new Response(null, { status }));
      await expect(store.delete('images/a.png')).resolves.toBeUndefined();
    }
  });

  it('reports a store failure without the URL, the bucket or the response', async () => {
    const { store } = storage(
      () =>
        new Response('<Error><Code>InternalError</Code><Bucket>acme-images</Bucket></Error>', {
          status: 500,
        }),
    );
    for (const operation of [
      () => store.head('images/a.png'),
      () => store.read('images/a.png', 10),
      () =>
        store.write('images/a.png', new Uint8Array(1), {
          contentType: 'image/png',
          cacheControl: '',
        }),
      () => store.delete('images/a.png'),
    ]) {
      const error = await operation().then(
        () => null,
        (caught: unknown) => caught as Error,
      );
      expect(error?.message).toMatch(/^Object storage \w+ failed with HTTP 500\.$/);
      expect(error?.message).not.toContain('acme-images');
    }
  });

  it('builds public URLs from the configured base, and refuses keys that escape it', () => {
    const { store } = storage();
    expect(store.publicUrl('images/ab12.png')).toBe('https://images.acme.test/images/ab12.png');
    for (const key of ['../secrets', '/absolute', 'images/../x', 'a b', 'images/']) {
      let error: unknown = null;
      try {
        store.publicUrl(key);
      } catch (caught) {
        error = caught;
      }
      expect(isAxedaError(error, 'AXEDA_INVALID_INPUT'), key).toBe(true);
    }
  });
});
