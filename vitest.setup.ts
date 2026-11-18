import * as fc from 'fast-check';

/**
 * Las pruebas de propiedades usan una semilla fija: así el CI y cada máquina generan los mismos
 * casos, y una prueba que pasa no falla otro día por azar. Para explorar casos nuevos, cambia la
 * semilla con `FC_SEED` (por ejemplo `FC_SEED=$RANDOM npm test`); si una falla, fast-check imprime
 * la semilla y el camino para repetirla.
 */
const DEFAULT_SEED = 20_261_118;
const fromEnv = Number(process.env['FC_SEED']);

fc.configureGlobal({ seed: Number.isSafeInteger(fromEnv) ? fromEnv : DEFAULT_SEED });
