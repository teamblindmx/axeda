import { createMemoryStorage, runObjectStorageContract } from '../src/index.js';

runObjectStorageContract('memory', async () => {
  const storage = createMemoryStorage();
  return { storage, upload: (signed, bytes) => storage.upload(signed, bytes) };
});
