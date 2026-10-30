---
'@axeda/core': patch
'@axeda/better-auth': patch
---

Fix three findings of the security review. A banned principal (for example one arriving through an API key) could still read roles, companies, businesses and other people's assignments; every use case now builds the actor's permission data in one place, which includes the ban. Listing the assignments of a scope answered differently for a company or business that exists and one that does not, which let any signed-in person probe for identifiers; both now answer the same unless the caller holds the permission globally. Every `/axeda/*` response, errors included, now carries `Cache-Control: no-store`.
