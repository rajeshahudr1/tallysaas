# Tally Cloud Sync SaaS — Phase 1 UI Build Spec

> This spec drives the **UI-only** build of the `web/` tier. No backend, no DB.
> A minimal **Express + EJS (Bootstrap 5)** server renders screens from **mock data**.
> Mock data will later be swapped for an `apiClient` that calls the REST API
> (the same API a future mobile app will reuse — that is why web goes through an
> API layer, not the DB directly).

---

## 0. Tech & conventions

- **Runtime:** Node.js (>=20), Express 4.
- **Views:** EJS via **express-ejs-layouts** (single `_layout.ejs`, pages set `layout` + content).
- **CSS:** **Bootstrap 5** (CDN) + **Font Awesome 6** (CDN) + **Inter** font (Google Fonts) + our own `public/css/theme.css` that defines the palette and all custom component styling. Bootstrap is the grid/utility base; theme.css makes it look like the screenshots (NOT default-Bootstrap look).
- **Charts:** Chart.js (CDN) for dashboard charts.
- **No build step** — CDN links keep it zero-install beyond `npm i`.
- **Code style:** `'use strict';`, 4-space indent, top-of-file block comment describing the file's purpose (match the IOT project style at `D:/ProjecNew/IOT/Project/IOT/web`). Reference that project's `index.js`, `views/_layout.ejs`, and `public/css` for house style — but adapt: that app uses ejs-locals + session auth; OURS is UI-only with mock data and no auth yet.

### Palette (define as CSS variables in `theme.css`)
```
--primary:      #2563EB;   /* blue   */
--primary-700:  #1D4ED8;
--secondary:    #6D28D9;   /* purple */
--sidebar-bg:   #111827;   /* dark navy */
--sidebar-muted:#9CA3AF;   /* sidebar section labels / inactive icons */
--bg:           #F8FAFC;   /* app background */
--card:         #FFFFFF;
--border:       #E5E7EB;
--text:         #111827;
--text-muted:   #6B7280;
--success:      #16A34A;   /* Active badge */
--success-bg:   #DCFCE7;
--danger:       #DC2626;   /* Inactive badge */
--danger-bg:    #FEE2E2;
--warning:      #D97706;   /* Blocked badge */
--warning-bg:   #FEF3C7;
--radius:       12px;      /* card radius */
--shadow:       0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04);
```
- Font family: `Inter, "Segoe UI", Roboto, system-ui, sans-serif`.
- Layout metrics: **sidebar width 260px**, **header height 70px**.
- Cards: white, `--radius`, `--shadow`, 1px `--border`.

---

## 1. File tree to create (under `tallysaas/web/`)

```
web/
├── index.js                      # Express server: view engine, static, routes that render pages w/ mock data
├── package.json                  # deps: express, ejs, express-ejs-layouts, morgan, compression, helmet
├── .gitignore
├── .env.example                  # PORT, API_URL (for later)
├── README.md                     # how to run, what's mock, how to swap to API later
├── data/
│   └── mock.js                   # ALL mock data (companies, user, customers[10], dashboard stats, dropdowns)
├── routes/
│   └── web.js                    # express.Router(): GET / , /customers , /customers/add
├── views/
│   ├── _layout.ejs               # HTML shell: head(CDN+theme) + sidebar + header + <%- body %> + bottom-nav + scripts
│   ├── partials/
│   │   ├── sidebar.ejs           # COMPONENT: Sidebar
│   │   ├── header.ejs            # COMPONENT: Header
│   │   ├── table.ejs             # COMPONENT: Table (data-driven)
│   │   ├── filter-card.ejs       # COMPONENT: FilterCard (data-driven)
│   │   ├── form-card.ejs         # COMPONENT: FormCard (tab navigation shell)
│   │   ├── pagination.ejs        # COMPONENT: Pagination
│   │   ├── bottom-nav.ejs        # mobile bottom navigation
│   │   └── page-head.ejs         # title + breadcrumb + right-side action buttons (small helper)
│   ├── dashboard/
│   │   └── index.ejs             # PAGE 3: Dashboard
│   └── customers/
│       ├── list.ejs              # PAGE 1: Customers listing
│       └── form.ejs              # PAGE 2: Add Customer
└── public/
    ├── css/
    │   └── theme.css             # palette vars + all custom component styling + responsive + PWA
    ├── js/
    │   ├── app.js                # sidebar drawer toggle, filter collapse, PWA install, table select-all, "same as shipping"
    │   └── dashboard.js          # Chart.js init for the dashboard charts
    ├── img/
    │   └── logo.svg              # cloud icon logo (inline/standalone SVG)
    ├── icons/
    │   ├── icon-192.png  (or .svg)   # PWA icons (SVG placeholders OK)
    │   └── icon-512.png  (or .svg)
    ├── manifest.webmanifest      # PWA manifest (name, theme_color #2563EB, icons, display standalone)
    └── service-worker.js         # PWA: cache-first for static assets; offline indicator support
```

---

## 2. Component contracts (the 6 reusable partials)

All partials are included with `<%- include('partials/<name>', { ...locals }) %>`.
Document each partial's expected locals in its top comment.

### 2.1 `sidebar.ejs` — **Sidebar**
- Locals: `activeMenu` (string key, e.g. `'customers'`, `'dashboard'`).
- Dark navy (`--sidebar-bg`), fixed left, 260px, full height, scrollable.
- Top: logo = cloud icon (Font Awesome `fa-cloud` in a blue rounded square) + text **“Tally Cloud Sync”** in white.
- Menu groups with muted uppercase section labels:
  - (no label) → **Dashboard** (`fa-gauge-high`)
  - **MASTERS** → Companies (`fa-building`), Locations (`fa-location-dot`), Sales Persons (`fa-user-tie`), Customers (`fa-user-group`), Suppliers (`fa-truck-field`), Products (`fa-box`), Categories (`fa-tags`)
  - **TRANSACTIONS** → Sales Invoices (`fa-file-invoice`), Purchase Invoices (`fa-file-import`), Payments (`fa-money-bill-wave`), Receipts (`fa-receipt`), Inventory (`fa-warehouse`)
  - **TALLY SYNC** → Sync Dashboard (`fa-rotate`), Sync Logs (`fa-list-check`)
  - **REPORTS** → Reports (`fa-chart-column`)
  - **SETTINGS** → Users (`fa-users`), Roles & Permissions (`fa-user-shield`), Settings (`fa-gear`)
- Active item: blue (`--primary`) left-accent bar + tinted background + white text. Inactive: muted grey text, hover → lighter bg.
- Build the menu from a JS array in the partial so it's DRY; mark active when `item.key === activeMenu`.
- On mobile this same markup is rendered inside a Bootstrap **offcanvas** drawer (see layout).

### 2.2 `header.ejs` — **Header**
- Locals: `user` `{name, role, avatar}`, `company` `{name}`, `companies` `[{id,name}]`, `notificationCount` (number).
- Sticky top bar, height 70px, white, bottom border, sits to the right of the sidebar (left-margin 260px on desktop).
- Left: **hamburger** button (toggles sidebar drawer on mobile / collapse on desktop).
- Center: **global search** input, full-ish width, rounded, placeholder “Search customers, invoices, products...”, with a `Ctrl + K` chip on the right inside the field.
- Right cluster: **company selector** dropdown (shows `company.name`, e.g. “ABC Pvt. Ltd.”), **notification bell** with red count badge, **settings gear**, **user profile** (avatar + name + role stacked, e.g. “Rajesh Admin / Super Admin”) with a caret dropdown.
- Include an **“Install App”** button (hidden by default; shown by `app.js` when `beforeinstallprompt` fires) and a small **offline indicator** dot.

### 2.3 `table.ejs` — **Table** (data-driven, reusable)
- Locals:
  - `tableId` (string)
  - `columns`: array of `{ key, label, sortable?:bool, align?:'start'|'end'|'center', type?:'text'|'badge'|'status'|'currency'|'date'|'location' }`
  - `rows`: array of plain objects keyed by the column `key`s
  - `selectable?` (bool) → leading checkbox column with a select-all in the header
  - `showIndex?` (bool) → leading `#` column
  - `actions?`: array subset of `['view','edit','delete']` → trailing **Actions** column with icon buttons (view = blue eye, edit = blue pencil, delete = red trash)
- Rendering rules by `type`:
  - `text` (default): raw value
  - `currency`: format as `₹` + Indian grouping (e.g. `₹1,00,000.00`); right-aligned
  - `date`: as-is string (mock already formatted `dd/mm/yyyy`)
  - `status`: pill — `Active`→green, `Inactive`→red, `Blocked`→amber (use `--success/-bg`, etc.)
  - `location`: soft colored pill (Ahmedabad=blue tint, Surat=green tint, Mumbai=purple tint; fallback grey)
  - `badge`: neutral soft pill
- Sortable columns show up/down chevrons (`fa-sort`) in the header (visual only for now).
- Wrap in `.table-responsive`; modern look: subtle row hover, generous row height, `--border` row dividers, sticky-ish header row with light grey bg.

### 2.4 `filter-card.ejs` — **FilterCard** (data-driven, collapsible)
- Locals:
  - `filterId` (string)
  - `title` (default “Advanced Filters”)
  - `fields`: array of `{ type:'text'|'select'|'date', name, label, placeholder?, options?:[{value,label}], colClass?:'col-md-3'... }`
  - `collapsed?` (bool, default false)
- Card with header showing a **filter icon + title** and a collapse chevron on the right. Body is a responsive grid (default `col-md-3` per field, wraps to new rows). Footer right-aligned: **Reset** (light) + **Apply Filters** (primary). Collapse toggled by `app.js` (Bootstrap collapse).

### 2.5 `form-card.ejs` — **FormCard** (tabbed-form shell)
- Locals: `tabs`: array of `{ id, label, icon, active?:bool }`.
- Renders the white card header containing the **tab navigation** (`<ul class="nav form-tabs">`) with an icon + label per tab; active tab has a blue underline + blue text, others muted. Bootstrap `data-bs-toggle="tab"` targets `#<tab.id>`.
- The **including page owns the `.tab-content` panes** (it writes `<div class="tab-content">…</div>` after the include, inside the same card). Document this contract in the partial's comment. This keeps FormCard reusable across any tabbed form while pages keep their bespoke fields.

### 2.6 `pagination.ejs` — **Pagination**
- Locals: `{ page, perPage, total }` and optional `perPageOptions` (default `[10,25,50,100]`).
- Left: “Show [select] entries”. Center/Left text: **“Showing X to Y of Z entries”** (computed). Right: **First · Previous · 1 2 3 4 5 … last · Next · Last** with the current page highlighted blue. Visual only (no real routing yet).

### Helper partial `page-head.ejs`
- Locals: `title`, `breadcrumb` (array of `{label, href?}`), `actions` (HTML string or array of `{label, icon, variant, id}`).
- Renders the page title (left) + breadcrumb under it, and right-aligned action buttons. Used by all 3 pages.

---

## 3. Layout (`_layout.ejs`)
- `<!doctype html>` with `lang="en"`, responsive viewport, `theme-color #2563EB`.
- `<head>`: Inter font, Bootstrap 5 CSS (CDN), Font Awesome 6 (CDN), `link rel="manifest"`, `link` to `/css/theme.css`. Title = `<%= title %> · Tally Cloud Sync`.
- `<body class="app">`:
  - `<%- include('partials/sidebar', { activeMenu }) %>` (desktop fixed) — AND an offcanvas version for mobile (can reuse the same partial inside `.offcanvas`).
  - A main wrapper (`margin-left:260px` on desktop) containing:
    - `<%- include('partials/header', {...}) %>`
    - `<main class="page"><%- body %></main>`
  - `<%- include('partials/bottom-nav', { activeMenu }) %>` (mobile only).
  - Scripts at end: Bootstrap bundle JS (CDN), Chart.js (CDN), `/js/app.js`, and a per-page script slot (`<%- typeof pageScript !== 'undefined' ? pageScript : '' %>`), plus inline PWA SW registration.
- Define sensible `locals` defaults in `index.js` (res.locals) so every render has `user`, `company`, `companies`, `notificationCount`, `activeMenu`, `breadcrumb`.

`bottom-nav.ejs`: fixed bottom bar, **mobile only** (`d-lg-none`), 5 items: Dashboard (`fa-gauge-high`), Customers (`fa-user-group`), Invoice (`fa-file-invoice`), Stock (`fa-warehouse`), Profile (`fa-user`). Active item blue.

---

## 4. PAGE 1 — Customers listing (`customers/list.ejs`, route `GET /customers`, activeMenu `customers`)
Match the provided screenshot exactly:
- **page-head**: title **“Customers”**, breadcrumb **Dashboard › Customers**, right buttons: **Export** (light, `fa-upload`) + **+ Add Customer** (gradient blue→purple primary, links to `/customers/add`).
- **FilterCard** (expanded) with fields, laid out 5 per row then wrapping:
  - Search (text, “Search by name, mobile, email...”), Location (select: All Locations / Ahmedabad / Surat / Mumbai), Sales Person (select: All Sales Persons / Rajesh Kumar / Amit Shah / Neha Patel), Customer Group (select: All Groups / Retail / Wholesale / Distributor), Status (select: All Status / Active / Inactive / Blocked),
  - GST No. (text), Opening Balance (select: All), Credit Limit (select: All), Created From (date, value 01/01/2024), Created To (date, value 31/12/2024).
  - Footer: Reset + Apply Filters.
- A toolbar row above the table: left “Show [10] entries”, right “Sort By [Created At]” select + a sort-direction icon button.
- **Table** (component) with `selectable:true, showIndex:true, actions:['view','edit','delete']` and columns:
  `Customer Name` (text), `Location` (location), `Mobile` (text), `GST No.` (text), `Opening Balance` (currency), `Credit Limit` (currency), `Sales Person` (text), `Status` (status), `Created At` (date).
  Rows = `mock.customers` (the 10 rows in §6).
- **Pagination**: page 1, perPage 10, total 156 → “Showing 1 to 10 of 156 entries”, pages `1 2 3 4 5 … 16`.

## 5. PAGE 2 — Add Customer (`customers/form.ejs`, route `GET /customers/add`, activeMenu `customers`)
Match the provided screenshot:
- **page-head**: title **“Add Customer”**, breadcrumb **Dashboard › Customers › Add Customer**, right buttons: **← Back to Customers** (light, links `/customers`) + **Save Customer** (primary, with a split caret).
- **FormCard** tabs: Basic Information (`fa-id-card`, active), Address (`fa-map-location-dot`), GST & Tax Details (`fa-percent`), Other Details (`fa-circle-info`), Bank Details (`fa-building-columns`), Custom Fields (`fa-table-cells`).
- **Basic Information** pane (3-column responsive grid; required fields marked with red `*`):
  - Row: Customer Name*, Mobile Number* (with +91 country-flag prefix select), Alternate Mobile (+91 prefix).
  - Row: Customer Group (select), Email, Location* (select).
  - Row: Sales Person (select), Credit Limit (₹ suffix), Opening Balance (₹ suffix).
  - Divider, then a row: **Status*** radio group (Active=green selected / Inactive=red / Blocked=amber) · an **“Is Tally Ledger”** toggle (on) · a **Tally Sync Status** mini-card on the right: label “Tally Sync Status”, value “**Not Synced**” (amber) + a **Sync Now** button (`fa-rotate`).
  - Divider, **Address section**: two columns — **Shipping Address** textarea (0/300 counter) and **Billing Address** textarea (0/300) with a **“Same as Shipping Address”** checkbox beside the Billing label.
  - Bottom: two columns — **Notes** textarea (0/300) and **Internal Remarks** textarea (0/300, helper “visible to your team only”).
  - Footer right: **Cancel** (light, → `/customers`) + **Save Customer** (primary).
- Other tab panes (Address / GST & Tax / Other / Bank / Custom Fields): render a clean **placeholder** pane each (a centered muted icon + “Coming in next phase” style note) so the tabs switch without errors. Keep markup minimal but styled.
- `app.js` wires the char counters and the “Same as Shipping” checkbox (copy shipping → billing, disable billing when checked).

## 6. PAGE 3 — Dashboard (`dashboard/index.ejs`, route `GET /`, activeMenu `dashboard`)
- **page-head**: title **“Dashboard”**, breadcrumb **Dashboard**, right: a date-range pill (visual).
- **Stat cards** (responsive grid, 4 per row on desktop), each a white rounded card with an icon chip (colored soft bg), a label, a big number, and a small trend line:
  1. Total Companies — 8 (`fa-building`, blue)
  2. Total Customers — 156 (`fa-user-group`, purple)
  3. Total Products — 542 (`fa-box`, teal)
  4. Today’s Sales — ₹1,24,500 (`fa-indian-rupee-sign`, green)
  5. Pending Tally Sync — 12 (`fa-rotate`, amber)
  6. Stock Value — ₹48,20,000 (`fa-warehouse`, indigo)
  7. Invoice Amount — ₹9,75,000 (`fa-file-invoice`, blue)
  8. Payment Received — ₹7,60,000 (`fa-money-bill-wave`, green)
- **Charts row**: two cards side by side — **Sales Overview** (Chart.js line, monthly) and **Tally Sync Status** (Chart.js doughnut: Synced / Pending / Failed). Init in `dashboard.js`.
- **Recent Invoices** card: uses the **Table** component (columns: Invoice #, Customer, Amount(currency), Status(status mapped: Created=green, Pending Tally=amber, Failed=red), Date(date)) with ~6 mock rows.
- **Recent Sync Activity** card: a compact list/table (Module, Record, Status, Time) with ~6 mock rows.

---

## 7. Mock data (`data/mock.js`) — exact values

```
company  = { id:1, name:'ABC Pvt. Ltd.' }
companies = [ {id:1,name:'ABC Pvt. Ltd.'}, {id:2,name:'XYZ Industries'}, {id:3,name:'Global Traders'} ]
user     = { name:'Rajesh Admin', role:'Super Admin', avatar:'/img/avatar.png' (fallback initials) }
notificationCount = 5
locations = ['Ahmedabad','Surat','Mumbai']
salesPersons = ['Rajesh Kumar','Amit Shah','Neha Patel']
customerGroups = ['Retail','Wholesale','Distributor']
```

`customers` (10 rows; fields: name, location, mobile, gst, opening_balance, credit_limit, sales_person, status, created_at):
```
1  Amit Enterprises      Ahmedabad 9876543210 24ABCDE1234F1Z5 25000   100000 Rajesh Kumar Active   20/05/2024
2  Shreeji Traders       Surat     9823456789 24FGHJK5678L2Z3 15500   75000  Amit Shah    Active   18/05/2024
3  Patel & Co.           Mumbai    9922334455 27ABCDE9876M1Z2 0       50000  Neha Patel   Active   17/05/2024
4  Jai Mata Di Stores    Ahmedabad 9712345678 24QWERT1234R1Z5 5000    25000  Rajesh Kumar Active   15/05/2024
5  Shiv Shakti Traders   Surat     9898765432 24TYUIO4567P1Z4 12750   60000  Amit Shah    Inactive 14/05/2024
6  Bansal Sales          Mumbai    9933221100 27ASDFG6789H1Z2 32000   150000 Neha Patel   Active   12/05/2024
7  National Enterprises  Ahmedabad 9879879876 24ZXCVB1234N1Z5 0       40000  Rajesh Kumar Active   11/05/2024
8  Krishna Traders       Surat     9911112222 24PLMNB5678Q1Z3 8900    35000  Amit Shah    Inactive 10/05/2024
9  Maa Durga Stores      Mumbai    9867876543 27ZXCVB9876K1Z9 3200    20000  Neha Patel   Active   09/05/2024
10 Balaji Enterprises    Ahmedabad 9800001111 24POIUY4567T1Z6 45000   200000 Rajesh Kumar Active   08/05/2024
```
`customersTotal = 156`, `page=1`, `perPage=10`.

Dashboard stats + recent invoices + recent sync rows: invent sensible values per §6.

---

## 8. `index.js` (server) requirements
- `require('dotenv').config()` optional; `PORT = process.env.PORT || 4600`.
- `app.set('view engine','ejs')`, `app.set('views', .../views)`, `app.use(expressLayouts)`, `app.set('layout','_layout')`.
- `app.use(express.static(.../public))`, `morgan('dev')` in dev, `compression()`, `helmet()` with CSP relaxed enough for the CDNs + inline scripts used (or use nonce-free `contentSecurityPolicy:false` for this UI demo to avoid blocking CDN — acceptable since no backend; note it in a comment).
- `res.locals` defaults middleware sets `user/company/companies/notificationCount` from mock for every request; pages pass `activeMenu`, `title`, `breadcrumb`.
- Mount `routes/web.js`. Routes render: `/`→`dashboard/index`, `/customers`→`customers/list`, `/customers/add`→`customers/form`. Add a `404` handler rendering a simple page (optional).
- Console-log a clean startup banner with the URL.

## 9. PWA
- `manifest.webmanifest`: name “Tally Cloud Sync”, short_name “TallySync”, `start_url:'/'`, `display:'standalone'`, `theme_color:'#2563EB'`, `background_color:'#F8FAFC'`, icons 192/512.
- `service-worker.js`: precache `/`, `/css/theme.css`, `/js/app.js`, CDN-independent assets; cache-first for same-origin static, network-first for navigations; expose offline fallback. Keep it simple but correct.
- `_layout.ejs` registers the SW; `app.js` handles `beforeinstallprompt` → show the header “Install App” button; show an **offline indicator** when `navigator.onLine === false`.

## 10. Quality bar
- Pixel-faithful to the 3 screenshots (navy sidebar, gradient Add button, soft cards, exact columns/fields/values, status & location pills).
- Fully responsive: at <992px the sidebar collapses to an offcanvas drawer (hamburger opens it) and the bottom-nav appears; tables stay horizontally scrollable; the Add-Customer grid collapses to single column; buttons go full-width on mobile.
- No EJS render errors; no missing-locals crashes (guard optional locals with `typeof`).
- Clean, commented, production-style code — not throwaway.
```
```
