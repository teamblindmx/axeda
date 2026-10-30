import { afterEach } from 'vitest';

type Closer = () => Promise<void> | void;
const closers: Closer[] = [];

/**
 * Cierra las bases de datos que cada prueba abrió. Sin esto se acumulan cientos de instancias de
 * PGlite (WebAssembly) y SQLite por proceso, y el proceso de pruebas acaba muriendo de forma
 * intermitente por un fallo nativo.
 */
export function closeAfterTest(closer: Closer): void {
  closers.push(closer);
}

afterEach(async () => {
  while (closers.length > 0) {
    const closer = closers.pop();
    await closer?.();
  }
});
