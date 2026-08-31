# data/

Generated static data for the Directory. Loaded at runtime by `js/data.js`.

| File | Purpose |
|------|---------|
| `meta.json` | totals, generation timestamp, facility-type vocabulary + counts |
| `facets.json` | filter dictionaries and option counts |
| `facilities.json` | facility records, each with a classified `type` + `typeSource` |
| `doctors.json` | dictionary-encoded professional records |
| `profiles/<NNN>.json` | per-professional education, work history, licences, contact |
| `reconciliation.json` | the checks the dataset passed before it was published |
| `sync-status.json` | when a validated dataset last went live |

Full schemas: see `../README.md` §5.

Regenerate everything (export → reconcile → atomic swap):

    node tools/publish.mjs --db ../backend/prisma/dev.db

The publisher refuses to swap on any FAIL, and keeps the outgoing dataset in
`data.previous/` (`node tools/publish.mjs --rollback`).
