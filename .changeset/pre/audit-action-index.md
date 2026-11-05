---
'@teamblind/axeda-better-auth': minor
---

Index the `action` column of the audit log. Listing the audit log filtered by action read the whole table, so it got slower as the log grew (30 to 74 ms with 200,000 events in PostgreSQL 16 and 18, measured with `EXPLAIN`); with the index it takes a fraction of a millisecond. Better Auth creates the index when you run its migration. On a very large audit table, building it blocks writes to that table while it runs, so run the migration at a quiet moment. On MySQL, a table created before this version has `action` as `text`, which Better Auth will not index: run `ALTER TABLE axedaAudit MODIFY action varchar(255) NOT NULL;` before the migration (a new database is not affected).
