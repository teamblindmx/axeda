import { createMemoryPersistence, runPersistenceContract } from '../src/index.js';

runPersistenceContract('in-memory', () => createMemoryPersistence());
