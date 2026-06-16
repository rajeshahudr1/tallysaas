'use strict';

/**
 * api/Routes/index.js
 *
 * The master router, mounted at `/api/v1` by index.js. It wires the public
 * health probes, the auth endpoints, and the first protected tenant CRUD
 * (customers). Later phases add more resource routers here using the same
 * authenticate → resolveCompany → can(...) guard chain.
 *
 * Route map (all paths relative to /api/v1):
 *
 *   GET    /ping                 — liveness, NO DB touch        (public)
 *   GET    /health               — readiness, DB ping → 200/503 (public)
 *
 *   POST   /auth/login           — validate(loginSchema) → login
 *   POST   /auth/logout          — stateless logout
 *   GET    /me                   — authenticate → current user + perms
 *
 *   GET    /customers            — list   (validate query)   [auth, company, customers.view]
 *   GET    /customers/:id        — get                       [auth, company, customers.view]
 *   POST   /customers            — create (validate body)    [auth, company, customers.create]
 *   PUT    /customers/:id        — update (validate body)    [auth, company, customers.edit]
 *   DELETE /customers/:id        — destroy (soft delete)     [auth, company, customers.delete]
 *
 * Guard chain on every customers route:
 *   authenticate     — Bearer JWT → req.user
 *   resolveCompany   — pins req.companyId (Super Admin may override via header)
 *   can(mod, action) — RBAC; Super Admin bypasses
 *
 * Health/ping diverge from the "HTTP 200 + body.status" envelope convention on
 * purpose: /ping always returns its own tiny object and /health returns a REAL
 * 503 when the DB is unreachable so load balancers and orchestrators see a
 * genuine not-ready signal.
 */

const express = require('express');

// ── Middlewares (export names per the shared house contract) ──────
const { authenticate, requireSuperAdmin, authenticateAgent } = require('../Middlewares/auth');
const { resolveCompany } = require('../Middlewares/companyScope');
const { can }            = require('../Middlewares/rbac');
const { validate }       = require('../Middlewares/validate');

// ── Validators ────────────────────────────────────────────────────
const { loginSchema } = require('../Validators/auth');
const {
    createCustomerSchema,
    updateCustomerSchema,
    listCustomerSchema,
} = require('../Validators/customer');
const {
    createLocationSchema,
    updateLocationSchema,
    listLocationSchema,
} = require('../Validators/location');
const {
    createSalesPersonSchema,
    updateSalesPersonSchema,
    listSalesPersonSchema,
} = require('../Validators/salesPerson');
const {
    createSupplierSchema,
    updateSupplierSchema,
    listSupplierSchema,
} = require('../Validators/supplier');
const {
    createCategorySchema,
    updateCategorySchema,
    listCategorySchema,
} = require('../Validators/category');
const {
    createProductSchema,
    updateProductSchema,
    listProductSchema,
} = require('../Validators/product');
const {
    createCustomerGroupSchema,
    updateCustomerGroupSchema,
    listCustomerGroupSchema,
} = require('../Validators/customerGroup');
const {
    createSalesInvoiceSchema,
    createPurchaseInvoiceSchema,
    listInvoiceSchema,
} = require('../Validators/invoice');
const {
    createPaymentSchema,
    createReceiptSchema,
    listPaymentSchema,
} = require('../Validators/payment');
const { createLicenseSchema, listLicenseSchema } = require('../Validators/license');
const { activateSchema, heartbeatSchema }        = require('../Validators/agent');
const { createUserSchema, listUserSchema }       = require('../Validators/user');
const {
    createRoleSchema,
    updateRoleSchema,
    setRolePermissionsSchema,
} = require('../Validators/role');
const { createCompanySchema, listCompanySchema } = require('../Validators/company');
const { createJournalSchema, listJournalSchema } = require('../Validators/journal');
const { createAdjustmentSchema }                 = require('../Validators/inventory');

// ── Controllers ───────────────────────────────────────────────────
const AuthController          = require('../Controllers/Auth/AuthController');
const CustomerController      = require('../Controllers/Tenant/CustomerController');
const LocationController      = require('../Controllers/Tenant/LocationController');
const SalesPersonController   = require('../Controllers/Tenant/SalesPersonController');
const SupplierController      = require('../Controllers/Tenant/SupplierController');
const CategoryController      = require('../Controllers/Tenant/CategoryController');
const ProductController       = require('../Controllers/Tenant/ProductController');
const CustomerGroupController = require('../Controllers/Tenant/CustomerGroupController');
const InvoiceController       = require('../Controllers/Tenant/InvoiceController');
const PaymentController       = require('../Controllers/Tenant/PaymentController');
const LicenseController       = require('../Controllers/SuperAdmin/LicenseController');
const CompanyController       = require('../Controllers/SuperAdmin/CompanyController');
const AgentController         = require('../Controllers/Agent/AgentController');
const AgentCommandController  = require('../Controllers/Tenant/AgentCommandController');
const DashboardController     = require('../Controllers/Tenant/DashboardController');
const InventoryController     = require('../Controllers/Tenant/InventoryController');
const UserController          = require('../Controllers/Tenant/UserController');
const SettingsController      = require('../Controllers/Tenant/SettingsController');
const SyncController          = require('../Controllers/Tenant/SyncController');
const ReportController        = require('../Controllers/Tenant/ReportController');
const RoleController          = require('../Controllers/Tenant/RoleController');
const MyCompaniesController   = require('../Controllers/Tenant/MyCompaniesController');
const ConfigController        = require('../Controllers/Tenant/ConfigController');
const TenantCompanyController = require('../Controllers/Tenant/CompanyController');
const RbacController          = require('../Controllers/SuperAdmin/RbacController');
const UserApprovalController  = require('../Controllers/SuperAdmin/UserApprovalController');
const JournalController       = require('../Controllers/Tenant/JournalController');

// ── DB (for the /health probe) ────────────────────────────────────
const { ping } = require('../config/db');

const router = express.Router();

// ───────────────────────────────────────────────────────────────────
// Health & liveness (public, no auth)
// ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/ping — pure liveness. Touches NOTHING (no DB), so it answers even
 * while PostgreSQL is down; useful as a process-up probe.
 */
router.get('/ping', (req, res) => {
    res.status(200).json({ status: 200, ok: true, ts: new Date().toISOString() });
});

/**
 * GET /api/v1/health — readiness. Pings the DB; 200 when reachable, REAL 503
 * with details when not (so orchestrators pull the instance out of rotation).
 */
router.get('/health', async (req, res) => {
    try {
        await ping();
        return res.status(200).json({
            status: 200,
            ok:     true,
            db:     'up',
            ts:     new Date().toISOString(),
        });
    } catch (err) {
        return res.status(503).json({
            status: 503,
            ok:     false,
            db:     'down',
            error:  err.code || err.message,
            ts:     new Date().toISOString(),
        });
    }
});

// ───────────────────────────────────────────────────────────────────
// Auth
// ───────────────────────────────────────────────────────────────────

router.post('/auth/login', validate(loginSchema), AuthController.login);
// logout runs behind authenticate so it can clear the user's active session.
router.post('/auth/logout', authenticate, AuthController.logout);

// Current authenticated user (no company scope / RBAC — every logged-in user
// may read their own profile).
router.get('/me', authenticate, AuthController.me);

// Companies the caller may switch between (license-scoped; super-admin = all).
router.get('/my-companies', authenticate, MyCompaniesController.list);

// Config enumeration lists (supplier groups, payment terms, GST rates, units,
// statuses …) — the single source for non-master-table dropdowns shared by the
// web BFF and the mobile app. Global enums → authenticate only.
router.get('/config/options', authenticate, ConfigController.options);

// ───────────────────────────────────────────────────────────────────
// Python sync AGENT (no user auth — license-key / agent-token based)
// ───────────────────────────────────────────────────────────────────

// Public: the agent presents the secret license key + its machine fingerprint.
router.post('/agent/activate', validate(activateSchema), AgentController.activate);
// Agent-token authenticated heartbeat (re-validates the license server-side).
router.post('/agent/heartbeat', authenticateAgent, validate(heartbeatSchema), AgentController.heartbeat);
// Sync queue: pull everything still needing a push to Tally; report results back.
router.get('/agent/pending',  authenticateAgent, AgentController.pending);
router.post('/agent/result',  authenticateAgent, AgentController.result);
// Tally → Cloud: the agent imports masters read from the open Tally company.
router.post('/agent/import',  authenticateAgent, AgentController.importFromTally);
// Command channel: the agent drains queued commands (open_company …) and reports
// each outcome. Pickup is transactional + license-scoped (see getCommands).
router.get('/agent/commands',             authenticateAgent, AgentController.getCommands);
router.post('/agent/commands/:id/result', authenticateAgent, AgentController.commandResult);

// ───────────────────────────────────────────────────────────────────
// Super-Admin · License management
// ───────────────────────────────────────────────────────────────────

router.post('/super-admin/licenses',
    authenticate, requireSuperAdmin, validate(createLicenseSchema), LicenseController.create);
router.get('/super-admin/licenses',
    authenticate, requireSuperAdmin, validate(listLicenseSchema, 'query'), LicenseController.list);
router.post('/super-admin/licenses/:id/reset-machine',
    authenticate, requireSuperAdmin, LicenseController.resetMachine);
router.post('/super-admin/licenses/:id/suspend',
    authenticate, requireSuperAdmin, LicenseController.suspend);
router.post('/super-admin/licenses/:id/activate',
    authenticate, requireSuperAdmin, LicenseController.activate);

// Super-Admin · per-user approval queue (each approved user = a paid seat).
router.get('/super-admin/users/pending',
    authenticate, requireSuperAdmin, UserApprovalController.listPending);
router.post('/super-admin/users/:id/approve',
    authenticate, requireSuperAdmin, UserApprovalController.approve);
router.post('/super-admin/users/:id/reject',
    authenticate, requireSuperAdmin, UserApprovalController.reject);

// Super-Admin · Roles & Permissions matrix (roles are global → platform op).
router.get('/permissions/matrix',
    authenticate, requireSuperAdmin, RbacController.matrix);
router.put('/roles/:id/permissions',
    authenticate, requireSuperAdmin, RbacController.updateRolePermissions);

// Super-Admin · per-license module ENTITLEMENTS (which modules a license's
// roles may use). Phase C — backs the license module-access screen.
router.get('/super-admin/licenses/:id/permissions',
    authenticate, requireSuperAdmin, RbacController.licenseMatrix);
router.put('/super-admin/licenses/:id/permissions',
    authenticate, requireSuperAdmin, RbacController.setLicensePermissions);

// Super-Admin · per-company concurrent web-session cap (max_sessions_per_user).
router.get('/super-admin/companies',
    authenticate, requireSuperAdmin, CompanyController.list);
router.patch('/super-admin/companies/:id/session-limit',
    authenticate, requireSuperAdmin, CompanyController.setSessionLimit);

// ───────────────────────────────────────────────────────────────────
// Customers (protected tenant CRUD — sample of the crudController factory)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/customers',
    authenticate, resolveCompany, can('customers', 'view'),
    validate(listCustomerSchema, 'query'),
    CustomerController.list,
);

router.get(
    '/customers/:id',
    authenticate, resolveCompany, can('customers', 'view'),
    CustomerController.get,
);

router.post(
    '/customers',
    authenticate, resolveCompany, can('customers', 'create'),
    validate(createCustomerSchema),
    CustomerController.create,
);

router.put(
    '/customers/:id',
    authenticate, resolveCompany, can('customers', 'edit'),
    validate(updateCustomerSchema),
    CustomerController.update,
);

router.delete(
    '/customers/:id',
    authenticate, resolveCompany, can('customers', 'delete'),
    CustomerController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Locations (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/locations',
    authenticate, resolveCompany, can('locations', 'view'),
    validate(listLocationSchema, 'query'),
    LocationController.list,
);

router.get(
    '/locations/:id',
    authenticate, resolveCompany, can('locations', 'view'),
    LocationController.get,
);

router.post(
    '/locations',
    authenticate, resolveCompany, can('locations', 'create'),
    validate(createLocationSchema),
    LocationController.create,
);

router.put(
    '/locations/:id',
    authenticate, resolveCompany, can('locations', 'edit'),
    validate(updateLocationSchema),
    LocationController.update,
);

router.delete(
    '/locations/:id',
    authenticate, resolveCompany, can('locations', 'delete'),
    LocationController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Sales Persons (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/sales-persons',
    authenticate, resolveCompany, can('sales-persons', 'view'),
    validate(listSalesPersonSchema, 'query'),
    SalesPersonController.list,
);

router.get(
    '/sales-persons/:id',
    authenticate, resolveCompany, can('sales-persons', 'view'),
    SalesPersonController.get,
);

router.post(
    '/sales-persons',
    authenticate, resolveCompany, can('sales-persons', 'create'),
    validate(createSalesPersonSchema),
    SalesPersonController.create,
);

router.put(
    '/sales-persons/:id',
    authenticate, resolveCompany, can('sales-persons', 'edit'),
    validate(updateSalesPersonSchema),
    SalesPersonController.update,
);

router.delete(
    '/sales-persons/:id',
    authenticate, resolveCompany, can('sales-persons', 'delete'),
    SalesPersonController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Suppliers (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/suppliers',
    authenticate, resolveCompany, can('suppliers', 'view'),
    validate(listSupplierSchema, 'query'),
    SupplierController.list,
);

router.get(
    '/suppliers/:id',
    authenticate, resolveCompany, can('suppliers', 'view'),
    SupplierController.get,
);

router.post(
    '/suppliers',
    authenticate, resolveCompany, can('suppliers', 'create'),
    validate(createSupplierSchema),
    SupplierController.create,
);

router.put(
    '/suppliers/:id',
    authenticate, resolveCompany, can('suppliers', 'edit'),
    validate(updateSupplierSchema),
    SupplierController.update,
);

router.delete(
    '/suppliers/:id',
    authenticate, resolveCompany, can('suppliers', 'delete'),
    SupplierController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Categories (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/categories',
    authenticate, resolveCompany, can('categories', 'view'),
    validate(listCategorySchema, 'query'),
    CategoryController.list,
);

router.get(
    '/categories/:id',
    authenticate, resolveCompany, can('categories', 'view'),
    CategoryController.get,
);

router.post(
    '/categories',
    authenticate, resolveCompany, can('categories', 'create'),
    validate(createCategorySchema),
    CategoryController.create,
);

router.put(
    '/categories/:id',
    authenticate, resolveCompany, can('categories', 'edit'),
    validate(updateCategorySchema),
    CategoryController.update,
);

router.delete(
    '/categories/:id',
    authenticate, resolveCompany, can('categories', 'delete'),
    CategoryController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Products (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/products',
    authenticate, resolveCompany, can('products', 'view'),
    validate(listProductSchema, 'query'),
    ProductController.list,
);

router.get(
    '/products/:id',
    authenticate, resolveCompany, can('products', 'view'),
    ProductController.get,
);

router.post(
    '/products',
    authenticate, resolveCompany, can('products', 'create'),
    validate(createProductSchema),
    ProductController.create,
);

router.put(
    '/products/:id',
    authenticate, resolveCompany, can('products', 'edit'),
    validate(updateProductSchema),
    ProductController.update,
);

router.delete(
    '/products/:id',
    authenticate, resolveCompany, can('products', 'delete'),
    ProductController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Customer Groups (protected tenant CRUD — gated under the 'customers'
// module; the table has no own permission slug)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/customer-groups',
    authenticate, resolveCompany, can('customers', 'view'),
    validate(listCustomerGroupSchema, 'query'),
    CustomerGroupController.list,
);

router.get(
    '/customer-groups/:id',
    authenticate, resolveCompany, can('customers', 'view'),
    CustomerGroupController.get,
);

router.post(
    '/customer-groups',
    authenticate, resolveCompany, can('customers', 'create'),
    validate(createCustomerGroupSchema),
    CustomerGroupController.create,
);

router.put(
    '/customer-groups/:id',
    authenticate, resolveCompany, can('customers', 'edit'),
    validate(updateCustomerGroupSchema),
    CustomerGroupController.update,
);

router.delete(
    '/customer-groups/:id',
    authenticate, resolveCompany, can('customers', 'delete'),
    CustomerGroupController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Sales Invoices (bespoke controller — header + nested items, totals
// computed server-side; no update — invoices are immutable once cut)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/sales-invoices',
    authenticate, resolveCompany, can('sales-invoices', 'view'),
    validate(listInvoiceSchema, 'query'),
    InvoiceController.listSales,
);

router.get(
    '/sales-invoices/:id',
    authenticate, resolveCompany, can('sales-invoices', 'view'),
    InvoiceController.get,
);

router.post(
    '/sales-invoices',
    authenticate, resolveCompany, can('sales-invoices', 'create'),
    validate(createSalesInvoiceSchema),
    InvoiceController.createSales,
);

router.delete(
    '/sales-invoices/:id',
    authenticate, resolveCompany, can('sales-invoices', 'delete'),
    InvoiceController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Purchase Invoices (same bespoke controller, type='purchase')
// ───────────────────────────────────────────────────────────────────

router.get(
    '/purchase-invoices',
    authenticate, resolveCompany, can('purchase-invoices', 'view'),
    validate(listInvoiceSchema, 'query'),
    InvoiceController.listPurchase,
);

router.get(
    '/purchase-invoices/:id',
    authenticate, resolveCompany, can('purchase-invoices', 'view'),
    InvoiceController.get,
);

router.post(
    '/purchase-invoices',
    authenticate, resolveCompany, can('purchase-invoices', 'create'),
    validate(createPurchaseInvoiceSchema),
    InvoiceController.createPurchase,
);

router.delete(
    '/purchase-invoices/:id',
    authenticate, resolveCompany, can('purchase-invoices', 'delete'),
    InvoiceController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Payments (money-out vouchers — bespoke controller, type='payment')
// ───────────────────────────────────────────────────────────────────

router.get(
    '/payments',
    authenticate, resolveCompany, can('payments', 'view'),
    validate(listPaymentSchema, 'query'),
    PaymentController.listPayments,
);

router.get(
    '/payments/:id',
    authenticate, resolveCompany, can('payments', 'view'),
    PaymentController.get,
);

router.post(
    '/payments',
    authenticate, resolveCompany, can('payments', 'create'),
    validate(createPaymentSchema),
    PaymentController.createPayment,
);

router.delete(
    '/payments/:id',
    authenticate, resolveCompany, can('payments', 'delete'),
    PaymentController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Receipts (money-in vouchers — same bespoke controller, type='receipt')
// ───────────────────────────────────────────────────────────────────

router.get(
    '/receipts',
    authenticate, resolveCompany, can('receipts', 'view'),
    validate(listPaymentSchema, 'query'),
    PaymentController.listReceipts,
);

router.get(
    '/receipts/:id',
    authenticate, resolveCompany, can('receipts', 'view'),
    PaymentController.get,
);

router.post(
    '/receipts',
    authenticate, resolveCompany, can('receipts', 'create'),
    validate(createReceiptSchema),
    PaymentController.createReceipt,
);

router.delete(
    '/receipts/:id',
    authenticate, resolveCompany, can('receipts', 'delete'),
    PaymentController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Dashboard · Inventory · Users · Settings · Tally-Sync · Reports
// (read/CRUD endpoints backing the corresponding web pages)
// ───────────────────────────────────────────────────────────────────

// Companies (tenant) — list (license-scoped) + register a new one.
router.get(
    '/companies',
    authenticate, resolveCompany, can('companies', 'view'),
    validate(listCompanySchema, 'query'),
    TenantCompanyController.list,
);
router.post(
    '/companies',
    authenticate, resolveCompany, can('companies', 'create'),
    validate(createCompanySchema),
    TenantCompanyController.create,
);

// Dashboard summary — counts + charts + recent activity.
router.get(
    '/dashboard/summary',
    authenticate, resolveCompany, can('dashboard', 'view'),
    DashboardController.summary,
);

// Inventory — stock view derived from products + manual stock adjustment.
router.get(
    '/inventory',
    authenticate, resolveCompany, can('inventory', 'view'),
    InventoryController.list,
);
router.post(
    '/inventory/adjust',
    authenticate, resolveCompany, can('inventory', 'edit'),
    validate(createAdjustmentSchema),
    InventoryController.adjust,
);

// Roles — assignable-roles list for the Add/Edit User dropdown (license-scoped).
router.get(
    '/roles',
    authenticate, resolveCompany, can('users', 'view'),
    RoleController.list,
);

// Tenant (license-admin) custom-role MANAGEMENT (Phase C). License-scoped; a
// license-admin builds roles only from the modules their license is entitled to.
// NOTE: 'available-permissions' is registered before '/:id' so it isn't captured.
router.get('/account/roles',
    authenticate, can('users', 'view'), RoleController.manageList);
router.get('/account/roles/available-permissions',
    authenticate, can('users', 'view'), RoleController.availablePermissions);
router.get('/account/roles/:id',
    authenticate, can('users', 'view'), RoleController.get);
router.post('/account/roles',
    authenticate, can('users', 'create'), validate(createRoleSchema), RoleController.create);
router.put('/account/roles/:id',
    authenticate, can('users', 'edit'), validate(updateRoleSchema), RoleController.update);
router.put('/account/roles/:id/permissions',
    authenticate, can('users', 'edit'), validate(setRolePermissionsSchema), RoleController.setPermissions);
router.delete('/account/roles/:id',
    authenticate, can('users', 'delete'), RoleController.remove);

// Account · cloud→agent command channel (user-auth, license-scoped). A user
// queues "open this company in Tally"; the local agent drains it via /agent/*.
// `authenticate` only — license scope comes from req.user.license_id (same as
// the /account/roles management routes above).
router.post('/account/agent/open-company',
    authenticate, AgentCommandController.openCompany);
router.get('/account/agent/commands',
    authenticate, AgentCommandController.list);

// Users — company user management.
router.get(
    '/users',
    authenticate, resolveCompany, can('users', 'view'),
    validate(listUserSchema, 'query'),
    UserController.list,
);
router.post(
    '/users',
    authenticate, resolveCompany, can('users', 'create'),
    validate(createUserSchema),
    UserController.create,
);

// Settings — company profile + key/value settings.
router.get(
    '/settings',
    authenticate, resolveCompany, can('settings', 'view'),
    SettingsController.get,
);
router.put(
    '/settings',
    authenticate, resolveCompany, can('settings', 'edit'),
    SettingsController.update,
);

// Tally sync — connection summary + log stream.
router.get(
    '/sync/summary',
    authenticate, resolveCompany, can('tally-sync', 'view'),
    SyncController.summary,
);
router.get(
    '/sync/logs',
    authenticate, resolveCompany, can('tally-sync', 'view'),
    SyncController.logs,
);
// Notification-bell feed (unread failed count + recent rows w/ friendly reasons).
router.get(
    '/sync/notifications',
    authenticate, resolveCompany, can('tally-sync', 'view'),
    SyncController.notifications,
);

// Journal vouchers (Dr/Cr accounting entry — syncs to Tally as a Journal).
router.get(
    '/journals',
    authenticate, resolveCompany, can('payments', 'view'),
    validate(listJournalSchema, 'query'),
    JournalController.list,
);
router.post(
    '/journals',
    authenticate, resolveCompany, can('payments', 'create'),
    validate(createJournalSchema),
    JournalController.create,
);
router.delete(
    '/journals/:id',
    authenticate, resolveCompany, can('payments', 'delete'),
    JournalController.destroy,
);

// Reports — Tally-style registers (GST breakup, day book, outstanding, GST).
router.get(
    '/reports/sales-register',
    authenticate, resolveCompany, can('reports', 'view'),
    ReportController.salesRegister,
);
router.get(
    '/reports/day-book',
    authenticate, resolveCompany, can('reports', 'view'),
    ReportController.dayBook,
);
router.get(
    '/reports/outstanding',
    authenticate, resolveCompany, can('reports', 'view'),
    ReportController.outstanding,
);
router.get(
    '/reports/gst-summary',
    authenticate, resolveCompany, can('reports', 'view'),
    ReportController.gstSummary,
);
router.get(
    '/reports/stock-summary',
    authenticate, resolveCompany, can('reports', 'view'),
    ReportController.stockSummary,
);
router.get(
    '/reports/ledger',
    authenticate, resolveCompany, can('reports', 'view'),
    ReportController.partyLedger,
);
router.get('/reports/trial-balance', authenticate, resolveCompany, can('reports', 'view'), ReportController.trialBalance);
router.get('/reports/profit-loss',   authenticate, resolveCompany, can('reports', 'view'), ReportController.profitLoss);
router.get('/reports/balance-sheet', authenticate, resolveCompany, can('reports', 'view'), ReportController.balanceSheet);

module.exports = router;
