# Tally Cloud Sync — Web (Phase 1, UI-only)

A **UI-only** Express + EJS (Bootstrap 5) front-end for the Tally Cloud Sync SaaS.
Every screen is rendered from **mock data** in [`data/mock.js`](./data/mock.js) — there
is **no backend, no database, and no auth** in this phase. The look is driven by our own
[`public/css/theme.css`](./public/css/theme.css) on top of Bootstrap 5 / Font Awesome 6 / Inter (all via CDN).

## Quick start

```bash
npm i
npm start          # production-style start
# or
npm run dev        # nodemon auto-reload while developing
```

Then open: **http://localhost:4600**

> Override the port via `.env` (copy `.env.example` → `.env`). Default `PORT=4600`.

## Pages

| Route             | View                    | Description            |
| ----------------- | ----------------------- | ---------------------- |
| `/`               | `dashboard/index.ejs`   | Dashboard (stats + charts + recent activity) |
| `/customers`      | `customers/list.ejs`    | Customers listing (filters + data table + pagination) |
| `/customers/add`  | `customers/form.ejs`    | Add Customer (tabbed form) |

## How it is wired

```
index.js              Express bootstrap: ejs + express-ejs-layouts (_layout),
                      static /public, morgan, compression, helmet (CSP off for
                      the CDN demo), res.locals defaults from mock, mounts routes.
routes/web.js         The 3 page routes; each pulls what it needs from data/mock.js.
data/mock.js          ALL mock data (company, user, customers, dashboard stats…).
views/                _layout.ejs shell + partials/ (reusable components) + pages.
public/               theme.css, app.js, dashboard.js, PWA (manifest + SW + icons).
```

## Architecture note — why a mock layer (and not the DB)

The web tier talks to a REST **API**, never the database directly. The same API will
later back a mobile app, so going through the API layer keeps a single source of truth.
For Phase 1 we stub that API with `data/mock.js`.

### Swapping mock → API (later)

`routes/web.js` is the only place that reads `data/mock.js`. When the API is ready:

1. Add an `apiClient` module (e.g. `lib/apiClient.js`) that wraps `fetch(process.env.API_URL + …)`.
2. Make the route handlers `async` and replace `mock.customers` / `mock.dashboard` reads
   with `await api.customers.list(query)` etc. — the **view contracts stay identical**, so
   the EJS templates and partials do not change.
3. Point `API_URL` in `.env` at the running API.

Because the partials are fully data-driven (table columns/rows, filter fields, form tabs),
no template edits are required — only the data source changes.

## PWA

Installable + offline-capable: `public/manifest.webmanifest` + `public/service-worker.js`
(cache-first for static assets, network-first for navigations, offline fallback).
The header shows an **Install App** button when the browser fires `beforeinstallprompt`,
and an **offline indicator** when the connection drops.

---

_Phase 1 deliverable — UI/UX only. No real data is persisted._
