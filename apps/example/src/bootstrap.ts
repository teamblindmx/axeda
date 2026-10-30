/**
 * Convierte a una persona en la primera administradora global. Es una operación del SERVIDOR
 * (se corre en tu máquina o en el despliegue), no de la API: nadie puede pedirla por HTTP.
 *
 *   npm run bootstrap -w @teamblind/axeda-example -- admin@example.com
 *
 * La persona debe haberse registrado antes y tener el correo verificado. Solo funciona una vez.
 */
import { createExample, type ExampleApp } from './app.js';
import { readConfig } from './config.js';

async function promote(example: ExampleApp, email: string): Promise<void> {
  const user = await example.findUserByEmail(email);
  if (user === null) {
    throw new Error(`No user with the email ${email}. Sign up first.`);
  }
  if (!user.emailVerified) {
    throw new Error(`The email ${email} is not verified yet. Open the verification link first.`);
  }
  await example.axeda.bootstrap({ userId: user.id });
  console.log(`${email} is now a global administrator.`);
}

async function main(): Promise<number> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (email === undefined || email === '') {
    console.error('Usage: npm run bootstrap -w @teamblind/axeda-example -- <email>');
    return 1;
  }
  const example = await createExample(readConfig(process.env));
  try {
    await promote(example, email);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await example.close();
  }
}

process.exitCode = await main();
