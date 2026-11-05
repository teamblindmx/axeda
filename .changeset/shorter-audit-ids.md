---
'@teamblind/axeda-core': patch
---

Shorten the ids of audit events from 50 to 36 characters so they fit the `id` column Better Auth creates on MySQL (`varchar(36)`); on SQLite and PostgreSQL the length was never a problem, which is why it went unnoticed. They still sort by time as text, also within one millisecond or when the clock goes back, and carry 88 random bits against collisions between processes. Events already stored keep their ids and keep their place in the order.
