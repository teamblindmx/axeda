---
'@teamblind/axeda-core': minor
'@teamblind/axeda-better-auth': minor
'@teamblind/axeda-testing': minor
---

Audit retention: set `retention.auditDays` and call `purgeAudit()` on a schedule (like `purgeDeleted()`) to delete the audit events older than that many days. Without the option the audit log is kept in full, as before, and `purgeAudit()` throws `AXEDA_INVALID_CONFIG` instead of deleting anything.

- It deletes in batches of 500 by primary key, outside a transaction, so a large backlog never holds a long lock and an interrupted run simply continues next time. No new index or migration is needed.
- A run that deletes something records an `audit.purge` event (system actor) with the cut-off and the count.
- `AuditStore` gains `deleteBefore(before, limit)`, checked by `runPersistenceContract`; `auditIdFloor` is exported for stores that key events by Axeda's audit ids.
