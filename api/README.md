# TallySaaS API

Phase 2 backend tier for **TallySaaS** — Node + Express + **PostgreSQL + Knex**, JWT
auth, and **row-level multi-tenancy via a `company_id` column** on every tenant table
(single shared database — *not* db-per-tenant).

This phase delivers the infrastructure, the full DB schema (20 tables), a working
auth flow (login → JWT → `/me`), and one sample tenant CRUD (`customers`) built on a
reusable `crudController` factory. Later phases add the remaining CRUD controllers
using the same factory.

---

## Requirements

- **Node.js >= 20**
- **PostgreSQL** running locally (or reachable via the `.env` connection settings)

---

## Setup

```bash
# 1. Create the database (single shared DB for all tenants)
createdb tallysaas
#   …or from psql:   CREATE DATABASE tallysaas;

# 2. Copy the env template and adjust DB credentials / JWT secret
cp .env.example .env

# 3. Install dependencies
npm install

# 4. Run migrations (creates all 20 tables)
npm run migrate

# 5. Seed roles, permissions, and the super-admin user
npm run seed

# 6. Start the server
npm start          # or: npm run dev   (nodemon, auto-reload)
```

The API boots on **`http://localhost:4500`** and is mounted at the base URL
**`http://localhost:4500/api/v1`**.

---

## Seeded super-admin

After `npm run seed` you can log in with:

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
├── index.js          # express bootstrap (helmet, cors, compression, json, requestId, Routes, 404 + errors)
├── knexfile.js       # pg connection from env; migrations db/migrations, seeds db/seeds; pool afterCreate UTC
├── config/db.js      # single shared knex instance + ping() / pingWithRetry()
├── Helpers/          # response, jwt, passwords, crudController (factory)
├── Middlewares/      # auth, companyScope, rbac, validate, errorHandler
├── Validators/       # Joi schemas
├── Controllers/      # Auth + Tenant controllers
├── Routes/           # master router mounted at /api/v1
└── db/
    ├── migrations/   # full schema (20 tables)
    └── seeds/        # roles + permissions, super-admin, demo data
```
