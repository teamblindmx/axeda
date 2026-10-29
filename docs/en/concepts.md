# Concepts

## The hierarchy

Axeda decides on three levels. A permission is always checked **in a scope**:

```
global                         the whole platform
 └─ company  (acme)            the isolation boundary between customers
     └─ business  (shop-1)     a branch, store or unit inside a company
```

A role assigned at a level **applies downwards**: global covers every company and business; a
company covers its businesses; a business covers only itself. Nothing ever applies upwards or
sideways, so a role in one company says nothing about another.

The **company is the isolation limit**. A business always belongs to one company, fixed when it
is created. When a request names a business, Axeda reads its company from the database and never
from the request.

## Permissions

A permission is `resource:action` (`invoice:read`); Axeda's own look like `axeda:role:manage`.

- **You declare them in code** (`axeda({ permissions: [...] })`). The list is the catalog.
- A **check** (`can`, `requirePermission`) needs a concrete permission from the catalog. A typo
  is an error at startup, never a silent “no”.
- A **role** may contain wildcards in its last segment: `invoice:*` (every action on invoices)
  or `*` (everything).
- Axeda's own permissions are only valid at some levels (for example `axeda:role:manage` is
  global-only). Because of that, a role holding `*` can only be assigned globally.

| Axeda permission          | Levels                    | Lets you                                  |
| ------------------------- | ------------------------- | ----------------------------------------- |
| `axeda:role:manage`       | global                    | Create, edit, deactivate and delete roles |
| `axeda:assignment:manage` | global, company, business | Grant and revoke roles in a scope         |
| `axeda:company:manage`    | global, company           | Manage companies                          |
| `axeda:business:manage`   | global, company           | Manage businesses                         |
| `axeda:invitation:manage` | global, company, business | Invite people                             |
| `axeda:user:manage`       | global                    | List, create, ban and unban users         |
| `axeda:audit:read`        | global, company           | Read the audit log                        |

## Roles and assignments

A **role** (called a _function_ in the Spanish docs) is a named set of permissions. Roles are
global: the same “Cashier” can be assigned in any scope. Two kinds exist:

- **Managed roles** are declared in code (`roles: { cashier: {...} }`). They are synchronised at
  startup and cannot be edited through the API (`AXEDA_ROLE_MANAGED`).
- **Created roles** are made through the API by someone with `axeda:role:manage`.

A role can require two-factor authentication (`requireMfa`). Such a role grants nothing to a user
who has not enabled 2FA, and it cannot be assigned to one.

An **assignment** links a user, a role and a scope, optionally with an expiry date. A user can
hold several. Their effective permissions in a place are the union of every assignment that
applies there and is still live.

### Nobody can raise anyone above their own level

This is the rule the whole design leans on, and it is checked on the server in every operation:

- **Granting** needs `axeda:assignment:manage` _in the target scope_, and every permission of the
  role must be covered by what the granter already holds there. An administrator of company A
  cannot grant in company B or globally.
- **Revoking** has the same requirement, so a lesser administrator cannot strip a greater one.
- **Editing a role** cannot add permissions the editor does not hold globally. Without this, a
  role manager could add `*` to their own role.
- **Acting on a user** (ban, sign out everywhere) needs `axeda:user:manage` and enough
  administrative power to cover the target's. Support staff cannot ban the global administrator,
  and nobody can ban themselves.

A property test throws random sequences of operations at the API and asserts that nobody ends up
above the initial ceiling.

## Denial: 403 versus 404

Axeda denies by default. When a request is refused:

- **403** when you can see the thing but may not do this.
- **404** when you would not be allowed to know it exists (a company you do not belong to).

Permission is checked **before** the input is validated or anything is revealed, so a missing
permission gives the same answer for a real id and for an invented one.

## Companies and businesses

Both are `active` or `inactive`, and can be **soft-deleted**. Deleting keeps the record for a
grace period (30 days by default, `retention.graceDays`) during which it can be restored;
`purgeDeleted()` removes expired ones for good (you call it, for example from a cron job — Axeda
runs nothing in the background). An inactive or deleted company, and everything inside it,
**grants nothing**: assignments there stop counting. A business inherits its company's state.

## Invitations

An invitation names an email, a scope and the roles to grant. Axeda generates a secret (256 bits;
only its hash is stored) and hands it to **your** delivery callback. The person accepts with that
secret **and a verified email that matches**, so a leaked link alone is worthless. Invitations
expire, can be revoked, and are single use.

## Users

Axeda does **not** handle passwords. `user/create` makes an account **without any credential**
and never marks the email as verified; the person sets a password through the normal Better Auth
flow. A **ban** (optionally until a date):

1. blocks new sessions,
2. closes the open ones,
3. leaves the user with no permissions at all, even through a path that never opens a session,
   such as an API key.

A timed ban lifts itself when its date passes; no job is needed.

## Menus

You declare the menu in code. Every item with a path must say which permission it requires; a
group has neither and shows only if a child is visible. Axeda validates the menu at startup
(unique keys, no cycles, at most 3 levels, safe paths) and returns each person only what they can
use in the requested scope, in their language, with the extra actions they may perform. **A menu
is a convenience, not security**: the server enforces every permission regardless.

## Immediate revocation

Each user carries a version number that goes up whenever their assignments or status change, and
a global one goes up when roles change. Cached permissions are only used if both versions still
match what the database says, so revoking a permission takes effect on the very next request, on
every server instance.

## Audit

Every administrative action, success or denial, is appended to an audit log: who, what, on which
target, in which scope, from which address. It is append-only; denials are recorded even though
the operation was rolled back. Read it through `GET /axeda/audit/list` with `axeda:audit:read`.
