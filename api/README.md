# TallySaaS API

Backend tier for **TallySaaS** — Node + Express + **PostgreSQL + Knex**, JWT auth,
and **per-license, database-per-tenant** multi-tenancy: one **master** database
(`tallysaas_master`) holds licenses/users/auth, and each license gets its own
tenant database (`tally_lic_<id>`) holding that license's business data.

Login issues a JWT carrying a `db_name` claim (`tally_lic_<id>`). On every
tenant-scoped request, `Middlewares/tenantResolver.js` reads that claim and
binds the matching tenant Knex pool as `req.db` / the active `db(...)` for the
whole request (see `config/tenantDb.js`, `config/db.js`). A Super Admin token
carries no `db_name` — it works against the master db, or an explicit tenant
picked via `?license_id` / `X-License-Id`.

There are two separate migration trees:
- `db/migrations/` — the **master** schema (licenses, master users, RBAC catalogue).
- `db/migrations_tenant/` — the **tenant** schema, applied independently to every
  `tally_lic_<id>` database and tracked in that database's own
  `knex_migrations_tenant` table (deliberately separate from the master's
  `knex_migrations`, so the two histories can never be confused). This tree has
  grown well past the original handful of tables as new voucher types and
  Tally-coverage columns were added.

A fresh tenant database is built from `db/tenant-schema.sql` plus every tenant
migration (each migration is idempotent — guarded with `IF NOT EXISTS` /
`hasTable` — so re-stating something the SQL already created is a no-op). See
`db/provision.js` and `db/migrate-tenants.js` for the full mechanics.

This tier delivers the infrastructure, the master + tenant schemas, a working
auth flow (login → JWT → `/me`), and CRUD controllers built on a reusable
`crudController` factory, plus the growing set of voucher modules (see
"Voucher modules & Tally push" below).

---

## Requirements

- **Node.js >= 20**
- **PostgreSQL** running locally (or reachable via the `.env` connection settings)

---

## Setup

```bash
# 1. Copy the env template and set DB credentials / JWT secret / MASTER_DB_DATABASE
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Create + migrate the MASTER database, seed the permission catalogue and the
#    platform super-admin user (idempotent)
node db/provision.js setup-master

# 4. Provision a license — creates the license row in master AND its own tenant
#    database (tally_lic_<id>), applies tenant-schema.sql, seeds RBAC + a default
#    company + the license-admin user
node db/provision.js license --holder "Acme" --email admin@acme.com [--password X] [--name "Acme Admin"]

# 5. Start the server
npm start          # or: npm run dev   (nodemon, auto-reload)
```

Provisioning is what creates and migrates databases in this project — there is
no single `createdb` + `npm run migrate` step that produces a working system.
`npm run migrate` / `npm run migrate:rollback` still exist and operate on the
**master** database only (Knex's own `knexfile.js` config). To evolve the
schema of tenant databases that already exist (i.e. NOT at first provision
time), use:

```bash
npm run migrate:tenants          # walks master.licenses, migrates every tally_lic_<id>
npm run migrate:tenants:status
npm run migrate:tenants:rollback
```

The API boots on **`http://localhost:4500`** and is mounted at the base URL
**`http://localhost:4500/api/v1`**.

---

## Seeded super-admin

After `node db/provision.js setup-master` you can log in with:

| Field    | Value                     |
| -------- | ------------------------- |
| Email    | `admin@tallysaas.test`    |
| Password | `Admin@123`               |

---

## Smoke test

```bash
# Liveness (no DB)
curl http://localhost:4500/api/v1/ping

# Health (DB ping → 200 / 503)
curl http://localhost:4500/api/v1/health

# Login → returns a JWT
curl -X POST http://localhost:4500/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@tallysaas.test","password":"Admin@123"}'

# Authenticated list (replace <TOKEN> with the token from login)
curl http://localhost:4500/api/v1/customers \
  -H 'Authorization: Bearer <TOKEN>'
```

---

## Response envelope

All endpoints return HTTP 200 for logical results (the body carries the logical
status); real HTTP status codes are used only for `/health` (503 when the DB is
down), unmatched routes (404), and uncaught failures (500).

```jsonc
// success
{ "status": 200, "show": false, "msg": "success", "data": { /* … */ } }

// error
{ "status": 422, "show": true, "msg": "Email or password is incorrect." }
```

---

## Project layout

```
api/
├── index.js               # express bootstrap (helmet, cors, compression, json, requestId, Routes, 404 + errors)
├── knexfile.js             # pg connection from env; MASTER migrations db/migrations, seeds db/seeds
├── config/db.js            # master knex instance + AsyncLocalStorage-based runWithTenant() + ping()
├── config/tenantDb.js      # per-license tenant Knex pool factory (cached by db_name)
├── Helpers/                # response, jwt, passwords, crudController (factory), syncModules (Tally push/pull toggles)
├── Middlewares/            # auth, tenantResolver, rbac, validate, errorHandler
├── Validators/              # Joi schemas
├── Controllers/            # Auth + Tenant controllers (voucher modules, reports, licensing, etc.)
├── Routes/                 # master router mounted at /api/v1
└── db/
    ├── migrations/          # MASTER schema (licenses, master users, RBAC catalogue)
    ├── migrations_tenant/   # TENANT schema, applied per tally_lic_<id> database
    ├── provision.js         # setup-master / license provisioning (master row + tenant db)
    ├── migrate-tenants.js   # runs migrations_tenant/ against existing tenant databases
    ├── tenant-schema.sql    # base SQL a fresh tenant db is built from
    ├── master-schema.sql    # base SQL the master db is built from
    └── seeds/               # master seeds (permission catalogue, super-admin)
```

---

## Voucher modules & Tally push

Fourteen voucher types can push Cloud → Tally: sales invoice, purchase invoice,
payment, receipt, journal, contra, credit note, debit note, stock journal,
physical stock, quotation, sales order, purchase order, delivery note, and
receipt note. Each has its own on/off switch under Settings (per license), and
`Helpers/syncModules.js` is the single source of truth for the module key list
that drives those switches, the API's push/pull filtering, and the agent logs.

The four original voucher types (sales/purchase invoice, payment, receipt) plus
journal/contra/credit-debit-note have been exercised against real Tally
installs. The other ten (quotation, sales order, purchase order, delivery
note, receipt note, stock journal, physical stock) are new and have **not**
been exercised against a real Tally installation yet. Two of them need extra
setup on the Tally side before they will work at all: **Quotation** needs its
voucher type created in Tally, and **Sales/Purchase Order** and
**Delivery/Receipt Note** need order processing enabled there.
