# Doctorna — Healthcare Directory

A self-contained, dependency-free frontend package for the Doctorna Healthcare
Directory. It ships with the full dataset (102,424 licensed professionals and
5,652 facilities) as static JSON and runs entirely in the browser.

Everything needed to run, understand and integrate the Directory is inside this
folder. Nothing outside it is referenced.

---

## 1. What this is

A production-shaped Directory page providing:

* instant search across professionals, specialties and facilities
* six combinable filter facets with live counts
* two result modes — **Doctors** and **Facilities**
* sorting, incremental loading, shareable filtered URLs
* full responsive + keyboard-accessible behaviour

It is a **frontend package**. There is no build step, no framework, no backend.
Data is read from `./data/*.json`; swapping that for an API is a change to one
file (§14).

---

## 2. Folder structure

```
Healthcare_Directory/
├── index.html                 ← entry point (open this)
├── styles.css                 ← all styling; brand tokens at the top
├── serve.py                   ← zero-dependency dev server (recommended)
├── favicon.svg / favicon.ico  ← tab icon
├── js/
│   ├── boot-guard.js          ← classic script: reports failures a module can't
│   ├── main.js                ← entry module: boot + event wiring
│   ├── data.js                ← data loading + row accessors  ← swap for API here
│   ├── state.js               ← UI state + URL query-string sync
│   ├── query.js               ← search, filtering, facet counts, sorting
│   ├── filters.js             ← filter panel UI
│   ├── render.js              ← cards, chips, counts, states
│   ├── detail.js              ← #/doctor/<id> and #/facility/<id> views
│   └── utils.js               ← shared helpers
├── data/
│   ├── meta.json              ← totals + generation timestamp   (~0.5 KB)
│   ├── facets.json            ← filter dictionaries + counts    (~604 KB)
│   ├── facilities.json        ← facility records                (~1.7 MB)
│   └── doctors.json           ← professional records            (~5.0 MB)
├── assets/
│   └── Doctorna-Homepage-Reference.html   ← design reference only, not loaded
├── tools/
│   └── export-data.mjs        ← optional: regenerate data/ from a source DB
└── README.md
```

**Entry points:** `index.html` → `js/main.js` → everything else.

---

## 3. How to run it

The page fetches JSON, so it must be served over **http**, not opened from disk.
Opening `index.html` directly shows an explicit error telling you the same.

**Recommended — the bundled server:**

```bash
python serve.py             # http://localhost:8080, opens your browser
python serve.py 3000        # pick another port
```

`serve.py` is standard-library only (no install). It exists because the obvious
alternative, `python -m http.server`, has two defaults that actively break this
page:

* **It speaks HTTP/1.0**, so it closes the connection after every response and
  offers no keep-alive. Downloading the 5 MB `doctors.json` over that can stall
  or be dropped mid-stream, which the page then reports as a load failure.
  `serve.py` sets `protocol_version = "HTTP/1.1"`.
* **It can serve `.js` with the wrong MIME type** on Windows, because Python
  reads that mapping from the registry. Browsers then refuse to execute the
  modules. `serve.py` pins the types it needs.

It also sends `Cache-Control: no-cache`, so every request is revalidated (a
`304` still serves from cache) and you never look at a stale file.

Any other *real* static server works too — `npx serve .`, `php -S localhost:8080`,
nginx, S3, Netlify. Only `python -m http.server` is specifically discouraged.

Then open `http://localhost:8080`.

To deploy, upload the folder as-is to any static host. No build, no install.

---

## 4. How data is loaded

`js/data.js` → `loadDirectory()`:

1. `meta.json` loads first with `cache: 'no-cache'` — always revalidated, and it
   carries `generatedAt`, which becomes the version token for everything else.
2. `facets.json` loads next (small) so the filter UI has its dictionaries.
3. `facilities.json` and `doctors.json` load in parallel, each requested as
   `…json?v=<generatedAt>`.
4. Names are folded once into a search index (`db.foldedName`), and each
   facility's most common specialties are tallied from the rows.
5. `db` is populated and the app renders.

Everything after that is in-memory. No further network calls.

### Why the URLs are versioned

A regenerated dataset changes `generatedAt`, which changes the query string,
which is a new URL — so it downloads fresh. An unchanged dataset keeps the same
URL and comes straight from cache. Fresh **and** fast.

This replaced two earlier approaches that each failed one half of that:

| Approach | Problem |
|---|---|
| `cache: 'force-cache'` | Pinned the first response forever. Regenerated data was never picked up, so the app silently ran on stale data. |
| `cache: 'no-store'` | Always fresh, but re-downloaded 7.6 MB on every single visit. |

Parsing is `await res.json()` — native, ~10 ms for the 5 MB file. An earlier
version read `res.body` chunk-by-chunk to drive a byte-level progress bar; that
hand-rolled reader could stall after the final chunk and leave the page pinned
on "Loading…" with no error to show for it. The skeleton UI covers the wait
instead, and it is over in well under a second on localhost.

---

## 5. Data schemas

### `meta.json`
```jsonc
{
  "generatedAt": "2026-08-19T...Z",
  "version": 1,
  "totals": {
    "doctors": 102424, "facilities": 5652, "facilitiesWithDoctors": 5505,
    "doctorFacilityLinks": 70554, "specialties": 441, "categories": 5,
    "nationalities": 167, "languages": 74, "doctorsWithContact": 22395
  },
  "flags": { "MOBILE": 1, "EMAIL": 2, "LINKEDIN": 4, "EXPERIENCE": 8, "EDUCATION": 16 },
  "rowSchema": ["id","name","categoryIdx","specialtyIdx","licenseTypeIdx",
                "nationalityIdx","facilityIdx","languageIdxs","flags"]
}
```

### `doctors.json` — dictionary-encoded rows
Rows are **arrays, not objects**, to keep the payload at 5 MB instead of ~18 MB.
Index positions are documented in `meta.rowSchema` and mirrored by the `R`
constant in `js/data.js`.

```jsonc
{ "version": 1, "count": 102424,
  "rows": [
    ["94316348", "AABIDA SULTANA", 1, 87, 0, 12, 341, [0], 3]
  ] }
```

| Pos | Field | Type | Notes |
|-----|-------|------|-------|
| 0 | `id` | string | **DHA unique id** — the real, stable identifier |
| 1 | `name` | string | as published |
| 2 | `categoryIdx` | int | → `facets.dict.category`, `-1` if absent |
| 3 | `specialtyIdx` | int | → `facets.dict.specialty` |
| 4 | `licenseTypeIdx` | int | → `facets.dict.licenseType` |
| 5 | `nationalityIdx` | int | → `facets.dict.nationality` |
| 6 | `facilityIdx` | int | → `facets.dict.facility`; also indexes `facilities.json` |
| 7 | `languageIdxs` | int[] | → `facets.dict.language` |
| 8 | `flags` | int | bitmask, see `meta.flags` |

`speciality` in the source is `"Category-Specialty"` (e.g.
`"Physician-General Practitioner"`); the exporter splits it into the two
dictionaries so both can be filtered independently.

### `facets.json`
```jsonc
{ "version": 1,
  "dict": { "category": [...], "specialty": [...], "licenseType": [...],
            "nationality": [...], "language": [...], "facility": [...] },
  "facets": { "category": [{ "i": 0, "label": "Physician", "count": 24348 }, ...], ... } }
```
`dict` resolves row indices to labels. `facets` provides the initial option
lists with global counts (live counts are recomputed client-side per query).

### `facilities.json`
```jsonc
{ "version": 1,
  "facilities": [
    { "id": "cme...", "slug": "rashid-hospital-dubai-health",
      "name": "Rashid Hospital - Dubai Health", "type": "hospital",
      "doctorCount": 2656, "inDhaMasterList": true,
      "sourceUrl": "https://services.dha.gov.ae/..." }
  ] }
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | stable facility identifier — use for `/facility/<id>` |
| `slug` | string | URL-friendly, unique (suffixed on collision) |
| `name` | string | trimmed display name |
| `type` | string\|null | `hospital`,`clinic`,`pharmacy`,`dental`,`laboratory`,`optical`,`polyclinic`,`medical_center`,`center` — **inferred from the name, not published by DHA** |
| `doctorCount` | int | current professionals linked to this facility |
| `inDhaMasterList` | bool | present in the DHA facility list |
| `sourceUrl` | string\|null | deep link to the DHA directory |

Array order matches `dict.facility` for the first 5,652 entries, so
`facilityIdx` resolves directly. Indices **beyond** that are facility names
that appear on professionals but have no facility record — the name still
displays, but no facility link is offered.

### Doctor↔Facility relationship
Flattened into `facilityIdx` for the frontend. The underlying source models it
as a separate relationship carrying `relationType`, `isCurrent`, `matchStatus`,
`matchConfidence` and `matchMethod`. **Only current, confidently-matched links
are exported** (70,554 of them). Historical employment is deliberately excluded
— see §20.

---

## 6. Search behaviour

Implemented in `js/query.js`.

* Case- and accent-insensitive; punctuation is ignored.
* Multiple words are **ANDed**: `derma dubai` requires both.
* Each term matches against **name, specialty, category or facility**.
* A query of 4+ digits also matches the **DHA id** (`94316348`).
* Debounced 130 ms; results update without reload.

Performance: terms are resolved against the small dictionaries once per query,
so the 102k-row scan is integer set lookups — a full search runs in **~18 ms**.

---

## 7. Filter behaviour

Six facets, all combinable, all ANDed across facets and ORed within a facet:

| Filter | Source field | Options | UI |
|--------|--------------|---------|-----|
| Professional category | `category` | 5 | chips |
| Specialty | `specialty` | 441 | searchable list |
| Facility | `facility` | 5,652 | searchable list |
| Language | `languages` | 74 | searchable list |
| Nationality | `nationality` | 167 | searchable list |
| Licence type | `licenseType` | 4 (FTL/PTL/REG/TRL) | chips |
| Facility type | `facilityType` | hospital · clinic · pharmacy · medical centre · dental · optical · laboratory · other | chips |
| Profile data | `flags` + row shape | has facility · has contact details · has languages · has education | switches |

Each option shows a **live count** recomputed against all *other* active filters,
so ticking one specialty does not zero out the rest of the list. Long lists are
searchable and collapsed to the top few with "Show all N".

**Deliberately not offered:** gender and location. The source data contains
neither, and the brief was explicit that filters must not be invented.

---

### Facility type — a derived facet

Facilities carry a real `type` field, but professionals only reference a
facility, not its type. `data.js` interns the types into their own dictionary
and stamps every row with the type of the facility it links to (`db.rowFType`),
so filtering and counting on it costs exactly what the other facets cost. The
homepage "network" tiles drive this facet.

### What this dataset does NOT contain

Two things are worth stating plainly, because directories of this kind usually
have them and this one does not:

* **No city or emirate field.** This is the *Dubai* Health Authority register,
  so every record is Dubai-licensed. There is no per-emirate breakdown to show,
  and facility names mention Abu Dhabi, Ajman, RAK, Fujairah and Umm Al Quwain
  exactly zero times. A "healthcare across the UAE, city by city" section would
  be fabricated, so the homepage groups the network by **facility type**
  instead — a real field with real counts.
* **No insurance data.** Nothing in the register lists accepted insurers, so
  there is no insurance filter.

Both are deliberate omissions, not oversights.

## 8. Sorting

`Relevance` (default), `Name A–Z`, `Name Z–A`, `Specialty`, `Facility`.
Relevance ranks exact/prefix name matches first when searching; with no search
term it keeps the natural name order (cheap, and avoids re-sorting 102k rows on
every keystroke).

---

## 9. Pagination

24 results per page via **Load more**. Only the visible slice is ever rendered —
the DOM never holds more than the loaded cards regardless of the 102k dataset.

---

## 10. URL / query parameters

State is mirrored to the query string via `history.replaceState`, so any
filtered view is shareable and bookmarkable.

| Param | Meaning | Example |
|-------|---------|---------|
| `view` | `doctors` \| `facilities` | `view=facilities` |
| `q` | search text | `q=dermatology` |
| `cat` | categories, `~`-separated | `cat=Physician~Dentist` |
| `spec` | specialties | `spec=General%20Practitioner` |
| `fac` | facilities | `fac=Rashid%20Hospital%20-%20Dubai%20Health` |
| `lang` | languages | `lang=Arabic~English` |
| `nat` | nationalities | `nat=India` |
| `lic` | licence types | `lic=FTL` |
| `ftype` | facility types, `~` separated | `ftype=hospital~clinic` |
| `layout` | result layout | `layout=list` |
| `has` | profile filters, comma-separated | `has=facility,contact` |
| `sort` | sort key | `sort=name-asc` |
| `page` | page number | `page=3` |

Example: `?view=doctors&cat=Physician&spec=Dermatology&lang=Arabic&sort=name-asc`

---

## 11. Routing — doctor & facility detail

Hash routes, using the **real identifiers** from the data:

| Route | Shows |
|-------|-------|
| `#/doctor/<dhaUniqueId>` | name, category, specialty, licence type, DHA ID, nationality, languages, current facility (linked), which contact details and records DHA publishes, and a link to the source profile |
| `#/facility/<facilityId>` | name, type, DHA listing status, linked professional count, and a searchable list of that facility's professionals (first 60) |

Detail views render as an overlay over the directory and are wired in
`js/main.js` → `applyRoute()`. Returning to the directory **keeps every active
filter**, because filters live in the query string and the detail route only
changes the hash.

Fields absent from the data are simply not rendered — no empty rows.

**Not bundled:** contact values, work-history text and education text. The
dataset records *whether* DHA publishes them (as flags, which power the filters
and the "Records held by DHA" row) but not the values themselves. The detail
view says so plainly and links to the DHA profile for the rest.

## 11b. Initialisation lifecycle (and why it is explicit)

`js/main.js` runs one ordered lifecycle and nothing else may render outside it:

```
init()
  -> checkVersion()      HTML and JS must come from the same build
  -> shell wiring        controls that work even if data never arrives
  -> loadData()          fetch + parse + derive, then ASSERT it populated
  -> initState()         restore URL-derived state onto the controls
  -> renderDirectory()   the product itself - critical, must succeed
  -> renderSections()    discovery sections - each optional and isolated
  -> applyRoute()        detail overlay if the hash asks for one
```

Two rules this structure exists to enforce:

1. **The visitor is never stranded on a skeleton.** If the data loads but the
   directory cannot be painted, the error state appears with real diagnostics.
   A silent perpetual "Loading..." is treated as a bug, not an edge case.
2. **A broken decorative section cannot take the directory down.** Every step
   runs through `step()`, which catches, records, and — for a section — hides
   that section so no empty heading is left behind. Non-fatal problems are
   exposed on `window.__directoryProblems` and logged once as a warning.

`renderDirectory()` runs *before* any discovery section, so the directory is on
screen at the earliest possible moment.

### The version handshake

`index.html` carries `<meta name="app-version">` and `main.js` carries a
matching `APP_VERSION`. If they differ, the page reloads once with a cache-
busting parameter (guarded by `sessionStorage` so it cannot loop); if they still
differ it shows "This page is out of date" with the exact versions.

This exists because of a real failure: a static server that sends **no cache
headers** — notably `python -m http.server` — lets a browser keep an old
`index.html` while fetching new modules. The two halves then disagree about
which elements exist, the app dies on a null reference, and the visitor is left
on the loading skeleton with populated hero figures above it. **Use
`python serve.py`**, which sends `Cache-Control: no-cache` and speaks HTTP/1.1.
If you must use another server, the handshake will catch the mismatch.

## 12. States & diagnostics

Three states, and only ever one of them at a time:

* **Loading** — a grid of skeleton cards in the same shape as real results, so
  the layout does not collapse and then jump back. Progress is announced to
  screen readers via a visually hidden `role="status"` line. Nothing else on the
  page waits for data, so the hero, search module and editorial sections are
  already there while the 5 MB payload arrives.
* **Empty** — shown *only* when a real query returns zero rows. Nothing renders
  at all until the dataset is in memory (`if (!db.ready || !db.rows.length)
  return;` guards the render pass), so an early click can never paint an empty
  directory over the loading state.
* **Error** — shown *only* when loading genuinely failed. A visitor sees
  "Something went wrong while loading the directory." / "Please try again." and
  a **Try again** button. The full diagnostics (file, URL, HTTP status, error,
  stack) are kept, but folded behind a quiet **Technical details** toggle that
  is collapsed by default.

The error state names **the exact file and URL that failed**, e.g.
`Could not load data/doctors.json` with `Server responded 404 Not Found`, plus a
**Technical details** panel (collapsed by default) carrying the full URL and
stack. Each JSON file is fetched and parsed independently so the failure can be
attributed precisely.

`js/boot-guard.js` is a **classic script, deliberately not a module**. Browsers
refuse to load ES modules over `file://`, so without it a page opened from disk
would sit on "Loading…" forever with nothing to explain why. The guard detects
that case immediately and prints the exact commands to run. It also catches the
module failing to execute for any other reason (missing `js/` folder, wrong MIME
type, JavaScript error) — but never fires merely because loading is slow.

## 13. Accessibility

Semantic landmarks, skip link, labelled controls, `aria-pressed` on toggles,
`role="switch"` on the profile-data filters, `aria-expanded` + `aria-controls`
on every collapsible filter group and on the Filters drawer trigger, tab/panel
semantics on the view switch, `aria-live` result count, `aria-current` on the
breadcrumb leaf, visible focus rings, Escape closes the drawer and nav, focus
moves to the Back button when a detail view opens, and full
`prefers-reduced-motion` support.

---

## 14. Replacing local data with an API

**`js/data.js` is the only file that needs to change.** Replace the body of
`loadDirectory()` so it populates the same `db` object:

```js
db.meta        // { totals: {...} }
db.dict        // { category:[], specialty:[], licenseType:[], nationality:[], language:[], facility:[] }
db.facets      // { category:[{i,label,count}], ... }
db.rows        // array of row tuples (see §5)
db.facilities  // array of facility objects
db.foldedName  // fold(name) per row — build after loading
```

Nothing else imports `fetch`.

### Suggested API contract

```
GET /api/directory/meta        → meta.json shape
GET /api/directory/facets      → facets.json shape
GET /api/directory/facilities  → facilities.json shape
GET /api/directory/doctors     → doctors.json shape
GET /api/doctors/:dhaUniqueId  → full profile
GET /api/facilities/:id        → facility + its professionals
```

For server-side filtering instead of client-side, have
`GET /api/directory/doctors` accept the §10 query parameters and return
`{ total, page, pageSize, rows }`. Then call it from `runQuery()` in
`js/query.js` and drop the in-memory scan — the rest of the UI is unaffected.

### Regenerating the static data

```bash
node tools/export-data.mjs --db /path/to/source.db
```
Reads a DHA-shaped SQLite database (tables `Doctor`, `Facility`,
`DoctorFacility`), writes `data/*.json`. Read-only; the path is always supplied
by the caller. **Not needed to run the site** — the data is already generated.

---

## 15. Dependencies

**None.** No framework, no bundler, no npm install, no runtime library.

One external request: **Google Fonts** (Manrope + IBM Plex Mono), matching the
Doctorna homepage. To remove it, delete the two `<link>` tags in `index.html`;
the `--font` / `--mono` stacks in `styles.css` fall back to system fonts. To
self-host, drop the woff2 files into `assets/` and add an `@font-face` block.

---

## 16. Design language

Doctorna brand blue on a light blue-tinted neutral canvas. Tokens are defined
once at the top of `styles.css` and taken from
`assets/Doctorna-Homepage-Reference.html`, which uses `#2899E5` and `#0C1F33`
more than any other colours.

* **Primary** `#2899E5` — the single accent. Deep `#1B7ABF`, ink `#14608F`,
  wash `#EDF6FE`, hairline `#C7E3F8`
* **Ink** `#0F1E32` · **Secondary ink** `#334155` · muted `#55697C` / `#7C8EA0`
* **Canvas** `#F5F8FC` · **Cards** `#FFFFFF` · borders `#DFE8F2` / `#D8E4F0`
* **Dark surfaces** `#0F1E32` for the utility bar, network tiles, CTA and footer
* Radii 16–24px on large surfaces, 8–12px on controls; shadows deliberately shallow
* Type: **Manrope** for everything editorial, **IBM Plex Mono** confined to
  micro-labels and figures

Blue is used to *mean* something — verified status, primary action, active
state, the lead statistic — not as general decoration. There is no secondary
brand colour; informational surfaces are neutral slate so the blue keeps its
meaning. **No green is used anywhere**, and the build is checked for it: a
verification pass walks every painted `color` / `background-color` /
`border-color` in the rendered page and fails if any green-dominant value
appears.

**Page composition**

1. Thin dark utility bar (source, for clinics, help, language)
2. Glass header that shrinks on scroll
3. **Vertical hero** — eyebrow, headline, accent line, supporting text, trust
   indicators, unified search, popular chips, then the four dataset figures
4. The directory, immediately below (starts ~876px from the top at 1440)
5. Network grid, trust row, featured facilities, specialty explorer, CTA,
   browse columns, FAQ, footer

The hero is a single centred column ~768px tall. The search module is the
focal point: one large query field over a row of Category / Specialty /
Facility and the primary action, all inside one bordered surface that lights up
in brand blue on focus — a unified search system rather than four inputs.

## 17. Responsive behaviour

Verified at 1440 / 1280 / 1024 / 860 / 768 / 640 / 390 / 375 px.

* **≥1180px** — 296px sticky filter rail + fluid results grid, two-column hero
* **1024–1180px** — narrower rail, denser cards
* **<1024px** — hero stacks; primary nav collapses behind the menu button; the
  hero's floating card hands its figure to a third stat column so nothing overlaps
* **<900px** — the rail becomes a **left slide-in drawer** with its own
  clear/apply footer; a Filters button with an active-count badge appears in the
  toolbar; the directory bar stacks and the view switch goes full width
* **<768px** — stacked search, single-column detail grid
* **<640px** — single-column cards, full-width sort
* **<400px** — reduced padding, brand wordmark hidden

**No horizontal overflow at any of those widths** — measured directly
(`documentElement.scrollWidth - clientWidth === 0` at all eight), not eyeballed.
The search module's mode strip scrolls horizontally *inside itself* by design;
it cannot move the page.

---

## 18. Performance

Measured against the real 102,424-row / 5,652-facility dataset (median of 7
runs, V8):

| Operation | Time |
|-----------|------|
| Load + parse + derive (all four files) | ~265 ms |
| Full unfiltered scan | **2.4 ms** |
| Search, one term (`"cardio"`) | **9.6 ms** |
| Search, two terms | **9.8 ms** |
| One facet selected | **4.1 ms** |
| Two facets selected | **3.1 ms** |
| Two facets + two profile filters | **3.4 ms** |
| Filter panel refresh — 6 groups, nothing selected | 21.3 ms |
| Filter panel refresh — 6 groups, two selected | 8.7 ms |
| Profile-data counts (all four) | 10.3 ms |
| Sort by name over 102k | 12.3 ms |
| Facilities view | 0.9 ms |

Search and filtering are both **well under the 50 ms interaction budget**, and a
full filter click (query + panel refresh + counts + render) lands around 40 ms
worst case.

Two things keep it there:

* **Dictionary-encoded rows.** Every row is an array of integer indices into
  shared dictionaries, so the hot loop compares ints, never strings. That is also
  why the payload is 5 MB rather than ~18 MB.
* **Facet counts reuse the current result set.** A facet's counts must ignore
  that facet's own selection — but if nothing is selected in it, ignoring the
  selection changes nothing, so those counts are tallied off the existing match
  array instead of re-running the query. With the usual one or two active facets
  that turns six full passes into one or two.

The DOM stays small: only the visible page of results is rendered (24 per
"Load more"), so the document holds **~1,400 elements**, not 102,424.

Initial payload is ~7.6 MB of JSON; serve it gzipped (it compresses to roughly a
quarter) and the versioned URLs let the browser cache it indefinitely.

---

## 19. Integration into the main site

1. Copy this folder into the host project (e.g. `/directory`).
2. Serve it statically. It does not care about its mount path — all references
   are relative.
3. To reuse the host's header/footer, delete the `<header class="site-header">`
   and `<footer class="site-footer">` blocks from `index.html` and drop the
   corresponding sections from `styles.css`. Nothing in `js/` depends on them
   except `#menuToggle`, `#siteNav`, `#savedBtn`, `#savedCount` and
   `#siteHeader` — remove those handlers from `wireChrome()` in `js/main.js`.
4. All CSS is scoped by class, prefixed only by generic names inside this page.
   If the host has conflicting global styles, wrap the markup in a container and
   prefix the selectors.

---

## 20. Limitations (read before integrating)

* **Data is a static snapshot** taken at `meta.generatedAt`. It does not update
  itself. Re-run the exporter or move to an API.
* **Only current facility links are present** (70,554). Historical employment,
  past licences and employment dates exist in the source but are not in this
  package.
* **~30% of professionals have no facility.** These are `Registered Only` (REG)
  licences, which the source does not attach to a facility. Their cards simply
  omit the field.
* **Language coverage is ~37%** and **contact details ~34%** — both are optional
  self-published fields. Cards hide what is missing rather than showing blanks.
* **`facility.type` is inferred from the name**, not published by DHA. Treat it
  as a hint.
* **Doctor and facility detail pages do not exist yet.** Routes and identifiers
  are prepared (§11); clicking a doctor currently opens the DHA source page.
* **Saved list** persists to `localStorage` but has no dedicated page.
* **No server-side pagination.** The whole dataset loads once. This is fine at
  100k rows; beyond ~250k, move filtering server-side (§14).
* Requires a **static http server** — `file://` is blocked by browser security.
