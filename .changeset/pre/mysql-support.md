---
'@teamblind/axeda-better-auth': minor
---

Support MySQL (8.4 and 9, tested against real servers with a connection pool). Give Better Auth the pool from `mysql2/promise` (not the one from `mysql2`) created with `timezone: 'Z'`; without it the driver converts dates to the local time of your process. On a server that stores table names in lowercase (`lower_case_table_names` 1 or 2: Windows, macOS and some managed services) Better Auth's schema check reports Axeda's tables as missing, so turn it off with `advanced: { database: { validateSchema: false } }`. The reference lists both, and what to do when upgrading an existing MySQL database.
