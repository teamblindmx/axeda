# Quick start

> Axeda is in alpha. Install it with the `alpha` tag (step 2), or work from a clone of the repository
> to run the example (step 1). The commands below are the ones the example's own test suite runs, so
> they stay true.

## 1. Run the example

```bash
git clone https://github.com/teamblindmx/axeda.git && cd axeda
npm install
```

The example needs three settings. There are no defaults for the secret or the URL on purpose.

```bash
export NODE_ENV=development
export BASE_URL=http://localhost:3000
export BETTER_AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))")"
npm start -w @axeda/example
```

On PowerShell use `$env:NODE_ENV='development'` and so on. Keep the same variables in the
terminal where you run the next commands.

**Create the first administrator.** Sign up, open the verification link, then promote the account:

```bash
curl -s -X POST $BASE_URL/api/auth/sign-up/email \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"email":"admin@example.com","name":"Admin","password":"a-long-password-123"}'
```

The example prints the verification email in its console (`[dev mailer] … link=…`). Open that
link, then, from the repository root:

```bash
npm run bootstrap -w @axeda/example -- admin@example.com
```

`bootstrap` is a **server operation**, not an API call: nobody can request it over HTTP. It
works once, and only for an account whose email is verified.

**Call the API.**

```bash
curl -s -c jar -X POST $BASE_URL/api/auth/sign-in/email \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"email":"admin@example.com","password":"a-long-password-123"}'

curl -s -b jar $BASE_URL/api/auth/axeda/me          # your permissions: ["*"]
curl -s -b jar -X POST $BASE_URL/api/auth/axeda/company/create \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"slug":"acme","name":"ACME"}'
curl -s -b jar $BASE_URL/invoices                    # a route of the example, protected by Axeda
```

The whole story — a cashier limited to one company, invitations, bans, the menu — runs as a test:
[`apps/example/test/example.test.ts`](../../apps/example/test/example.test.ts).

## 2. Add Axeda to your app

Install the alpha: `npm install @axeda/core@alpha @axeda/better-auth@alpha @axeda/express@alpha better-auth express`.

**Declare your permissions, and the roles that ship with your app.** Everything else is data.

```ts
import { axeda, secureAuthOptions, sessionPrincipal } from '@axeda/better-auth';

const axedaPlugin = axeda({
  permissions: ['invoice:read', 'invoice:create', 'invoice:delete', 'report:read'],
  roles: {
    viewer: { name: 'Viewer', permissions: ['invoice:read', 'report:read'] },
    cashier: { name: 'Cashier', permissions: ['invoice:read', 'invoice:create'] },
  },
  // Axeda generates the invitation secret; you decide how it is delivered.
  invitationDelivery: {
    acceptUrl: (token) => `https://app.example.com/accept?token=${encodeURIComponent(token)}`,
    send: ({ email, link }) => mailer.send({ to: email, subject: 'You are invited', link }),
  },
});
```

**Create Better Auth with the recommended settings, plus the plugin.**

```ts
const options = {
  ...secureAuthOptions({
    baseURL: 'https://api.example.com',
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: ['https://app.example.com'],
  }),
  database, // a better-sqlite3 handle, a pg Pool…
  plugins: [axedaPlugin],
  // Required because the preset asks for verified emails:
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) =>
      mailer.send({ to: user.email, subject: 'Verify', link: url }),
  },
};
await (await getMigrations(options)).runMigrations(); // creates Axeda's tables
const auth = betterAuth(options);
await auth.$context;
await axedaPlugin.start(); // checks the database really has transactions, syncs your roles
```

`start()` refuses to continue on a database without real transactions. See [Security](security.md)
for what `secureAuthOptions()` fixes and why.

**Mount it, then guard your routes.**

```ts
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { createAxedaExpress, resolveScope } from '@axeda/express';

const x = createAxedaExpress({
  axeda: axedaPlugin.instance(),
  principal: sessionPrincipal(auth),
  trustedOrigins: ['https://app.example.com'],
});

const app = express();
app.all('/api/auth/*splat', toNodeHandler(auth)); // BEFORE express.json()
app.use(express.json());

app.get(
  '/companies/:companyId/invoices',
  x.requirePermission('invoice:read', { scope: resolveScope({ company: 'companyId' }) }),
  (req, res) => res.json({ company: req.params.companyId }),
);
```

More patterns (businesses, lists, single resources) are in [Protecting routes](express.md).

**From the browser,** use the typed client:

```ts
import { createAuthClient } from 'better-auth/client';
import { axedaClient } from '@axeda/better-auth/client';

const client = createAuthClient({ baseURL: 'https://api.example.com', plugins: [axedaClient()] });
const { data } = await client.axeda.menu({
  query: { scopeType: 'company', scopeId, locale: 'en' },
});
```

## Troubleshooting

| You see                                                             | Cause and fix                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AXEDA_INVALID_CONFIG … session.cookieCache`                        | Axeda does not run with Better Auth's cookie cache: a revoked permission would stay valid until the cookie expires. Disable it |
| `AXEDA_INVALID_CONFIG … disableCSRFCheck` (or `disableOriginCheck`) | Those options remove the defence of every `/axeda/*` endpoint. Remove them                                                     |
| `AXEDA_TRANSACTIONS_UNSUPPORTED`                                    | The database adapter has no real transactions. Use SQLite or PostgreSQL                                                        |
| Sign-in answers `403` right after sign-up                           | The preset requires a verified email. Open the link your `sendVerificationEmail` delivered                                     |
| `429` while testing                                                 | The preset rate-limits sign-in (5/min) and sign-up (5/5 min) per address                                                       |
| Better Auth logs `Field roleIds … Expected string[] but got TEXT`   | Cosmetic on SQLite: Better Auth compares `string[]` fields with a JSON column and SQLite has none. Nothing is wrong            |
| Every guarded route answers `403` for an administrator              | Check the route's scope: a company id that does not exist is denied exactly like a missing permission                          |
