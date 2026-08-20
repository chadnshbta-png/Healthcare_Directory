# data/

Generated static data for the Directory. Loaded at runtime by `js/data.js`.

| File | Purpose |
|------|---------|
| `meta.json` | totals + generation timestamp |
| `facets.json` | filter dictionaries and option counts |
| `facilities.json` | facility records |
| `doctors.json` | dictionary-encoded professional records |

Full schemas: see `../README.md` §5.
Regenerate with: `node tools/export-data.mjs --db <path-to-source.db>`
