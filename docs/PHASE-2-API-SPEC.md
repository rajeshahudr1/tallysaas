# Tally Cloud Sync — Phase 2 API Spec (Foundation + Schema + Auth)

Build the **`api/`** tier: Node + Express + **PostgreSQL + Knex**, JWT auth, **row-level multi-tenancy via `company_id`** (single shared DB — NOT db-per-tenant). Mirror the house style of the reference project `D:/ProjecNew/IOT/Project/IOT/api` (read its `index.js`, `Helpers/helper.js`, `Helpers/jwt.js`, `Helpers/passwords.js`, `Helpers/crudController.js`, `Middlewares/validate.js`, `Middlewares/auth.js`, `knexfile.js`, `config/master-db.js`) — but ADAPT: ours is a SINGLE database with a `company_id` column on every tenant table (no master/tenant split, no slug resolution, no outbox/metrics/branch-scope).

This phase = **infrastructure + full DB schema + working Auth (login/JWT) + one sample CRUD (customers)**. Later phases add the remaining CRUD controllers using the same `crudController` factory.

---

## 0. Conventions

- `'use strict';`, 4-space indent, top-of-file block comment per file.
- **Response envelope** (Helpers/response.js) — same shape as IOT:
  - success: `{ status: 200, show: false, msg, data }` via `successResponse(res, data, msg='success', extra={})`
  - error: `{ status, show: true, msg }` via `errorResponse(res, msg, status=422, extra={})`
  - HTTP status stays 200 for logical errors (body.status carries the code); use real HTTP codes only for /health 503, 404 routing, 500 uncaught.
- **JWT** (Helpers/jwt.js): HS256, secret from `JWT_SECRET` (min 32 chars). Payload:
  `{ sub: <user_id>, company_id: <id|null>, role_id, role_slug, name }`. `sign(payload, expiresIn?)`, `verify(token)`.
- **Passwords** (Helpers/passwords.js): argon2id for new hashes, bcryptjs fallback verify, `needsRehash`. (Copy IOT's almost verbatim.)
- **Soft delete**: every tenant table has `deleted_at TIMESTAMPTZ NULL`; queries filter `whereNull('deleted_at')`.
- **Timestamps**: `created_at` / `updated_at` `TIMESTAMPTZ` default `now()` (use `table.timestamps(true, true)`).
- **Knex**: `pg` client; pool `afterCreate` sets `SET timezone='UTC'`. INT8 type-parser → Number in index.js (copy IOT).
- API mounted at **`/api/v1`**.

### Env vars (.env.example)
```
APP_ENV=development
PORT=4500
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=tallysaas
DB_USERNAME=postgres
DB_PASSWORD=
JWT_SECRET=change-me-to-a-48-char-random-base64url-string-aaaaaaaa
JWT_EXPIRES_IN=24h
CORS_ORIGIN=*
WEB_ORIGIN=http://localhost:4600
```

---

## 1. File tree (under `tallysaas/api/`)

```
api/
├── index.js                 # express bootstrap: helmet, cors, compression, json, requestId, mount Routes at /api/v1, /ping, /health (DB ping), 404 + error handler, boot banner
├── package.json             # deps below; scripts: start, dev (nodemon), migrate, migrate:rollback, seed
├── knexfile.js              # pg, env connection, migrations dir db/migrations, seeds dir db/seeds, pool afterCreate UTC
├── .gitignore               # node_modules, .env, *.log
├── .env.example             # the vars above
├── README.md                # setup: createdb, npm i, npm run migrate, npm run seed, npm start; default super-admin creds
├── config/
│   └── db.js                # single knex instance + ping() + pingWithRetry() (adapt IOT config/master-db.js, single DB)
├── Helpers/
│   ├── response.js          # successResponse / errorResponse / now() / uuid()
│   ├── jwt.js               # sign / verify (HS256)
│   ├── passwords.js         # hash / verify / needsRehash (argon2id + bcrypt)
│   └── crudController.js    # factory → list/get/create/update/destroy, company_id-scoped, soft-delete (adapt IOT, DROP outbox/metrics/employeeScope/branch)
├── Middlewares/
│   ├── auth.js              # authenticate: Bearer JWT → req.user (generic 401 envelope)
│   ├── companyScope.js      # resolveCompany: sets req.companyId. Super Admin may override via X-Company-Id header; others use req.user.company_id
│   ├── rbac.js              # can(module, action) → checks role_permissions for req.user.role_id; Super Admin bypass
│   ├── validate.js          # validate(schema, source='body') Joi → 422 envelope (copy IOT)
│   └── errorHandler.js      # 404 + central error handler (500 envelope)
├── Validators/
│   ├── auth.js              # loginSchema, forgotPasswordSchema
│   └── customer.js          # createCustomerSchema, updateCustomerSchema, listCustomerSchema
├── Controllers/
│   ├── Auth/
│   │   └── AuthController.js # login, me, logout
│   └── Tenant/
│       └── CustomerController.js  # built from crudController factory (sample)
├── Routes/
│   └── index.js             # master router: /ping /health, /auth/login, /me, /customers (CRUD, protected)
└── db/
    ├── migrations/          # full schema (see §2) — ordered files
    └── seeds/               # 01_roles_permissions.js, 02_super_admin.js, 03_demo_company.js
```

### package.json dependencies
`express ^4.19`, `knex ^3`, `pg ^8.13`, `dotenv ^16`, `helmet ^7`, `cors ^2.8`, `compression ^1.7`, `jsonwebtoken ^9`, `argon2 ^0.41`, `bcryptjs ^2.4`, `joi ^17`. devDeps: `nodemon`.
scripts: `start: node index.js`, `dev: nodemon index.js`, `migrate: knex migrate:latest`, `migrate:rollback: knex migrate:rollback`, `seed: knex seed:run`.

---

## 2. Database schema (Knex migrations, all tenant tables carry `company_id`)

Create as ordered migration files (timestamp-prefixed, e.g. `20260101000001_create_companies.js`). Group sensibly. Use `.references('id').inTable(...)` FKs, indexes on `company_id` + common filter cols. Soft-delete `deleted_at` on tenant tables.

**1. companies** — `id` (BigInt PK), `name`, `slug` (unique), `email`, `mobile`, `gst_number`, `pan_number`, `logo`, `address`, `financial_year`, `status` (enum text: Active/Inactive/Blocked, default Active), `subscription_plan`, `subscription_expires_at`, timestamps, `deleted_at`. (NOT company-scoped — this IS the tenant.)

**2. roles** — `id`, `company_id` (nullable → null = system role shared by all), `name`, `slug` (unique-ish), `is_system` (bool), timestamps. Seed 5 system roles: Super Admin (`super-admin`), Company Admin (`company-admin`), Sales Manager (`sales-manager`), Sales Person (`sales-person`), Accountant (`accountant`).

**3. permissions** — `id`, `module` (e.g. 'customers'), `action` (view/create/edit/delete/export), `slug` (`module.action`, unique). Seed module×action for the 17 modules × 5 actions.

**4. role_permissions** — `id`, `role_id` FK→roles, `permission_id` FK→permissions, unique(role_id, permission_id).

**5. users** — `id`, `company_id` (nullable for Super Admin) FK→companies, `role_id` FK→roles, `location_id` (nullable) FK→locations, `name`, `email` (unique, citext-or-lower), `mobile`, `password_hash`, `status` (Active/Inactive/Blocked), `last_login_at`, timestamps, `deleted_at`. Index(email), index(company_id).

**6. password_resets** — `id`, `email`, `token`, `expires_at`, `created_at`.

**7. locations** — `id`, `company_id` FK, `name`, `code`, `city`, `state`, `pincode`, `mobile`, `manager`, `status`, `is_tally_godown` (bool), `tally_guid`, `tally_synced_at`, timestamps, `deleted_at`.

**8. sales_persons** — `id`, `company_id` FK, `user_id` (nullable) FK→users, `name`, `employee_code`, `mobile`, `email`, `joining_date`, `status`, timestamps, `deleted_at`.

**9. sales_person_locations** — `id`, `company_id` FK, `sales_person_id` FK, `location_id` FK, unique(sales_person_id, location_id).

**10. customer_groups** — `id`, `company_id` FK, `name`, timestamps, `deleted_at`.

**11. customers** — `id`, `company_id` FK, `location_id` FK (nullable), `sales_person_id` FK (nullable), `customer_group_id` FK (nullable), `name`, `mobile`, `alternate_mobile`, `email`, `gst_number`, `pan_number`, `billing_address`, `shipping_address`, `opening_balance` (numeric 14,2 default 0), `credit_limit` (numeric 14,2 default 0), `status`, `is_tally_ledger` (bool default true), `tally_guid`, `tally_synced_at`, `notes`, `internal_remarks`, timestamps, `deleted_at`. Index(company_id, status), index(company_id, location_id).

**12. suppliers** — `id`, `company_id` FK, `location_id` FK (nullable), `supplier_group`, `name`, `mobile`, `alternate_mobile`, `email`, `gst_number`, `pan_number`, `opening_balance` (numeric 14,2), `payment_terms`, `status`, `is_tally_ledger`, `tally_guid`, `tally_synced_at`, timestamps, `deleted_at`.

**13. categories** — `id`, `company_id` FK, `name`, `parent_id` (nullable, self FK→categories), `status`, timestamps, `deleted_at`.

**14. products** — `id`, `company_id` FK, `category_id` FK (nullable), `name`, `sku`, `unit`, `hsn_code`, `gst_rate` (numeric 5,2), `purchase_price` (numeric 14,2), `sales_price` (numeric 14,2), `opening_stock` (numeric 14,2 default 0), `status`, `is_tally_item` (bool default true), `tally_guid`, `tally_synced_at`, `description`, timestamps, `deleted_at`. Index(company_id), index(company_id, sku).

**15. inventory** — `id`, `company_id` FK, `product_id` FK, `location_id` FK (nullable), `opening` (numeric), `purchased` (numeric), `sold` (numeric), `current_stock` (numeric), `value` (numeric 16,2), `reorder_level` (numeric default 0), `status`, `updated_at`, `created_at`. unique(company_id, product_id, location_id).

**16. invoices** — `id`, `company_id` FK, `type` (text: 'sales'|'purchase'), `invoice_no` (per-company unique with type), `location_id` FK (nullable), `customer_id` FK (nullable, for sales), `supplier_id` FK (nullable, for purchase), `sales_person_id` FK (nullable), `supplier_bill_no`, `invoice_date` (date), `due_date` (date), `subtotal` (numeric 16,2), `discount` (numeric 16,2), `taxable` (numeric 16,2), `cgst` (numeric 16,2), `sgst` (numeric 16,2), `igst` (numeric 16,2 default 0), `tax_amount` (numeric 16,2), `round_off` (numeric 8,2 default 0), `total` (numeric 16,2), `status` (text: pending_tally|sent_to_tally|created|failed, default pending_tally), `tally_voucher_no`, `tally_guid`, `pdf_path`, `notes`, `created_by` FK→users (nullable), timestamps, `deleted_at`. Index(company_id, type, status), index(company_id, invoice_date).

**17. invoice_items** — `id`, `company_id` FK, `invoice_id` FK (onDelete cascade), `product_id` FK (nullable), `description`, `hsn`, `quantity` (numeric 14,2), `unit`, `rate` (numeric 14,2), `discount_pct` (numeric 5,2 default 0), `taxable` (numeric 16,2), `gst_rate` (numeric 5,2), `gst_amount` (numeric 16,2), `amount` (numeric 16,2), `created_at`.

**18. payments** — `id`, `company_id` FK, `type` (text: 'payment'|'receipt'), `voucher_no` (per-company unique with type), `party_type` (text: 'customer'|'supplier'), `customer_id` FK (nullable), `supplier_id` FK (nullable), `payment_date` (date), `mode` (text), `reference`, `bank_account`, `amount` (numeric 16,2), `status` (pending_tally|sent_to_tally|created|failed default pending_tally), `tally_voucher_no`, `notes`, `created_by` FK→users (nullable), timestamps, `deleted_at`. Index(company_id, type).

**19. tally_sync_logs** — `id`, `company_id` FK, `module`, `record_type`, `record_id` (BigInt nullable), `direction` (text push|pull), `status` (text pending|synced|failed), `request_xml` (text), `response_xml` (text), `message`, `retry_count` (int default 0), `synced_at`, timestamps. Index(company_id, status), index(company_id, module).

**20. settings** — `id`, `company_id` FK, `key`, `value` (text/jsonb), `updated_at`, `created_at`, unique(company_id, key).

---

## 3. Auth flow (Controllers/Auth/AuthController.js)

**POST /api/v1/auth/login** `{ email, password }` (validate via Validators/auth loginSchema):
1. Lookup `users` by lower(email), `whereNull('deleted_at')`, join role. Generic `BAD_CREDS_MSG = 'Email or password is incorrect.'` on any miss (timing-safe: verify against a dummy hash when user not found).
2. Verify password via `passwords.verify`. If `needsRehash`, re-hash + update row (lazy migrate).
3. Reject if `status !== 'Active'` → `'Your account is disabled.'`.
4. Update `last_login_at`.
5. Issue JWT `{ sub: user.id, company_id: user.company_id, role_id, role_slug, name }`.
6. `successResponse(res, { token, user: { id, name, email, role: role_name, role_slug, company_id }, expires_in })`.

**GET /api/v1/me** (authenticate) → return `req.user`'s fresh row + role + permissions list.
**POST /api/v1/auth/logout** → stateless 200 (client drops token).

## 4. Middlewares
- **auth.authenticate**: extract Bearer, `jwt.verify` → `req.user = payload`; on any failure → `errorResponse(res, 'Authentication failed. Please log in again.', 401)`.
- **companyScope.resolveCompany**: if `req.user.role_slug === 'super-admin'` and header `x-company-id` present → `req.companyId = Number(header)`; else `req.companyId = req.user.company_id`. If no companyId and not super-admin → 403.
- **rbac.can(module, action)**: returns middleware; Super Admin bypass; else check a `role_permissions` join for `permissions.slug = module.action`; deny → `errorResponse(res, 'You do not have permission to perform this action.', 403)`. (May cache role perms in-memory.)

## 5. crudController factory (adapt IOT)
`build({ table, notFound, tenantCol:'company_id', listColumns, listOrder, searchCols, buildInsert, buildUpdate, uniqueCheck?, fkCheck? })` → `{ list, get, create, update, destroy }`. All scope by `req.companyId` + `whereNull('deleted_at')`. `list` supports `?search=&page=&per_page=&status=` → returns `{ data: rows, meta: { total, page, per_page } }`. `destroy` = soft delete (set deleted_at). DROP all IOT extras (outbox, companyMetrics, employeeScope, branchCol, csvBranchCol).

## 6. Sample CRUD — Customers (proves the factory)
`Controllers/Tenant/CustomerController.js` via the factory: table `customers`, search on name/mobile/email/gst_number, list columns + joins for location/sales_person/group names, insert/update maps from the validated body. Routes (all `authenticate` + `resolveCompany` + `rbac.can('customers', <action>)`):
- `GET /api/v1/customers` (list) · `GET /api/v1/customers/:id` · `POST /api/v1/customers` · `PUT /api/v1/customers/:id` · `DELETE /api/v1/customers/:id`.

## 7. Seeds
- `01_roles_permissions.js`: insert 5 system roles (company_id null), insert permissions (17 modules × 5 actions), insert role_permissions matching the matrix in `web/data/mock.js` rbac rules (Super Admin all; Company Admin all; Sales Manager/Person/Accountant per those rules).
- `02_super_admin.js`: a demo company `ABC Pvt. Ltd.` (slug `abc`) + a Super Admin user `admin@tallysaas.test` / password `Admin@123` (argon2 hash) with role super-admin, company_id = that company (or null). Print creds in README.
- `03_demo_company.js` (optional): a few demo customers/products so the API returns data.

## 8. index.js boot
helmet (CSP off for JSON API or default), cors (CORS_ORIGIN allowlist, credentials), compression, express.json 2mb, a `requestId` (uuid) on req, mount `Routes` at `/api/v1`. `/api/v1/ping` (no DB) and `/api/v1/health` (DB ping → 200/503). 404 → `errorResponse(res,'Route not found',404)` with HTTP 404. Central error handler → 500 envelope. Boot banner with URL. Export app; `app.listen(PORT)`.

## 9. Quality bar
- `npm run migrate` creates all 20 tables cleanly; `npm run seed` populates roles/permissions/super-admin.
- Server boots; `GET /api/v1/ping` → `{status:200,...}`; `POST /api/v1/auth/login` with the seeded creds → token; `GET /api/v1/customers` with that token → list envelope.
- Clean, commented, production-style. No TODO stubs in the built files.
```
