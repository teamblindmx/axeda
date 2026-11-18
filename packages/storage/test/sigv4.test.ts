import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, amzDates, presignUrl, signRequest, uriEncode } from '../src/sigv4.js';

/** Las credenciales y la fecha de los ejemplos de la documentación de AWS (S3, SigV4). */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
} as const;
const DATE = new Date('2013-05-24T00:00:00.000Z');
const BUCKET = 'https://examplebucket.s3.amazonaws.com';

const signatureOf = (authorization: string | undefined) =>
  /Signature=([0-9a-f]{64})$/.exec(authorization ?? '')?.[1];

describe('AWS Signature Version 4, against the examples in the AWS documentation', () => {
  it('signs a GET of an object with a Range header', async () => {
    const headers = await signRequest(AWS_EXAMPLE, {
      method: 'GET',
      url: new URL(`${BUCKET}/test.txt`),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      date: DATE,
    });
    expect(headers.authorization).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(headers.authorization).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(signatureOf(headers.authorization)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('signs a request with a query string (GET ?lifecycle and a listing)', async () => {
    const lifecycle = await signRequest(AWS_EXAMPLE, {
      method: 'GET',
      url: new URL(`${BUCKET}/?lifecycle`),
      payloadHash: EMPTY_SHA256,
      date: DATE,
    });
    expect(signatureOf(lifecycle.authorization)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
    const listing = await signRequest(AWS_EXAMPLE, {
      method: 'GET',
      url: new URL(`${BUCKET}/?max-keys=2&prefix=J`),
      payloadHash: EMPTY_SHA256,
      date: DATE,
    });
    expect(signatureOf(listing.authorization)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('presigns a GET URL valid for a day', async () => {
    const url = await presignUrl(AWS_EXAMPLE, {
      method: 'GET',
      url: new URL(`${BUCKET}/test.txt`),
      expiresInSeconds: 86_400,
      date: DATE,
    });
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('includes the content type in a presigned PUT, so another one is refused', async () => {
    const sign = (contentType: string) =>
      presignUrl(AWS_EXAMPLE, {
        method: 'PUT',
        url: new URL(`${BUCKET}/uploads/abc`),
        headers: { 'content-type': contentType },
        expiresInSeconds: 600,
        date: DATE,
      });
    const png = await sign('image/png');
    expect(png.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect((await sign('text/html')).searchParams.get('X-Amz-Signature')).not.toBe(
      png.searchParams.get('X-Amz-Signature'),
    );
  });
});

describe('the helpers', () => {
  it('encodes URIs the way SigV4 wants', () => {
    expect(uriEncode('a b/c~d_e.f-g')).toBe('a%20b%2Fc~d_e.f-g');
    expect(uriEncode('images/a b.png', true)).toBe('images/a%20b.png');
    expect(uriEncode('ñ+*')).toBe('%C3%B1%2B%2A');
  });

  it('formats the dates', () => {
    expect(amzDates(new Date('2026-11-18T19:45:46.123Z'))).toEqual({
      stamp: '20261118T194546Z',
      day: '20261118',
    });
  });
});
