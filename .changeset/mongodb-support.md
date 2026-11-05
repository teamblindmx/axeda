---
'@teamblind/axeda-better-auth': minor
---

Support MongoDB (7.0 and 8.0, on a replica set; a single node is enough). Give Better Auth `mongodbAdapter(db, { client })`. MongoDB has no migrations in Better Auth, so Axeda writes once, before its first transaction, in each of its collections so that the adapter creates them and their indexes outside of a transaction, where a first use made the transaction hang. On a standalone `mongod` Axeda now stops at start with `AXEDA_TRANSACTIONS_UNSUPPORTED` and says what to do.

The unique constraints of Axeda's tables (role key, company slug, the policy state key and the pending invitation key) are now declared as unique table indexes instead of `unique` fields, because Better Auth's MongoDB adapter only creates table indexes, and without them two simultaneous writes with the same key both succeeded. On SQL they are the same constraint: running Better Auth's migration on an existing database adds the unique indexes next to the old column constraints (four small extra indexes), keeps every row and still refuses duplicates, which a test checks against the schema of 0.1.0-alpha.0.
