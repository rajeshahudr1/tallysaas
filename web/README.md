# Tally Cloud Sync — Web

An Express + EJS (Bootstrap 5) front-end for the Tally Cloud Sync SaaS. This is a
real, **API-backed** app: session-based login against the API (`Helpers/apiClient.js`
wraps `fetch` calls to the API's `/api/v1/...` routes), a `requireAuth` session guard
(`Middlewares/sessionGuard.js`) protecting every page, and dozens of screens under
`views/` driven by live data from the API — not a mock layer. The look is driven by
our own [`public/css/theme.css`](./public/css/theme.css) on top of Bootstrap 5 /
Font Awesome 6 / Inter (all via CDN).

`data/mock.js` still exists but is now only a source for a handful of small,
mostly-static option lists used as UI fallbacks/labels (e.g. state names, sync
module display names) — not for company, customer, invoice, or any other business
data, which all comes from the API.

## Quick start

```bash
npm i
npm start          # production-style start
# or
npm run dev        # nodemon auto-reload while developing
```

Then open: **http://localhost:4600**

> Override the port via `.env` (copy `.env.example` → `.env`). Default `PORT=4600`.
> Point `API_URL` at the running API (see `../api/README.md`) — the web tier has
> nothing to render without it.

## Pages

`routes/web.js` defines roughly 300 routes across dozens of modules. A sample —
see `views/` for the full list of screen groups:

| Area | Views under `views/` | Notes |
| --- | --- | --- |
| Auth | `auth/` | Login, forgot password |
| Dashboard & analytics | `dashboard/`, `analytics/` | Stats, charts, Need Attention, Top 10, Day Book, MoM comparison |
| Masters | `customers/`, `suppliers/`, `products/`, `categories/`, `locations/`, `sales-persons/` | |
| Core vouchers | `sales-invoices/`, `purchase-invoices/`, `payments/`, `receipts/`, `journals/` | |
| Newer voucher modules | `quotations/`, `sales-orders/`, `purchase-orders/`, `delivery-notes/`, `receipt-notes/`, `contra/`, `stock-journals/`, `physical-stock/`, `return-notes/` | See `web/lib/menuTree.js` for the canonical module → route map |
| Books | `journals/`, `ledgers/` | Cash & Bank books |
| Collections | `collect-payments/`, `pay/` | UPI payment links + the public pay page |
| Reports | `reports/`, `my-entries/`, `history/` | `history/` is Change History |
| Lookups & ops | `gst-search/`, `data-backup/`, `bank-reconciliation/`, `expenses/`, `recurring-invoices/`, `reminders/`, `notifications/` | |
| e-Invoice / GSP | `einvoices/`, `einvoice-gsp/` | |
| Portals & access | `customer-users/`, `website-users/`, `accountant-access/` | |
| Admin | `users/`, `roles/`, `settings/`, `licenses/`, `companies/` | `roles/` is the custom role/permission builder |
| Agent & app | `agent-app/`, `agent-releases/`, `app-releases/`, `tally-sync/` | |
| Field | `field/` | Field-sales / salesman screens |

Which sidebar items a logged-in user sees (and which routes they may hit) is
driven by the menu-and-entitlement system in `web/lib/menuTree.js` — the single
source of truth for the sidebar, consumed by `views/partials/sidebar.ejs` and by
the License Modules screen. Each item's `module` key is a permission slug checked
via `canModule()`/`canDo()`; items flagged `soon: true` show disabled (the
permission catalogue already has the module, but the screen isn't built).

## How it is wired

```
index.js               Express bootstrap: ejs + express-ejs-layouts (_layout),
                        static /public, sessions, morgan, compression, helmet,
                        res.locals defaults, mounts routes.
routes/web.js           ~300 page routes; each fetches what it needs from the API
                        via Helpers/apiClient.js (a handful of static option lists
                        still come from data/mock.js).
Helpers/apiClient.js     Thin fetch wrapper around the API's /api/v1 routes.
Middlewares/sessionGuard.js  requireAuth — redirects unauthenticated HTML
                        navigations to /login; blocks AJAX/JSON with a 401-style body.
lib/menuTree.js         Sidebar + entitlement source of truth (see above).
views/                  _layout.ejs shell + partials/ (reusable components) + pages,
                        one folder per module (see table above).
public/                 theme.css, app.js, dashboard.js, PWA (manifest + SW + icons).
```

## PWA

Installable + offline-capable: `public/manifest.webmanifest` + `public/service-worker.js`
(cache-first for static assets, network-first for navigations, offline fallback).
The header shows an **Install App** button when the browser fires `beforeinstallprompt`,
and an **offline indicator** when the connection drops.
