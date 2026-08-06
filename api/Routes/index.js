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
const { resolveCompany }  = require('../Middlewares/companyScope');
const { resolveLocation } = require('../Middlewares/locationScope');
const { resolveTenant }   = require('../Middlewares/tenantResolver');
const { superAdminBridge } = require('../Middlewares/superAdminBridge');
const { can, canField, canCustomerRead, canRefRead, canProductRead, canOwnInvoice } = require('../Middlewares/rbac');
const { validate }        = require('../Middlewares/validate');

// ── Validators ────────────────────────────────────────────────────
const { loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../Validators/auth');
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
    loginSchema:           salesPersonLoginSchema,
    assignLocationsSchema: salesPersonLocationsSchema,
    assignCustomersSchema: salesPersonCustomersSchema,
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
    createQuotationSchema,
    listQuotationSchema,
} = require('../Validators/quotation');
const {
    createSalesOrderSchema,
    listSalesOrderSchema,
} = require('../Validators/salesOrder');
const {
    createPurchaseOrderSchema,
    listPurchaseOrderSchema,
} = require('../Validators/purchaseOrder');
const {
    createDeliveryNoteSchema,
    listDeliveryNoteSchema,
} = require('../Validators/deliveryNote');
const {
    createStockJournalSchema,
    listStockJournalSchema,
    createPhysicalStockSchema,
    listPhysicalStockSchema,
} = require('../Validators/stockVoucher');
const {
    createReceiptNoteSchema,
    listReceiptNoteSchema,
} = require('../Validators/receiptNote');
const {
    createReturnNoteSchema,
    listReturnNoteSchema,
} = require('../Validators/returnNote');
const {
    createPaymentSchema,
    createReceiptSchema,
    listPaymentSchema,
} = require('../Validators/payment');
const { createLicenseSchema, updateLicenseSchema, listLicenseSchema } = require('../Validators/license');
const { loginSchema: agentLoginSchema, verifySchema: agentVerifySchema,
        resendSchema: agentResendSchema, heartbeatSchema } = require('../Validators/agent');
const { createUserSchema, listUserSchema }       = require('../Validators/user');
const {
    createRoleSchema,
    updateRoleSchema,
    setRolePermissionsSchema,
} = require('../Validators/role');
const { inviteAccountantSchema } = require('../Validators/accountant');
const { createCompanySchema, listCompanySchema } = require('../Validators/company');
const { createJournalSchema, listJournalSchema } = require('../Validators/journal');
const {
    loginSchema:   customerUserLoginSchema,
    catalogSchema: customerUserCatalogSchema,
} = require('../Validators/customerUser');
const { createWebsiteUserSchema, updateWebsiteUserSchema } = require('../Validators/websiteUser');
const { authenticateApiToken, extFullAccess } = require('../Middlewares/apiToken');
const { createAdjustmentSchema }                 = require('../Validators/inventory');

// ── Controllers ───────────────────────────────────────────────────
const AuthController          = require('../Controllers/Auth/AuthController');
const CustomerController      = require('../Controllers/Tenant/CustomerController');
const CustomerUserController  = require('../Controllers/Tenant/CustomerUserController');
const WebsiteUserController   = require('../Controllers/Tenant/WebsiteUserController');
const LocationController      = require('../Controllers/Tenant/LocationController');
const SalesPersonController   = require('../Controllers/Tenant/SalesPersonController');
const SupplierController      = require('../Controllers/Tenant/SupplierController');
const CategoryController      = require('../Controllers/Tenant/CategoryController');
const ExpenseCategoryController = require('../Controllers/Tenant/ExpenseCategoryController');
const ExpenseController         = require('../Controllers/Tenant/ExpenseController');
const { createExpenseCategorySchema, updateExpenseCategorySchema } = require('../Validators/expenseCategory');
const { createExpenseSchema, updateExpenseSchema } = require('../Validators/expense');
const RecurringInvoiceController = require('../Controllers/Tenant/RecurringInvoiceController');
const { createRecurringSchema, updateRecurringSchema } = require('../Validators/recurringInvoice');
const BankController = require('../Controllers/Tenant/BankController');
const { importBankSchema } = require('../Validators/bank');
const EInvoiceController = require('../Controllers/Tenant/EInvoiceController');
const ProductImageController = require('../Controllers/Tenant/ProductImageController');
const { productImagesMiddleware } = require('../Helpers/uploads');
const ProductController       = require('../Controllers/Tenant/ProductController');
const CustomerGroupController = require('../Controllers/Tenant/CustomerGroupController');
const InvoiceController       = require('../Controllers/Tenant/InvoiceController');
const QuotationController     = require('../Controllers/Tenant/QuotationController');
const SalesOrderController    = require('../Controllers/Tenant/SalesOrderController');
const PurchaseOrderController = require('../Controllers/Tenant/PurchaseOrderController');
const DeliveryNoteController  = require('../Controllers/Tenant/DeliveryNoteController');
const StockJournalController  = require('../Controllers/Tenant/StockJournalController');
const PhysicalStockController = require('../Controllers/Tenant/PhysicalStockController');
const ReceiptNoteController   = require('../Controllers/Tenant/ReceiptNoteController');
const MyEntriesController     = require('../Controllers/Tenant/MyEntriesController');
const ReturnNoteController    = require('../Controllers/Tenant/ReturnNoteController');
const PaymentController       = require('../Controllers/Tenant/PaymentController');
const LicenseController       = require('../Controllers/SuperAdmin/LicenseController');
const CompanyController       = require('../Controllers/SuperAdmin/CompanyController');
const AgentController         = require('../Controllers/Agent/AgentController');
const AgentReleaseController   = require('../Controllers/SuperAdmin/AgentReleaseController');
const AppReleaseController     = require('../Controllers/SuperAdmin/AppReleaseController');
const EInvoiceGspController    = require('../Controllers/SuperAdmin/EInvoiceGspController');
const GpsSettingsController    = require('../Controllers/SuperAdmin/GpsSettingsController');
const AgentCommandController  = require('../Controllers/Tenant/AgentCommandController');
const DashboardController     = require('../Controllers/Tenant/DashboardController');
const TallyLedgerController   = require('../Controllers/Tenant/TallyLedgerController');
const GstSearchController     = require('../Controllers/Tenant/GstSearchController');
const GeoController           = require('../Controllers/Tenant/GeoController');
const FieldController         = require('../Controllers/Tenant/FieldController');
const InventoryController     = require('../Controllers/Tenant/InventoryController');
const UserController          = require('../Controllers/Tenant/UserController');
const SettingsController      = require('../Controllers/Tenant/SettingsController');
const SyncController          = require('../Controllers/Tenant/SyncController');
const DeviceController        = require('../Controllers/Tenant/DeviceController');
const HistoryController       = require('../Controllers/Tenant/HistoryController');
const ReportController        = require('../Controllers/Tenant/ReportController');
const RoleController          = require('../Controllers/Tenant/RoleController');
const AccountantController    = require('../Controllers/Tenant/AccountantController');
const ReminderTenantController = require('../Controllers/Tenant/ReminderController');
const AnalyticsController      = require('../Controllers/Tenant/AnalyticsController');
const MyCompaniesController   = require('../Controllers/Tenant/MyCompaniesController');
const ConfigController        = require('../Controllers/Tenant/ConfigController');
const TenantCompanyController = require('../Controllers/Tenant/CompanyController');
const RbacController          = require('../Controllers/SuperAdmin/RbacController');
const ReminderController      = require('../Controllers/SuperAdmin/ReminderController');
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
// Forgot / reset password (public). forgot-password emails a 6-digit code;
// reset-password verifies it and sets the new password.
router.post('/auth/forgot-password', validate(forgotPasswordSchema), AuthController.forgotPassword);
router.post('/auth/reset-password',  validate(resetPasswordSchema),  AuthController.resetPassword);
// logout runs behind authenticate so it can clear the user's active session.
router.post('/auth/logout', authenticate, AuthController.logout);

// Current authenticated user (no company scope / RBAC — every logged-in user
// may read their own profile).
router.get('/me', authenticate, resolveTenant, AuthController.me);

// Every logged-in user may change THEIR OWN password (all roles). No company
// scope / RBAC — it acts only on req.user.sub.
router.post('/account/change-password', authenticate, AuthController.changePassword);

// Companies the caller may switch between (license-scoped; super-admin = all).
router.get('/my-companies', authenticate, resolveTenant, MyCompaniesController.list);

// Config enumeration lists (supplier groups, payment terms, GST rates, units,
// statuses …) — the single source for non-master-table dropdowns shared by the
// web BFF and the mobile app. Global enums → authenticate only.
router.get('/config/options', authenticate, ConfigController.options);

// ───────────────────────────────────────────────────────────────────
// Python sync AGENT (no user auth — license-key / agent-token based)
// ───────────────────────────────────────────────────────────────────

// Public: the agent presents the secret license key + its machine fingerprint.
// Agent sign-in. Public by necessity — this IS how an agent gets its token.
// Licence-key activation was removed: a key typed into a desktop app is a bearer
// secret anyone can copy, and it bound one licence to one machine with no way to
// revoke a single device. Now: password → emailed code → machine-bound token.
router.post('/agent/login',      validate(agentLoginSchema),  AgentController.login);
router.post('/agent/verify',     validate(agentVerifySchema), AgentController.verify);
router.post('/agent/otp/resend', validate(agentResendSchema), AgentController.resendOtp);
// Agent-token authenticated heartbeat (re-validates the license server-side).
router.post('/agent/heartbeat', authenticateAgent, validate(heartbeatSchema), AgentController.heartbeat);
// Graceful "going offline" signal — a clean agent stop (service stop / GUI Stop /
// Uninstall) clears licenses.last_seen_at so the dashboard shows Disconnected
// immediately instead of waiting out the ~150s connected window. Same agent auth.
router.post('/agent/offline',   authenticateAgent, AgentController.offline);
// Sync queue: pull everything still needing a push to Tally; report results back.
router.get('/agent/pending',  authenticateAgent, AgentController.pending);
router.post('/agent/result',  authenticateAgent, AgentController.result);
// Tally → Cloud: the agent imports masters read from the open Tally company.
router.post('/agent/import',  authenticateAgent, AgentController.importFromTally);
// Tally → Cloud DELETE detection: the agent sends the FULL live master-id list
// for one kind and the cloud soft-deletes whatever Tally no longer lists.
router.post('/agent/reconcile', authenticateAgent, AgentController.reconcile);
// Voucher reconciliation: the agent sends the live GUID+AlterID list for ONE
// voucher type; the cloud replies with what it is missing/stale on and (when the
// sweep is complete) soft-deletes what Tally no longer has.
router.post('/agent/voucher-diff', authenticateAgent, AgentController.voucherDiff);
// Command channel: the agent drains queued commands (open_company …) and reports
// each outcome. Pickup is transactional + license-scoped (see getCommands).
router.get('/agent/commands',             authenticateAgent, AgentController.getCommands);
router.post('/agent/commands/:id/result', authenticateAgent, AgentController.commandResult);
// Auto-update: the agent asks what the published-latest exe is, then (if newer +
// allowed) streams it from /agent/download to self-replace. Both are agent-auth
// (re-validate the license); download serves the single is_current release file.
router.get('/agent/version',  authenticateAgent, AgentController.getVersion);
// The Tally queries the agent should run, SIGNED. Adding a report becomes a
// server-side change instead of a new exe — and the signature is what stops
// that same channel becoming a way to send arbitrary XML into customers' Tally.
router.get('/agent/envelopes', authenticateAgent, AgentController.getEnvelopes);
router.get('/agent/download', authenticateAgent, AgentController.download);

// Mobile-app auto-update: PUBLIC so the app can check (and force-update) even at
// the login screen. /app/version → published-latest apk + the GLOBAL on/off;
// /app/download → streams the single is_current apk.
router.get('/app/version',  AppReleaseController.getVersion);
router.get('/app/download', AppReleaseController.download);

// ───────────────────────────────────────────────────────────────────
// Super-Admin · License management
// ───────────────────────────────────────────────────────────────────

router.post('/super-admin/licenses',
    authenticate, requireSuperAdmin, validate(createLicenseSchema), LicenseController.create);
router.get('/super-admin/licenses',
    authenticate, requireSuperAdmin, validate(listLicenseSchema, 'query'), LicenseController.list);
// View (full detail + derived companies/users/agent), edit (mutable fields only),
// soft-delete (refused while the license still owns companies/users).
router.get('/super-admin/licenses/:id',
    authenticate, requireSuperAdmin, LicenseController.get);
router.put('/super-admin/licenses/:id',
    authenticate, requireSuperAdmin, validate(updateLicenseSchema), LicenseController.update);
router.delete('/super-admin/licenses/:id',
    authenticate, requireSuperAdmin, LicenseController.remove);

// e-Invoice GSP integration (per-license, super-admin). Credentials are AES-GCM
// encrypted before storage; secrets are never returned.
router.get('/super-admin/einvoice-gsp',
    authenticate, requireSuperAdmin, superAdminBridge, EInvoiceGspController.get);
router.post('/super-admin/einvoice-gsp/credential',
    authenticate, requireSuperAdmin, superAdminBridge, EInvoiceGspController.saveCredential);
router.post('/super-admin/einvoice-gsp/settings',
    authenticate, requireSuperAdmin, superAdminBridge, EInvoiceGspController.saveSettings);

// GPS tracking config (per-license, super-admin).
router.get('/super-admin/gps-settings',
    authenticate, requireSuperAdmin, superAdminBridge, GpsSettingsController.get);
router.post('/super-admin/gps-settings',
    authenticate, requireSuperAdmin, superAdminBridge, GpsSettingsController.save);
router.post('/super-admin/licenses/:id/reset-machine',
    authenticate, requireSuperAdmin, LicenseController.resetMachine);
router.post('/super-admin/licenses/:id/suspend',
    authenticate, requireSuperAdmin, LicenseController.suspend);
router.post('/super-admin/licenses/:id/activate',
    authenticate, requireSuperAdmin, LicenseController.activate);
// Mint a fresh key (same format as create) for an existing license — for old
// licenses whose clear key was never stored, or to rotate. Returns the new full
// key ONCE; never touches machine binding / status / companies / users.
router.post('/super-admin/licenses/:id/regenerate',
    authenticate, requireSuperAdmin, LicenseController.regenerate);
// Change the license admin's LOGIN email and/or password (super-admin only).
router.put('/super-admin/licenses/:id/credentials',
    authenticate, requireSuperAdmin, LicenseController.updateCredentials);

// Super-Admin · Roles & Permissions matrix (roles are global → platform op).
router.get('/permissions/matrix',
    authenticate, requireSuperAdmin, superAdminBridge, RbacController.matrix);
router.put('/roles/:id/permissions',
    authenticate, requireSuperAdmin, superAdminBridge, RbacController.updateRolePermissions);

// Super-Admin · per-license module ENTITLEMENTS (which modules a license's
// roles may use). Phase C — backs the license module-access screen.
router.get('/super-admin/licenses/:id/permissions',
    authenticate, requireSuperAdmin, RbacController.licenseMatrix);
router.put('/super-admin/licenses/:id/permissions',
    authenticate, requireSuperAdmin, RbacController.setLicensePermissions);

// Super-Admin · per-license payment-reminder settings (Email/WhatsApp channel
// switches + auto scheduler). A licence gets a channel only when flipped on here.
router.get('/super-admin/licenses/:id/reminders',
    authenticate, requireSuperAdmin, superAdminBridge.fromLicenseParam, ReminderController.get);
router.put('/super-admin/licenses/:id/reminders',
    authenticate, requireSuperAdmin, superAdminBridge.fromLicenseParam, ReminderController.update);

// Super-Admin · publish the agent auto-update RELEASE (drop the exe into
// AGENT_RELEASE_DIR, then POST its version → marks the single is_current row).
router.get('/super-admin/agent-release',
    authenticate, requireSuperAdmin, AgentReleaseController.list);
router.post('/super-admin/agent-release',
    authenticate, requireSuperAdmin, AgentReleaseController.publish);
// Browser UPLOAD: receive the built exe as multipart (field "file") + version,
// save it under a safe name in the release dir, then publish it (same core as
// the filename-based publish above). Distinct exact path → no shadowing.
router.post('/super-admin/agent-release/upload',
    authenticate, requireSuperAdmin, AgentReleaseController.upload);

// Super-Admin · mobile-app auto-update: upload a built .apk (multipart file +
// version + version_code) → marks the single is_current row; list the catalogue;
// flip the GLOBAL app-auto-update master switch the app's /app/version honours.
router.get('/super-admin/app-release',
    authenticate, requireSuperAdmin, AppReleaseController.list);
router.post('/super-admin/app-release/upload',
    authenticate, requireSuperAdmin, AppReleaseController.upload);
router.post('/super-admin/app-release/auto-update',
    authenticate, requireSuperAdmin, AppReleaseController.setAutoUpdate);

// Super-Admin · per-company concurrent web-session cap (max_sessions_per_user).
router.get('/super-admin/companies',
    authenticate, requireSuperAdmin, superAdminBridge, CompanyController.list);
router.patch('/super-admin/companies/:id/session-limit',
    authenticate, requireSuperAdmin, superAdminBridge, CompanyController.setSessionLimit);

// ───────────────────────────────────────────────────────────────────
// Customers (protected tenant CRUD — sample of the crudController factory)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/customers',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canCustomerRead,
    validate(listCustomerSchema, 'query'),
    CustomerController.list,
);

router.get(
    '/customers/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canCustomerRead,
    CustomerController.get,
);

router.post(
    '/customers',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'create'),
    validate(createCustomerSchema),
    CustomerController.create,
);

router.put(
    '/customers/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'edit'),
    validate(updateCustomerSchema),
    CustomerController.update,
);

router.delete(
    '/customers/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'delete'),
    CustomerController.destroy,
);

// Customer-User (customer portal login) — mirrors the sales-person login +
// assignment endpoints. Reads gate on customers.view, writes on customers.edit,
// so a role without edit gets a server-side 403 regardless of the UI state.
router.get(
    '/customers/:id/assignments',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customer-users', 'view'),
    CustomerUserController.getAssignments,
);
router.post(
    '/customers/:id/login',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customer-users', 'edit'),
    validate(customerUserLoginSchema),
    CustomerUserController.setLogin,
);
router.put(
    '/customers/:id/catalog',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customer-users', 'edit'),
    validate(customerUserCatalogSchema),
    CustomerUserController.setCatalog,
);

// ───────────────────────────────────────────────────────────────────
// Website Users (third-party API users). A website user IS a fresh customers
// row (is_website_user) + login + api_token; catalog assignment reuses the
// /customers/:id/catalog endpoints above. Same customers.* permission gates.
// ───────────────────────────────────────────────────────────────────
router.get('/website-users',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('website-users', 'view'),
    WebsiteUserController.list);
router.get('/website-users/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('website-users', 'view'),
    WebsiteUserController.get);
router.post('/website-users',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('website-users', 'create'),
    validate(createWebsiteUserSchema), WebsiteUserController.create);
router.put('/website-users/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('website-users', 'edit'),
    validate(updateWebsiteUserSchema), WebsiteUserController.update);
router.post('/website-users/:id/regenerate-token',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('website-users', 'edit'),
    WebsiteUserController.regenerateToken);

// ───────────────────────────────────────────────────────────────────
// Third-party EXT API (X-Api-Token / Bearer wt_… — no JWT). The token maps to
// a website user; requests behave exactly like that user's portal session:
// catalog-scoped lists at locked adjusted rates, invoices forced to their own
// customer with server-side pricing (+ cash/online surcharge via payment_mode)
// and the approval queue.
// ───────────────────────────────────────────────────────────────────
router.get('/ext/categories',
    authenticateApiToken, validate(listCategorySchema, 'query'), CategoryController.list);
router.get('/ext/products',
    authenticateApiToken, validate(listProductSchema, 'query'), ProductController.list);
router.get('/ext/sales-invoices',
    authenticateApiToken, validate(listInvoiceSchema, 'query'), InvoiceController.listSales);
router.get('/ext/sales-invoices/:id',
    authenticateApiToken, InvoiceController.get);
router.post('/ext/sales-invoices',
    authenticateApiToken, validate(createSalesInvoiceSchema), InvoiceController.createSales);

// EXT integration endpoints (extFullAccess lifts the portal self-scoping so
// the token manages the COMPANY's data — it is the company's own credential):
// Customer master CRUD — the SAME CustomerController the JWT routes use.
router.get('/ext/customers',
    authenticateApiToken, extFullAccess, validate(listCustomerSchema, 'query'), CustomerController.list);
router.get('/ext/customers/:id',
    authenticateApiToken, extFullAccess, CustomerController.get);
router.post('/ext/customers',
    authenticateApiToken, extFullAccess, validate(createCustomerSchema), CustomerController.create);
router.put('/ext/customers/:id',
    authenticateApiToken, extFullAccess, validate(updateCustomerSchema), CustomerController.update);
// Location list — for the customer add/edit form's location_id dropdown.
router.get('/ext/locations',
    authenticateApiToken, extFullAccess, validate(listLocationSchema, 'query'), LocationController.list);
// Company-wide invoice list (filter by ?customer_id + status/approval/dates/
// search) + full invoice details — same InvoiceController as the JWT routes.
router.get('/ext/invoices',
    authenticateApiToken, extFullAccess, validate(listInvoiceSchema, 'query'), InvoiceController.listSales);
router.get('/ext/invoices/:id',
    authenticateApiToken, extFullAccess, InvoiceController.get);

// ───────────────────────────────────────────────────────────────────
// Locations (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/locations',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canRefRead('locations'),
    validate(listLocationSchema, 'query'),
    LocationController.list,
);

router.get(
    '/locations/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canRefRead('locations'),
    LocationController.get,
);

router.post(
    '/locations',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('locations', 'create'),
    validate(createLocationSchema),
    LocationController.create,
);

router.put(
    '/locations/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('locations', 'edit'),
    validate(updateLocationSchema),
    LocationController.update,
);

router.delete(
    '/locations/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('locations', 'delete'),
    LocationController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Sales Persons (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/sales-persons',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'view'),
    validate(listSalesPersonSchema, 'query'),
    SalesPersonController.list,
);

router.get(
    '/sales-persons/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'view'),
    SalesPersonController.get,
);

router.post(
    '/sales-persons',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'create'),
    validate(createSalesPersonSchema),
    SalesPersonController.create,
);

router.put(
    '/sales-persons/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'edit'),
    validate(updateSalesPersonSchema),
    SalesPersonController.update,
);

router.delete(
    '/sales-persons/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'delete'),
    SalesPersonController.destroy,
);

// Sales-person LOGIN + ASSIGNMENTS (the sales person IS a login user; per-location
// customer assignment drives what that user can see). Reads gate on
// sales-persons.view, writes on sales-persons.edit. POST /login is atomic
// (create-or-update the linked user + seat reconcile).
router.get(
    '/sales-persons/:id/assignments',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'view'),
    SalesPersonController.getAssignments,
);
router.post(
    '/sales-persons/:id/login',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'edit'),
    validate(salesPersonLoginSchema),
    SalesPersonController.setLogin,
);
router.put(
    '/sales-persons/:id/locations',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'edit'),
    validate(salesPersonLocationsSchema),
    SalesPersonController.setLocations,
);
router.put(
    '/sales-persons/:id/customers',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-persons', 'edit'),
    validate(salesPersonCustomersSchema),
    SalesPersonController.setCustomers,
);

// ───────────────────────────────────────────────────────────────────
// Suppliers (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/suppliers',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('suppliers', 'view'),
    validate(listSupplierSchema, 'query'),
    SupplierController.list,
);

router.get(
    '/suppliers/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('suppliers', 'view'),
    SupplierController.get,
);

router.post(
    '/suppliers',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('suppliers', 'create'),
    validate(createSupplierSchema),
    SupplierController.create,
);

router.put(
    '/suppliers/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('suppliers', 'edit'),
    validate(updateSupplierSchema),
    SupplierController.update,
);

router.delete(
    '/suppliers/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('suppliers', 'delete'),
    SupplierController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Categories (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/categories',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canRefRead('categories'),
    validate(listCategorySchema, 'query'),
    CategoryController.list,
);

router.get(
    '/categories/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canRefRead('categories'),
    CategoryController.get,
);

router.post(
    '/categories',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('categories', 'create'),
    validate(createCategorySchema),
    CategoryController.create,
);

router.put(
    '/categories/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('categories', 'edit'),
    validate(updateCategorySchema),
    CategoryController.update,
);

router.delete(
    '/categories/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('categories', 'delete'),
    CategoryController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Expense Categories + Expenses (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────
router.get('/expense-categories',        authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'view'),   ExpenseCategoryController.list);
router.get('/expense-categories/:id',     authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'view'),   ExpenseCategoryController.get);
router.post('/expense-categories',        authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'create'), validate(createExpenseCategorySchema), ExpenseCategoryController.create);
router.put('/expense-categories/:id',     authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'edit'),   validate(updateExpenseCategorySchema), ExpenseCategoryController.update);
router.delete('/expense-categories/:id',  authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'delete'), ExpenseCategoryController.destroy);

router.get('/expenses',        authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'view'),   ExpenseController.list);
router.get('/expenses/:id',    authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'view'),   ExpenseController.get);
router.post('/expenses',       authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'create'), validate(createExpenseSchema), ExpenseController.create);
router.put('/expenses/:id',    authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'edit'),   validate(updateExpenseSchema), ExpenseController.update);
router.delete('/expenses/:id', authenticate, resolveTenant, resolveCompany, resolveLocation, can('expenses', 'delete'), ExpenseController.destroy);

// ───────────────────────────────────────────────────────────────────
// Recurring Invoices (protected tenant CRUD + generate-now)
// ───────────────────────────────────────────────────────────────────
router.get('/recurring-invoices',        authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'view'),   RecurringInvoiceController.list);
router.get('/recurring-invoices/:id',     authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'view'),   RecurringInvoiceController.get);
router.post('/recurring-invoices',        authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'create'), validate(createRecurringSchema), RecurringInvoiceController.create);
router.put('/recurring-invoices/:id',     authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'edit'),   validate(updateRecurringSchema), RecurringInvoiceController.update);
router.delete('/recurring-invoices/:id',  authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'delete'), RecurringInvoiceController.destroy);
router.post('/recurring-invoices/:id/generate', authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'create'), RecurringInvoiceController.generate);
router.get('/recurring-invoices/:id/invoices', authenticate, resolveTenant, resolveCompany, resolveLocation, can('recurring-invoices', 'view'), RecurringInvoiceController.generatedInvoices);

// ───────────────────────────────────────────────────────────────────
// Bank Reconciliation — import statement + auto/manual match
// ───────────────────────────────────────────────────────────────────
router.post('/bank/import',                         authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'create'), validate(importBankSchema), BankController.importTxns);
router.get('/bank/transactions',                    authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'view'),   BankController.list);
router.get('/bank/transactions/:id/candidates',     authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'view'),   BankController.candidates);
router.post('/bank/transactions/:id/match',         authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'edit'),   BankController.match);
router.post('/bank/transactions/:id/unmatch',       authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'edit'),   BankController.unmatch);
router.post('/bank/transactions/:id/ignore',        authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'edit'),   BankController.ignore);
router.delete('/bank/transactions/:id',             authenticate, resolveTenant, resolveCompany, can('bank-reconciliation', 'delete'), BankController.remove);

// ───────────────────────────────────────────────────────────────────
// e-Invoice (GST IRN) + e-Way Bill — GSP-ready
// ───────────────────────────────────────────────────────────────────
router.get('/einvoices',              authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.list);
// Dashboard + reports — MUST precede '/einvoices/:id' so they aren't read as ids.
router.get('/einvoices/dashboard',    authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.dashboard);
router.get('/einvoices/report',       authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.report);
router.get('/einvoices/:id',          authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.get);
router.get('/einvoices/:id/details',  authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.details);
router.post('/einvoices/bulk-generate', authenticate, resolveTenant, resolveCompany, can('einvoice', 'create'), EInvoiceController.bulkGenerate);
router.post('/einvoices/:id/generate', authenticate, resolveTenant, resolveCompany, can('einvoice', 'create'), EInvoiceController.generate);
router.post('/einvoices/:id/manual',  authenticate, resolveTenant, resolveCompany, can('einvoice', 'edit'),   EInvoiceController.manual);
router.post('/einvoices/:id/cancel',  authenticate, resolveTenant, resolveCompany, can('einvoice', 'edit'),   EInvoiceController.cancel);
// e-Way Bill lifecycle (from an existing IRN).
router.post('/einvoices/:id/eway',            authenticate, resolveTenant, resolveCompany, can('einvoice', 'create'), EInvoiceController.generateEway);
router.post('/einvoices/:id/update-vehicle',  authenticate, resolveTenant, resolveCompany, can('einvoice', 'edit'),   EInvoiceController.updateVehicle);
router.post('/einvoices/:id/extend',          authenticate, resolveTenant, resolveCompany, can('einvoice', 'edit'),   EInvoiceController.extendValidity);
// Delivery — Download (JSON) / Email / WhatsApp (no browser print).
router.get('/einvoices/:id/download',         authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.download);
router.post('/einvoices/:id/email',           authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.email);
router.post('/einvoices/:id/whatsapp',        authenticate, resolveTenant, resolveCompany, can('einvoice', 'view'),   EInvoiceController.whatsapp);

// ───────────────────────────────────────────────────────────────────
// Product images (multi-image gallery, local upload — NOT synced to Tally)
// ───────────────────────────────────────────────────────────────────
router.get('/products/:id/images',             authenticate, resolveTenant, resolveCompany, can('products', 'view'), ProductImageController.list);
router.post('/products/:id/images',            authenticate, resolveTenant, resolveCompany, can('products', 'edit'), productImagesMiddleware, ProductImageController.upload);
router.delete('/products/:id/images/:imageId', authenticate, resolveTenant, resolveCompany, can('products', 'edit'), ProductImageController.remove);

// ───────────────────────────────────────────────────────────────────
// Products (protected tenant CRUD)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/products',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canProductRead,
    validate(listProductSchema, 'query'),
    ProductController.list,
);

router.get(
    '/products/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canProductRead,
    ProductController.get,
);

router.post(
    '/products',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('products', 'create'),
    validate(createProductSchema),
    ProductController.create,
);

router.put(
    '/products/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('products', 'edit'),
    validate(updateProductSchema),
    ProductController.update,
);

router.delete(
    '/products/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('products', 'delete'),
    ProductController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Customer Groups (protected tenant CRUD — gated under the 'customers'
// module; the table has no own permission slug)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/customer-groups',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'view'),
    validate(listCustomerGroupSchema, 'query'),
    CustomerGroupController.list,
);

router.get(
    '/customer-groups/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'view'),
    CustomerGroupController.get,
);

router.post(
    '/customer-groups',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'create'),
    validate(createCustomerGroupSchema),
    CustomerGroupController.create,
);

router.put(
    '/customer-groups/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'edit'),
    validate(updateCustomerGroupSchema),
    CustomerGroupController.update,
);

router.delete(
    '/customer-groups/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'delete'),
    CustomerGroupController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Sales Invoices (bespoke controller — header + nested items, totals
// computed server-side; no update — invoices are immutable once cut)
// ───────────────────────────────────────────────────────────────────

router.get(
    '/sales-invoices',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('view'),
    validate(listInvoiceSchema, 'query'),
    InvoiceController.listSales,
);

router.get(
    '/sales-invoices/monthly',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('view'),
    InvoiceController.monthlySales,
);

router.get(
    '/sales-invoices/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('view'),
    InvoiceController.get,
);

router.get(
    '/sales-invoices/:id/pdf',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('view'),
    InvoiceController.pdf,
);

router.post(
    '/sales-invoices',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('create'),
    validate(createSalesInvoiceSchema),
    InvoiceController.createSales,
);

// SFA — a salesman edits their own DRAFT (view+create role; controller enforces
// draft-only + ownership). save_as_draft=false in the body ALSO submits it.
router.put(
    '/sales-invoices/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('create'),
    validate(createSalesInvoiceSchema),
    InvoiceController.updateDraft,
);

// SFA — a salesman submits their own draft for approval ('draft' → 'pending').
router.post(
    '/sales-invoices/:id/submit',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canOwnInvoice('create'),
    InvoiceController.submitDraft,
);

// SFA — a company admin (edit perm) approves / rejects a pending field invoice.
// The controller additionally blocks salesmen (403) so they can't self-approve.
router.post(
    '/sales-invoices/:id/approve',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-invoices', 'edit'),
    InvoiceController.approve,
);
router.post(
    '/sales-invoices/:id/reject',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-invoices', 'edit'),
    InvoiceController.reject,
);

router.delete(
    '/sales-invoices/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('sales-invoices', 'delete'),
    InvoiceController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Quotations (bespoke controller — header + nested items, totals computed
// server-side; no ledger/stock/GST effect until converted to a sales invoice)
// ───────────────────────────────────────────────────────────────────

router.get('/quotations', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'view'), validate(listQuotationSchema, 'query'), QuotationController.list);
router.get('/quotations/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'view'), QuotationController.get);
router.get('/quotations/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'view'), QuotationController.pdf);
router.post('/quotations', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'create'), validate(createQuotationSchema), QuotationController.create);
router.put('/quotations/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'edit'), validate(createQuotationSchema), QuotationController.updateDraft);
router.post('/quotations/:id/convert', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'edit'), QuotationController.convert);
router.delete('/quotations/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('quotations', 'delete'), QuotationController.destroy);

router.get('/sales-orders', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'view'), validate(listSalesOrderSchema, 'query'), SalesOrderController.list);
router.get('/sales-orders/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'view'), SalesOrderController.get);
router.get('/sales-orders/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'view'), SalesOrderController.pdf);
router.post('/sales-orders', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'create'), validate(createSalesOrderSchema), SalesOrderController.create);
router.put('/sales-orders/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'edit'), validate(createSalesOrderSchema), SalesOrderController.updateDraft);
router.post('/sales-orders/:id/convert', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'edit'), SalesOrderController.convert);
router.delete('/sales-orders/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('sales-orders', 'delete'), SalesOrderController.destroy);

router.get('/delivery-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'view'), validate(listDeliveryNoteSchema, 'query'), DeliveryNoteController.list);
router.get('/delivery-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'view'), DeliveryNoteController.get);
router.get('/delivery-notes/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'view'), DeliveryNoteController.pdf);
router.post('/delivery-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'create'), validate(createDeliveryNoteSchema), DeliveryNoteController.create);
router.put('/delivery-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'edit'), validate(createDeliveryNoteSchema), DeliveryNoteController.updateDraft);
router.post('/delivery-notes/:id/convert', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'edit'), DeliveryNoteController.convert);
router.delete('/delivery-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('delivery-notes', 'delete'), DeliveryNoteController.destroy);

// Stock Journal / Physical Stock — goods vouchers, no ledger/GST/totals; both
// end here (Task 2 documents no convert step for either).
router.get('/stock-journals', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('stock-journal', 'view'), validate(listStockJournalSchema, 'query'), StockJournalController.list);
router.get('/stock-journals/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('stock-journal', 'view'), StockJournalController.get);
router.post('/stock-journals', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('stock-journal', 'create'), validate(createStockJournalSchema), StockJournalController.create);
router.delete('/stock-journals/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('stock-journal', 'delete'), StockJournalController.destroy);

router.get('/physical-stock', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('physical-stock', 'view'), validate(listPhysicalStockSchema, 'query'), PhysicalStockController.list);
router.get('/physical-stock/:voucher_no', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('physical-stock', 'view'), PhysicalStockController.get);
router.post('/physical-stock', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('physical-stock', 'create'), validate(createPhysicalStockSchema), PhysicalStockController.create);

// Credit Note / Debit Note — ReturnNoteController runs on the SHARED
// `invoices` table (see that controller's header comment), parameterised on
// `kind` ('credit' | 'debit') via a tiny middleware that just stamps
// req.returnNoteKind before the handler runs. Two parallel route sets, same
// chain shape as delivery-notes above; RBAC is per-kind ('credit-notes' /
// 'debit-notes') so a role can be granted one without the other.
const setReturnNoteKind = (kind) => (req, res, next) => { req.returnNoteKind = kind; next(); };

router.get('/credit-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('credit-notes', 'view'), setReturnNoteKind('credit'), validate(listReturnNoteSchema, 'query'), ReturnNoteController.list);
router.get('/credit-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('credit-notes', 'view'), setReturnNoteKind('credit'), ReturnNoteController.get);
router.get('/credit-notes/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('credit-notes', 'view'), setReturnNoteKind('credit'), ReturnNoteController.pdf);
router.post('/credit-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('credit-notes', 'create'), setReturnNoteKind('credit'), validate(createReturnNoteSchema), ReturnNoteController.create);
router.put('/credit-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('credit-notes', 'edit'), setReturnNoteKind('credit'), validate(createReturnNoteSchema), ReturnNoteController.updateDraft);
router.delete('/credit-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('credit-notes', 'delete'), setReturnNoteKind('credit'), ReturnNoteController.destroy);

router.get('/debit-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('debit-notes', 'view'), setReturnNoteKind('debit'), validate(listReturnNoteSchema, 'query'), ReturnNoteController.list);
router.get('/debit-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('debit-notes', 'view'), setReturnNoteKind('debit'), ReturnNoteController.get);
router.get('/debit-notes/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('debit-notes', 'view'), setReturnNoteKind('debit'), ReturnNoteController.pdf);
router.post('/debit-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('debit-notes', 'create'), setReturnNoteKind('debit'), validate(createReturnNoteSchema), ReturnNoteController.create);
router.put('/debit-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('debit-notes', 'edit'), setReturnNoteKind('debit'), validate(createReturnNoteSchema), ReturnNoteController.updateDraft);
router.delete('/debit-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('debit-notes', 'delete'), setReturnNoteKind('debit'), ReturnNoteController.destroy);

router.get('/receipt-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'view'), validate(listReceiptNoteSchema, 'query'), ReceiptNoteController.list);
router.get('/receipt-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'view'), ReceiptNoteController.get);
router.get('/receipt-notes/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'view'), ReceiptNoteController.pdf);
router.post('/receipt-notes', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'create'), validate(createReceiptNoteSchema), ReceiptNoteController.create);
router.put('/receipt-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'edit'), validate(createReceiptNoteSchema), ReceiptNoteController.updateDraft);
router.post('/receipt-notes/:id/convert', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'edit'), ReceiptNoteController.convert);
router.delete('/receipt-notes/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('receipt-notes', 'delete'), ReceiptNoteController.destroy);

// My Vouchers — a read-only roll-up of every voucher family the CURRENT user
// created, across companies' worth of tables. Gated the same way the SFA
// "field-sales" own-invoices view is (canOwnInvoice uses this same module).
router.get('/my/vouchers', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('field-sales', 'view'), MyEntriesController.list);

router.get('/purchase-orders', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'view'), validate(listPurchaseOrderSchema, 'query'), PurchaseOrderController.list);
router.get('/purchase-orders/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'view'), PurchaseOrderController.get);
router.get('/purchase-orders/:id/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'view'), PurchaseOrderController.pdf);
router.post('/purchase-orders', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'create'), validate(createPurchaseOrderSchema), PurchaseOrderController.create);
router.put('/purchase-orders/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'edit'), validate(createPurchaseOrderSchema), PurchaseOrderController.updateDraft);
router.post('/purchase-orders/:id/convert', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'edit'), PurchaseOrderController.convert);
router.delete('/purchase-orders/:id', authenticate, resolveTenant, resolveCompany, resolveLocation,
    can('purchase-orders', 'delete'), PurchaseOrderController.destroy);

// ───────────────────────────────────────────────────────────────────
// Purchase Invoices (same bespoke controller, type='purchase')
// ───────────────────────────────────────────────────────────────────

router.get(
    '/purchase-invoices',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-invoices', 'view'),
    validate(listInvoiceSchema, 'query'),
    InvoiceController.listPurchase,
);

router.get(
    '/purchase-invoices/monthly',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-invoices', 'view'),
    InvoiceController.monthlyPurchase,
);

router.get(
    '/purchase-invoices/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-invoices', 'view'),
    InvoiceController.get,
);

router.get(
    '/purchase-invoices/:id/pdf',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-invoices', 'view'),
    InvoiceController.pdf,
);

router.post(
    '/purchase-invoices',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-invoices', 'create'),
    validate(createPurchaseInvoiceSchema),
    InvoiceController.createPurchase,
);

router.delete(
    '/purchase-invoices/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-invoices', 'delete'),
    InvoiceController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Payments (money-out vouchers — bespoke controller, type='payment')
// ───────────────────────────────────────────────────────────────────

router.get(
    '/payments',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'view'),
    validate(listPaymentSchema, 'query'),
    PaymentController.listPayments,
);

router.get(
    '/payments/monthly',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'view'),
    PaymentController.monthlyPayments,
);

router.get(
    '/payments/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'view'),
    PaymentController.get,
);

router.post(
    '/payments',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'create'),
    validate(createPaymentSchema),
    PaymentController.createPayment,
);

router.delete(
    '/payments/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'delete'),
    PaymentController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Receipts (money-in vouchers — same bespoke controller, type='receipt')
// ───────────────────────────────────────────────────────────────────

router.get(
    '/receipts',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('receipts', 'view'),
    validate(listPaymentSchema, 'query'),
    PaymentController.listReceipts,
);

router.get(
    '/receipts/monthly',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('receipts', 'view'),
    PaymentController.monthlyReceipts,
);

router.get(
    '/receipts/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('receipts', 'view'),
    PaymentController.get,
);

router.post(
    '/receipts',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('receipts', 'create'),
    validate(createReceiptSchema),
    PaymentController.createReceipt,
);

router.delete(
    '/receipts/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('receipts', 'delete'),
    PaymentController.destroy,
);

// ───────────────────────────────────────────────────────────────────
// Dashboard · Inventory · Users · Settings · Tally-Sync · Reports
// (read/CRUD endpoints backing the corresponding web pages)
// ───────────────────────────────────────────────────────────────────

// Companies (tenant) — list (license-scoped) + register a new one.
router.get(
    '/companies',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('companies', 'view'),
    validate(listCompanySchema, 'query'),
    TenantCompanyController.list,
);
router.post(
    '/companies',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('companies', 'create'),
    validate(createCompanySchema),
    TenantCompanyController.create,
);
router.get(
    '/companies/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('companies', 'view'),
    TenantCompanyController.get,
);
router.put(
    '/companies/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('companies', 'edit'),
    TenantCompanyController.update,
);
router.delete(
    '/companies/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('companies', 'delete'),
    TenantCompanyController.destroy,
);

// Dashboard summary — counts + charts + recent activity.
router.get(
    '/dashboard/summary',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('dashboard', 'view'),
    DashboardController.summary,
);

// Tally chart-of-accounts listing — the drill-down target for the dashboard's
// CASH / BANK / PAYABLES tiles (?group=cash|bank|payables).
router.get(
    '/tally/ledgers',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('dashboard', 'view'),
    TallyLedgerController.list,
);

// Sales ledgers (Tally group "Sales Accounts") for the Quotation form's
// "Ledger Type" combobox. Gated on the quotations module, not dashboard —
// this is used from the quotation create screen, not a dashboard drill-down.
router.get(
    '/tally/ledgers/sales-options',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('quotations', 'view'),
    TallyLedgerController.salesLedgerOptions,
);

// Purchase ledgers (Tally group "Purchase Accounts") for the Purchase Order
// form's "Ledger Type" combobox. Gated on the purchase-orders module, not
// dashboard — this is used from the purchase order create screen, not a
// dashboard drill-down.
router.get(
    '/tally/ledgers/purchase-options',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('purchase-orders', 'view'),
    TallyLedgerController.purchaseLedgerOptions,
);

// Party-eligible Tally groups (Sundry Debtors / Sundry Creditors ancestry) for
// the customer form's "Ledger Group" dropdown.
router.get(
    '/tally/ledger-groups',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'view'),
    TallyLedgerController.ledgerGroupOptions,
);

// Country/State/City lookups for the customer address form's cascading
// dropdowns (static data, see Helpers/geo.js).
router.get(
    '/geo/countries',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'view'),
    GeoController.countries,
);

router.get(
    '/geo/states',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'view'),
    GeoController.states,
);

router.get(
    '/geo/cities',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'view'),
    GeoController.cities,
);

// One ledger's voucher-wise statement (Cash & Bank → ledger drill-down).
router.get(
    '/tally/ledgers/:name/statement',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('dashboard', 'view'),
    TallyLedgerController.statement,
);

// One Tally-origin voucher — its double entry + item movement (read-only).
router.get(
    '/tally/vouchers/:guid',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('dashboard', 'view'),
    TallyLedgerController.voucher,
);

// GST Search — decode a GSTIN offline (state/PAN/entity number) and report
// whether a live lookup provider (legal/trade name, address, registration
// status) is configured. See Helpers/gstin.js and GstSearchController.
router.get(
    '/gst/verify',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('gst-search', 'view'),
    GstSearchController.verify,
);

// SFA — the logged-in salesman's field dashboard (assigned locations + their
// customer/invoice tallies + approval-status counts). resolveLocation sets
// req.isSalesman/req.salesPersonId that the controller scopes on.
router.get(
    '/field/my-dashboard',
    authenticate, resolveTenant, resolveCompany, resolveLocation, canField,
    FieldController.myDashboard,
);

// SFA Phase 2 — GPS field tracking. Attendance (Start/End Day) + outlet
// check-in/out. resolveLocation sets req.isSalesman/req.salesPersonId; the
// controller enforces salesman-only writes + own-row scoping.
router.post('/field/day/start',            authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.startDay);
router.post('/field/day/end',              authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.endDay);
router.post('/field/visits/checkin',       authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.checkin);
router.post('/field/visits/:id/checkout',  authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.checkout);
router.get('/field/visits',                authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.visits);

// SFA — configurable GPS tracking. The app reads its config, then pings location
// (de-duped by min-move) + logs part-visits; admins read the trail.
router.get('/field/gps-config',            authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.gpsConfig);
router.post('/field/locations',            authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.ping);
router.post('/field/part-visits',          authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.partVisit);
router.get('/field/locations',             authenticate, resolveTenant, resolveCompany, resolveLocation, canField, FieldController.locations);

// Inventory — stock view derived from products + manual stock adjustment.
router.get(
    '/inventory',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('inventory', 'view'),
    InventoryController.list,
);
router.post(
    '/inventory/adjust',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('inventory', 'edit'),
    validate(createAdjustmentSchema),
    InventoryController.adjust,
);

// Roles — assignable-roles list for the Add/Edit User dropdown (license-scoped).
router.get(
    '/roles',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('users', 'view'),
    RoleController.list,
);

// Tenant (license-admin) custom-role MANAGEMENT (Phase C). License-scoped; a
// license-admin builds roles only from the modules their license is entitled to.
// NOTE: 'available-permissions' is registered before '/:id' so it isn't captured.
router.get('/account/roles',
    authenticate, resolveTenant, can('users','view'), RoleController.manageList);
router.get('/account/roles/available-permissions',
    authenticate, resolveTenant, can('users','view'), RoleController.availablePermissions);
router.get('/account/roles/:id',
    authenticate, resolveTenant, can('users','view'), RoleController.get);
router.post('/account/roles',
    authenticate, resolveTenant, can('users','create'), validate(createRoleSchema), RoleController.create);
router.put('/account/roles/:id',
    authenticate, resolveTenant, can('users','edit'), validate(updateRoleSchema), RoleController.update);
router.put('/account/roles/:id/permissions',
    authenticate, resolveTenant, can('users','edit'), validate(setRolePermissionsSchema), RoleController.setPermissions);
router.delete('/account/roles/:id',
    authenticate, resolveTenant, can('users','delete'), RoleController.remove);

// Account · "Share with Accountant" (CA collaboration). Company-scoped (the CA
// login is created under req.companyId); the curated read-only Accountant role
// is licence-scoped via req.user.license_id. Validated + seat-reconciled.
router.post('/account/accountants',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('users', 'create'),
    validate(inviteAccountantSchema), AccountantController.invite);
router.get('/account/accountants',
    authenticate, resolveTenant, resolveCompany, can('users', 'view'), AccountantController.list);
router.delete('/account/accountants/:id',
    authenticate, resolveTenant, resolveCompany, can('users', 'edit'), AccountantController.revoke);

// Account · payment reminders — overdue customers list + manual send. List is
// view-gated; sending is edit-gated (a read-only accountant can see but not send).
router.get('/account/reminders',
    authenticate, resolveTenant, resolveCompany, can('customers', 'view'), ReminderTenantController.overdue);
router.post('/account/reminders/:id/send',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('customers', 'edit'), ReminderTenantController.send);
// Per-party reminder schedule ("Set Reminder"): reading it is view-gated,
// changing it is edit-gated — same split as sending.
router.get('/account/reminders/:id/schedule',
    authenticate, resolveTenant, resolveCompany, can('customers', 'view'), ReminderTenantController.schedule);
router.put('/account/reminders/:id/schedule',
    authenticate, resolveTenant, resolveCompany, can('customers', 'edit'), ReminderTenantController.saveSchedule);

// Account · Business Analytics — one read-only insights bundle (sales trend,
// cash-flow, top customers/products, receivables aging, KPIs).
router.get('/account/analytics',
    authenticate, resolveTenant, resolveCompany, can('reports', 'view'), AnalyticsController.overview);

// Account · cloud→agent command channel (user-auth, license-scoped). A user
// queues "open this company in Tally"; the local agent drains it via /agent/*.
// `authenticate` only — license scope comes from req.user.license_id (same as
// the /account/roles management routes above).
router.post('/account/agent/open-company',
    authenticate, resolveTenant, AgentCommandController.openCompany);
router.get('/account/agent/commands',
    authenticate, resolveTenant, AgentCommandController.list);
// Auto-update (Requirement 3): flip the per-license cloud toggle (the agent
// reads it as authoritative on its next /agent/version check), and "Update now"
// which enqueues a 'self_update' command the agent honours by forcing a check.
router.patch('/account/agent/auto-update',
    authenticate, resolveTenant, AgentCommandController.setAutoUpdate);
router.post('/account/agent/self-update',
    authenticate, resolveTenant, AgentCommandController.selfUpdate);
// Auto-sync DIRECTION (Requirement 1): flip the per-license push/pull AUTO
// toggles (licenses.sync_push_enabled / .sync_pull_enabled). The agent reads
// them back via its heartbeat each cycle and skips the push/pull pass when off.
// License-scoped via req.user.license_id (super-admin may pass license_id).
router.patch('/account/sync-direction',
    authenticate, resolveTenant, AgentCommandController.setSyncDirection);

// Users — company user management.
router.get(
    '/users',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('users', 'view'),
    validate(listUserSchema, 'query'),
    UserController.list,
);
router.post(
    '/users',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('users', 'create'),
    validate(createUserSchema),
    UserController.create,
);

// Settings — company profile + key/value settings.
router.get(
    '/settings',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('settings', 'view'),
    SettingsController.get,
);
router.put(
    '/settings',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('settings', 'edit'),
    SettingsController.update,
);

// Connected computers. Licence-level, so no company/location scope — a device
// belongs to the licence, not to one company's books. Viewing needs the same
// permission as the rest of Tally sync; DISCONNECTING needs 'delete', because
// cutting a machine off stops that customer syncing until someone signs in on
// it again.
router.get(
    '/devices',
    authenticate, resolveTenant, can('tally-sync', 'view'),
    DeviceController.list,
);
router.post(
    '/devices/:id/revoke',
    authenticate, resolveTenant, can('tally-sync', 'delete'),
    DeviceController.revoke,
);

// Tally sync — connection summary + log stream.
router.get(
    '/sync/summary',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    SyncController.summary,
);
router.get(
    '/sync/logs',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    SyncController.logs,
);
// Single log row (full detail incl request_xml/response_xml + friendlyReason)
// for the Sync Logs detail popup. Registered AFTER '/sync/logs' so the literal
// path wins; ':id' captures only the detail lookups.
router.get(
    '/sync/logs/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    SyncController.logDetail,
);
// Re-queue this company's failed/pending push records so the agent re-pushes
// next cycle (direction=push, the default). Optional body { module } scopes it
// to one module. direction=pull delegates to pull() (resets the watermark so
// the agent re-imports). Idempotent. MANUAL — not gated by the auto toggles.
router.post(
    '/sync/retry',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    SyncController.retry,
);
// MANUAL "Sync from Tally" (PULL): reset this company's tally_sync_state
// watermark so the agent re-imports the module (or all) from Tally next pull.
// Independent of the per-license sync_pull_enabled auto toggle. Idempotent.
router.post(
    '/sync/pull',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    SyncController.pull,
);
// Notification-bell feed — now a GENERAL feed (every module's cloud actions +
// sync failures + agent updates), each item with a deep-link + PER-USER `read`
// flag. EVERY logged-in user gets their company's notifications, so these are
// guarded by auth + company scope only (NOT the tally-sync permission).
router.get(
    '/sync/notifications',
    authenticate, resolveTenant, resolveCompany, resolveLocation,
    SyncController.notifications,
);
// Paginated FULL feed for the dedicated /notifications page (View all + details).
router.get(
    '/sync/notifications/all',
    authenticate, resolveTenant, resolveCompany, resolveLocation,
    SyncController.notificationsAll,
);
// Mark ONE (or a few) bell item(s) read for the caller. Body { key } or
// { keys:[...] } — a body key (NOT a :id path param) because keys like
// "agent-update-1.2.0" contain dots. Returns the fresh read-aware { unread }.
router.post(
    '/sync/notifications/read',
    authenticate, resolveTenant, resolveCompany, resolveLocation,
    SyncController.markRead,
);
// Mark ALL currently-unread bell items read for the caller. Returns { unread:0 }.
router.post(
    '/sync/notifications/read-all',
    authenticate, resolveTenant, resolveCompany, resolveLocation,
    SyncController.markAllRead,
);

// ───────────────────────────────────────────────────────────────────
// Change HISTORY (per-record before/after, company-scoped). Guarded with
// the same tally-sync slugs as /sync/* (history hangs off the Sync area).
// The literal '/history/compare' is registered BEFORE '/history/:id' so the
// param route never captures it.
// ───────────────────────────────────────────────────────────────────
router.get(
    '/history',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    HistoryController.list,
);
router.get(
    '/history/compare',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    HistoryController.compare,
);
router.get(
    '/history/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'view'),
    HistoryController.get,
);
router.post(
    '/history/:id/revert',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('tally-sync', 'edit'),
    HistoryController.revert,
);

// Journal vouchers (Dr/Cr accounting entry — syncs to Tally as a Journal).
router.get(
    '/journals',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'view'),
    validate(listJournalSchema, 'query'),
    JournalController.list,
);
router.get(
    '/journals/monthly',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'view'),
    JournalController.monthly,
);
router.post(
    '/journals',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'create'),
    validate(createJournalSchema),
    JournalController.create,
);
router.delete(
    '/journals/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('payments', 'delete'),
    JournalController.destroy,
);

// Contra vouchers — a cash⇄bank transfer. Same JournalController handlers as
// Journals (it's the same `journals` table/vch_type catalogue), gated on its
// own 'contra' module and always forced to vch_type: 'Contra' at the route
// level (not in the controller) so the Journal path above stays untouched.
function forceContraType(req, res, next) {
    if (req.method === 'GET') req.query.vch_type = 'Contra';
    else req.body.vch_type = 'Contra';
    next();
}
router.get(
    '/contra',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('contra', 'view'),
    forceContraType,
    validate(listJournalSchema, 'query'),
    JournalController.list,
);
router.get(
    '/contra/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('contra', 'view'),
    JournalController.get,
);
router.post(
    '/contra',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('contra', 'create'),
    forceContraType,
    validate(createJournalSchema),
    JournalController.create,
);
router.delete(
    '/contra/:id',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('contra', 'delete'),
    JournalController.destroy,
);

// Reports — Tally-style registers (GST breakup, day book, outstanding, GST).
router.get(
    '/reports/sales-register',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'),
    ReportController.salesRegister,
);
router.get(
    '/reports/day-book',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'),
    ReportController.dayBook,
);
router.get(
    '/reports/outstanding',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'),
    ReportController.outstanding,
);
router.get(
    '/reports/gst-summary',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'),
    ReportController.gstSummary,
);
router.get(
    '/reports/stock-summary',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'),
    ReportController.stockSummary,
);
router.get(
    '/reports/ledger',
    authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'),
    ReportController.partyLedger,
);
router.get('/reports/trial-balance', authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'), ReportController.trialBalance);
router.get('/reports/profit-loss',   authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'), ReportController.profitLoss);
router.get('/reports/balance-sheet', authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'), ReportController.balanceSheet);

// Server-rendered, data-ONLY PDF of ANY report (no app chrome) — same data as
// the JSON endpoints above. 3-segment path, so it never shadows them.
router.get('/reports/:type/pdf', authenticate, resolveTenant, resolveCompany, resolveLocation, can('reports', 'view'), ReportController.reportPdf);

module.exports = router;
