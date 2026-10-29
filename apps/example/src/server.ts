import { createExample, listen } from './app.js';
import { readConfig } from './config.js';

const config = readConfig(process.env);
const example = await createExample(config);
const server = await listen(example.app, config.port);
console.log(
  `Axeda example listening on ${config.baseURL} (port ${config.port}, ${config.environment})`,
);

/** Cierra con orden: deja de aceptar peticiones, termina las que hay y cierra la base de datos. */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void example.close().then(() => process.exit(0));
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
