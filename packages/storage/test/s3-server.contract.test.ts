import { runObjectStorageContract } from '@teamblind/axeda-testing';
import { beforeAll, describe, it } from 'vitest';
import { s3Storage } from '../src/index.js';
import { EMPTY_SHA256, signRequest } from '../src/sigv4.js';

/**
 * El contrato de `ObjectStorage` contra un servidor S3 de verdad que comprueba las firmas. En el CI
 * es SeaweedFS; en local, cualquiera (MinIO, R2 con un bucket de pruebas…) con estas variables.
 */
const ENDPOINT = process.env['AXEDA_TEST_S3_ENDPOINT'] || undefined;
const ACCESS_KEY = process.env['AXEDA_TEST_S3_ACCESS_KEY'] ?? '';
const SECRET_KEY = process.env['AXEDA_TEST_S3_SECRET_KEY'] ?? '';
const BUCKET = process.env['AXEDA_TEST_S3_BUCKET'] ?? 'axeda-contract';
const REGION = process.env['AXEDA_TEST_S3_REGION'] ?? 'us-east-1';

/** Crea el bucket si no existe (409 si ya es nuestro). */
async function ensureBucket(endpoint: string): Promise<void> {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${BUCKET}`);
  const headers = await signRequest(
    { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: REGION },
    { method: 'PUT', url, payloadHash: EMPTY_SHA256, date: new Date() },
  );
  const response = await fetch(url, { method: 'PUT', headers });
  await response.body?.cancel();
  if (!response.ok && response.status !== 409) {
    throw new Error(`Could not create the test bucket: HTTP ${response.status}`);
  }
}

if (ENDPOINT === undefined) {
  describe('ObjectStorage contract: a real S3 server', () => {
    it.skip('needs AXEDA_TEST_S3_ENDPOINT, AXEDA_TEST_S3_ACCESS_KEY and AXEDA_TEST_S3_SECRET_KEY', () => {});
  });
} else {
  const endpoint = ENDPOINT;
  beforeAll(() => ensureBucket(endpoint));
  runObjectStorageContract(`a real S3 server (${endpoint})`, async () => ({
    storage: s3Storage({
      endpoint,
      bucket: BUCKET,
      region: REGION,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      publicBaseUrl: 'https://images.axeda.test',
    }),
    // Lo que hace el navegador: PUT a la URL firmada con las cabeceras que se le dieron.
    async upload(signed, bytes) {
      const response = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: bytes,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`The store refused the upload: HTTP ${response.status}`);
    },
  }));
}
