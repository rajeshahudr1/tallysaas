'use strict';

/* ─────────────────────────────────────────────────────────────
 * data/mock.js — single source of ALL mock data for the Phase-1
 * UI build (see docs/PHASE-1-UI-SPEC.md §7).
 *
 * There is NO backend yet. routes/web.js is the ONLY consumer of
 * this module: it reads these values and passes them into the EJS
 * views. When the real REST API lands, the route handlers swap
 * these reads for `await apiClient.*` calls — the view contracts
 * (field names) stay identical, so the templates never change.
 *
 * Field names below are deliberately the SAME shape the API will
 * return (snake_case for record fields, camelCase for view config)
 * to keep that future swap a one-line change per handler.
 * ─────────────────────────────────────────────────────────── */

/* ── Tenant / identity ──────────────────────────────────────── */

// The currently-selected company shown in the header company picker.
const company = { id: 1, name: 'ABC Pvt. Ltd.' };

// All companies available to switch between (header dropdown).
const companies = [
    { id: 1, name: 'ABC Pvt. Ltd.' },
    { id: 2, name: 'XYZ Industries' },
    { id: 3, name: 'Global Traders' },
];

// Signed-in user (no auth in Phase 1 — purely for the header UI).
// `avatar` points at a static asset; the header falls back to initials
// if the image is missing.
const user = {
    name: 'Rajesh Admin',
    role: 'Super Admin',
    avatar: '/img/avatar.svg',
    initials: 'RA',
};

// Unread notification count → red badge on the header bell.
const notificationCount = 5;

/* ── Dropdown option sources (shared by filters + forms) ────── */

const locations      = ['Ahmedabad', 'Surat', 'Mumbai'];
const salesPersons   = ['Rajesh Kumar', 'Amit Shah', 'Neha Patel'];
const customerGroups = ['Retail', 'Wholesale', 'Distributor'];

/* ── Customers (PAGE 1 — listing) ───────────────────────────────
 * Exact values per spec §7. 10 visible rows; the full dataset is
 * 156 records (customersTotal) — only page 1 is rendered.
 * `id` is added for action links / row keys; everything else is
 * verbatim from the spec table.
 * ─────────────────────────────────────────────────────────── */

const customers = [
    { id: 1,  name: 'Amit Enterprises',     location: 'Ahmedabad', mobile: '9876543210', gst: '24ABCDE1234F1Z5', opening_balance: 25000,  credit_limit: 100000, sales_person: 'Rajesh Kumar', status: 'Active',   created_at: '20/05/2024' },
    { id: 2,  name: 'Shreeji Traders',      location: 'Surat',     mobile: '9823456789', gst: '24FGHJK5678L2Z3', opening_balance: 15500,  credit_limit: 75000,  sales_person: 'Amit Shah',    status: 'Active',   created_at: '18/05/2024' },
    { id: 3,  name: 'Patel & Co.',          location: 'Mumbai',    mobile: '9922334455', gst: '27ABCDE9876M1Z2', opening_balance: 0,      credit_limit: 50000,  sales_person: 'Neha Patel',   status: 'Active',   created_at: '17/05/2024' },
    { id: 4,  name: 'Jai Mata Di Stores',   location: 'Ahmedabad', mobile: '9712345678', gst: '24QWERT1234R1Z5', opening_balance: 5000,   credit_limit: 25000,  sales_person: 'Rajesh Kumar', status: 'Active',   created_at: '15/05/2024' },
    { id: 5,  name: 'Shiv Shakti Traders',  location: 'Surat',     mobile: '9898765432', gst: '24TYUIO4567P1Z4', opening_balance: 12750,  credit_limit: 60000,  sales_person: 'Amit Shah',    status: 'Inactive', created_at: '14/05/2024' },
    { id: 6,  name: 'Bansal Sales',         location: 'Mumbai',    mobile: '9933221100', gst: '27ASDFG6789H1Z2', opening_balance: 32000,  credit_limit: 150000, sales_person: 'Neha Patel',   status: 'Active',   created_at: '12/05/2024' },
    { id: 7,  name: 'National Enterprises', location: 'Ahmedabad', mobile: '9879879876', gst: '24ZXCVB1234N1Z5', opening_balance: 0,      credit_limit: 40000,  sales_person: 'Rajesh Kumar', status: 'Active',   created_at: '11/05/2024' },
    { id: 8,  name: 'Krishna Traders',      location: 'Surat',     mobile: '9911112222', gst: '24PLMNB5678Q1Z3', opening_balance: 8900,   credit_limit: 35000,  sales_person: 'Amit Shah',    status: 'Inactive', created_at: '10/05/2024' },
    { id: 9,  name: 'Maa Durga Stores',     location: 'Mumbai',    mobile: '9867876543', gst: '27ZXCVB9876K1Z9', opening_balance: 3200,   credit_limit: 20000,  sales_person: 'Neha Patel',   status: 'Active',   created_at: '09/05/2024' },
    { id: 10, name: 'Balaji Enterprises',   location: 'Ahmedabad', mobile: '9800001111', gst: '24POIUY4567T1Z6', opening_balance: 45000,  credit_limit: 200000, sales_person: 'Rajesh Kumar', status: 'Active',   created_at: '08/05/2024' },
];

// Total records in the (mock) full dataset → pagination "of 156".
const customersTotal = 156;
const page    = 1;
const perPage = 10;

/* ── Companies (MASTERS → Companies) ────────────────────────────
 * The richer per-row dataset behind the Companies listing. Distinct
 * from the lightweight `companies` array above (which only feeds the
 * header company-switcher). 8 rows → matches the dashboard "Total
 * Companies = 8" stat. Field names mirror the future API shape.
 * ─────────────────────────────────────────────────────────── */

const financialYears = ['2024-2025', '2023-2024', '2022-2023'];

const companiesList = [
    { id: 1, name: 'ABC Pvt. Ltd.',       gst: '24ABCDE1234F1Z5', pan: 'ABCDE1234F', mobile: '9876500001', email: 'info@abcpvt.com',          financial_year: '2024-2025', status: 'Active',   created_at: '01/04/2024' },
    { id: 2, name: 'XYZ Industries',      gst: '24XYZAB5678C1Z3', pan: 'XYZAB5678C', mobile: '9876500002', email: 'contact@xyzind.com',       financial_year: '2024-2025', status: 'Active',   created_at: '05/04/2024' },
    { id: 3, name: 'Global Traders',      gst: '27GLOBT9012D1Z2', pan: 'GLOBT9012D', mobile: '9876500003', email: 'sales@globaltraders.com',  financial_year: '2024-2025', status: 'Active',   created_at: '10/04/2024' },
    { id: 4, name: 'Shree Enterprises',   gst: '24SHREE3456E1Z5', pan: 'SHREE3456E', mobile: '9876500004', email: 'hello@shree.com',          financial_year: '2023-2024', status: 'Active',   created_at: '15/03/2024' },
    { id: 5, name: 'Maruti Distributors', gst: '24MARUT7890F1Z4', pan: 'MARUT7890F', mobile: '9876500005', email: 'info@maruti.com',          financial_year: '2024-2025', status: 'Inactive', created_at: '20/04/2024' },
    { id: 6, name: 'Bharat Steels',       gst: '27BHART2345G1Z2', pan: 'BHART2345G', mobile: '9876500006', email: 'accounts@bharatsteels.com', financial_year: '2024-2025', status: 'Active',   created_at: '25/04/2024' },
    { id: 7, name: 'Krishna Agro',        gst: '24KRISH6789H1Z3', pan: 'KRISH6789H', mobile: '9876500007', email: 'krishna@agro.com',         financial_year: '2023-2024', status: 'Active',   created_at: '28/03/2024' },
    { id: 8, name: 'Sai Textiles',        gst: '27SAITX0123I1Z9', pan: 'SAITX0123I', mobile: '9876500008', email: 'sai@textiles.com',         financial_year: '2024-2025', status: 'Active',   created_at: '02/04/2024' },
];

const companiesTotal = companiesList.length; // 8 → pagination "of 8"

/* ── Locations (MASTERS → Locations) ────────────────────────────
 * Branch/location master for the current company. Each location can
 * own many customers; `customers` here is a derived count for display.
 * Field names mirror the future API shape.
 * ─────────────────────────────────────────────────────────── */

const states = ['Gujarat', 'Maharashtra', 'Rajasthan', 'Madhya Pradesh', 'Karnataka', 'Delhi'];

const locationsList = [
    { id: 1, name: 'Ahmedabad', code: 'AHM', city: 'Ahmedabad', state: 'Gujarat',     pincode: '380001', mobile: '9876511001', manager: 'Rajesh Kumar', customers: 48, status: 'Active',   created_at: '02/04/2024' },
    { id: 2, name: 'Surat',     code: 'SRT', city: 'Surat',     state: 'Gujarat',     pincode: '395001', mobile: '9876511002', manager: 'Amit Shah',    customers: 32, status: 'Active',   created_at: '04/04/2024' },
    { id: 3, name: 'Mumbai',    code: 'MUM', city: 'Mumbai',    state: 'Maharashtra', pincode: '400001', mobile: '9876511003', manager: 'Neha Patel',   customers: 41, status: 'Active',   created_at: '06/04/2024' },
    { id: 4, name: 'Vadodara',  code: 'VAD', city: 'Vadodara',  state: 'Gujarat',     pincode: '390001', mobile: '9876511004', manager: 'Rajesh Kumar', customers: 18, status: 'Active',   created_at: '10/04/2024' },
    { id: 5, name: 'Pune',      code: 'PUN', city: 'Pune',      state: 'Maharashtra', pincode: '411001', mobile: '9876511005', manager: 'Neha Patel',   customers: 12, status: 'Inactive', created_at: '12/04/2024' },
    { id: 6, name: 'Rajkot',    code: 'RJK', city: 'Rajkot',    state: 'Gujarat',     pincode: '360001', mobile: '9876511006', manager: 'Amit Shah',    customers: 5,  status: 'Active',   created_at: '15/04/2024' },
];

const locationsTotal = locationsList.length; // 6

// Flat list of all location names — used by the Sales-Person location
// filter and the "Assigned Locations" mapping UI (superset of the
// 3-name `locations` array used by the Customer filter).
const locationNames = locationsList.map(function (l) { return l.name; });

/* ── Sales Persons (MASTERS → Sales Persons) ────────────────────
 * A sales person is mapped to MANY locations (SalesPersonLocation
 * mapping) and only sees customers in those locations. `locations`
 * holds the assigned location names; `customers` is a derived count.
 * ─────────────────────────────────────────────────────────── */

const salesPersonsList = [
    { id: 1, name: 'Rajesh Kumar', employee_code: 'EMP001', mobile: '9876521001', email: 'rajesh@abc.com', locations: ['Ahmedabad', 'Vadodara'],            customers: 66, status: 'Active',   created_at: '02/04/2024' },
    { id: 2, name: 'Amit Shah',    employee_code: 'EMP002', mobile: '9876521002', email: 'amit@abc.com',   locations: ['Surat', 'Rajkot'],                 customers: 37, status: 'Active',   created_at: '05/04/2024' },
    { id: 3, name: 'Neha Patel',   employee_code: 'EMP003', mobile: '9876521003', email: 'neha@abc.com',   locations: ['Mumbai', 'Pune'],                  customers: 53, status: 'Active',   created_at: '08/04/2024' },
    { id: 4, name: 'Kiran Mehta',  employee_code: 'EMP004', mobile: '9876521004', email: 'kiran@abc.com',  locations: ['Ahmedabad'],                       customers: 22, status: 'Inactive', created_at: '12/04/2024' },
    { id: 5, name: 'Pooja Sharma', employee_code: 'EMP005', mobile: '9876521005', email: 'pooja@abc.com',  locations: ['Surat', 'Ahmedabad', 'Mumbai'],    customers: 44, status: 'Active',   created_at: '15/04/2024' },
];

const salesPersonsTotal = salesPersonsList.length; // 5

/* ── Suppliers (MASTERS → Suppliers) ────────────────────────────
 * Mirrors customers but for the payables side (Sundry Creditors in
 * Tally). `opening_balance` here is what WE owe; `payment_terms` is
 * the agreed credit period.
 * ─────────────────────────────────────────────────────────── */

const supplierGroups = ['Raw Material', 'Packaging', 'Services', 'Transport'];
const paymentTerms   = ['On Delivery', '7 Days', '15 Days', '30 Days', '45 Days', '60 Days'];

const suppliersList = [
    { id: 1, name: 'Steelco Industries',  location: 'Ahmedabad', mobile: '9876531001', gst: '24STEEL1234A1Z5', opening_balance: 45000, payment_terms: '30 Days',     group: 'Raw Material', status: 'Active',   created_at: '03/04/2024' },
    { id: 2, name: 'PackWell Pvt Ltd',    location: 'Surat',     mobile: '9876531002', gst: '24PACKW5678B1Z3', opening_balance: 22000, payment_terms: '15 Days',     group: 'Packaging',    status: 'Active',   created_at: '06/04/2024' },
    { id: 3, name: 'Mumbai Logistics',    location: 'Mumbai',    mobile: '9876531003', gst: '27MUMLG9012C1Z2', opening_balance: 0,     payment_terms: 'On Delivery', group: 'Transport',    status: 'Active',   created_at: '08/04/2024' },
    { id: 4, name: 'Gujarat Chemicals',   location: 'Vadodara',  mobile: '9876531004', gst: '24GUJCH3456D1Z5', opening_balance: 78000, payment_terms: '45 Days',     group: 'Raw Material', status: 'Active',   created_at: '11/04/2024' },
    { id: 5, name: 'Shakti Traders',      location: 'Surat',     mobile: '9876531005', gst: '24SHAKT7890E1Z4', opening_balance: 12500, payment_terms: '30 Days',     group: 'Raw Material', status: 'Inactive', created_at: '13/04/2024' },
    { id: 6, name: 'Prime Services',      location: 'Mumbai',    mobile: '9876531006', gst: '27PRIME2345F1Z2', opening_balance: 5600,  payment_terms: '7 Days',      group: 'Services',     status: 'Active',   created_at: '16/04/2024' },
    { id: 7, name: 'National Packaging',  location: 'Ahmedabad', mobile: '9876531007', gst: '24NATPK6789G1Z3', opening_balance: 33400, payment_terms: '15 Days',     group: 'Packaging',    status: 'Active',   created_at: '18/04/2024' },
    { id: 8, name: 'Royal Transport',     location: 'Rajkot',    mobile: '9876531008', gst: '24ROYTR0123H1Z9', opening_balance: 0,     payment_terms: 'On Delivery', group: 'Transport',    status: 'Active',   created_at: '20/04/2024' },
];

const suppliersTotal = suppliersList.length; // 8

/* ── Categories (MASTERS → Categories) ──────────────────────────
 * Product category tree (parent === '—' means a root category).
 * `products` is a derived count. Reused by the Products dropdowns.
 * ─────────────────────────────────────────────────────────── */

const categoriesList = [
    { id: 1, name: 'Steel & Metal',       parent: '—',        products: 124, status: 'Active',   created_at: '01/04/2024' },
    { id: 2, name: 'Hardware',            parent: '—',        products: 86,  status: 'Active',   created_at: '01/04/2024' },
    { id: 3, name: 'Pipes & Fittings',    parent: 'Hardware', products: 52,  status: 'Active',   created_at: '02/04/2024' },
    { id: 4, name: 'Electrical',          parent: '—',        products: 73,  status: 'Active',   created_at: '03/04/2024' },
    { id: 5, name: 'Packaging Material',  parent: '—',        products: 41,  status: 'Active',   created_at: '04/04/2024' },
    { id: 6, name: 'Tools',               parent: 'Hardware', products: 38,  status: 'Inactive', created_at: '05/04/2024' },
    { id: 7, name: 'Chemicals',           parent: '—',        products: 28,  status: 'Active',   created_at: '06/04/2024' },
];
const categoriesTotal = categoriesList.length; // 7
const categoryNames   = categoriesList.map(function (c) { return c.name; });

/* ── Products (MASTERS → Products) ──────────────────────────────
 * Tally Stock Items. `stock` is the current on-hand quantity in the
 * product's `unit`. Prices are per-unit. 10 visible rows of 542.
 * ─────────────────────────────────────────────────────────── */

const units    = ['Nos', 'Kg', 'Gram', 'Litre', 'Meter', 'Box', 'Dozen', 'Bag', 'Pack', 'Set'];
const gstRates  = ['0%', '5%', '12%', '18%', '28%'];

const productsList = [
    { id: 1,  name: 'TMT Steel Bar 12mm',     sku: 'SKU-STL-012', category: 'Steel & Metal',      unit: 'Kg',    hsn: '7214', gst_rate: '18%', purchase_price: 52,   sales_price: 58,   stock: 4200, status: 'Active',   created_at: '03/04/2024' },
    { id: 2,  name: 'MS Angle 40mm',          sku: 'SKU-STL-040', category: 'Steel & Metal',      unit: 'Kg',    hsn: '7216', gst_rate: '18%', purchase_price: 48,   sales_price: 54,   stock: 1800, status: 'Active',   created_at: '05/04/2024' },
    { id: 3,  name: 'GI Pipe 1 inch',         sku: 'SKU-PIP-001', category: 'Pipes & Fittings',   unit: 'Meter', hsn: '7306', gst_rate: '18%', purchase_price: 120,  sales_price: 145,  stock: 950,  status: 'Active',   created_at: '07/04/2024' },
    { id: 4,  name: 'PVC Elbow 90°',          sku: 'SKU-PIP-090', category: 'Pipes & Fittings',   unit: 'Nos',   hsn: '3917', gst_rate: '18%', purchase_price: 12,   sales_price: 18,   stock: 6400, status: 'Active',   created_at: '09/04/2024' },
    { id: 5,  name: 'Copper Wire 2.5sqmm',    sku: 'SKU-ELC-025', category: 'Electrical',         unit: 'Meter', hsn: '8544', gst_rate: '18%', purchase_price: 28,   sales_price: 35,   stock: 3200, status: 'Active',   created_at: '11/04/2024' },
    { id: 6,  name: 'LED Bulb 9W',            sku: 'SKU-ELC-009', category: 'Electrical',         unit: 'Nos',   hsn: '8539', gst_rate: '12%', purchase_price: 45,   sales_price: 65,   stock: 1500, status: 'Active',   created_at: '13/04/2024' },
    { id: 7,  name: 'Cement Bag 50kg',        sku: 'SKU-PKG-050', category: 'Packaging Material', unit: 'Bag',   hsn: '3214', gst_rate: '28%', purchase_price: 320,  sales_price: 360,  stock: 480,  status: 'Active',   created_at: '15/04/2024' },
    { id: 8,  name: 'Hand Drill Machine',     sku: 'SKU-TLS-001', category: 'Tools',              unit: 'Nos',   hsn: '8467', gst_rate: '18%', purchase_price: 1850, sales_price: 2200, stock: 65,   status: 'Inactive', created_at: '17/04/2024' },
    { id: 9,  name: 'Steel Screw Box',        sku: 'SKU-HRD-100', category: 'Hardware',           unit: 'Box',   hsn: '7318', gst_rate: '18%', purchase_price: 85,   sales_price: 110,  stock: 920,  status: 'Active',   created_at: '19/04/2024' },
    { id: 10, name: 'Industrial Adhesive 1L', sku: 'SKU-CHM-001', category: 'Chemicals',          unit: 'Litre', hsn: '3506', gst_rate: '18%', purchase_price: 140,  sales_price: 175,  stock: 340,  status: 'Active',   created_at: '21/04/2024' },
];
const productsTotal = 542; // dashboard "Total Products" stat

/* ── Sales Invoices (TRANSACTIONS → Sales Invoices) ─────────────
 * `amount` = taxable value, `gst` = total tax, `total` = grand total.
 * status follows the Tally-sync workflow:
 *   Pending Tally → Sent to Tally → Created  (or → Failed)
 * ─────────────────────────────────────────────────────────── */

const invoiceStatuses = ['Pending Tally', 'Sent to Tally', 'Created', 'Failed'];

const salesInvoicesList = [
    { id: 1,  invoice_no: 'INV-2024-0156', date: '20/05/2024', customer: 'Amit Enterprises',     location: 'Ahmedabad', amount: 38135,  gst: 6865,  total: 45000,  status: 'Created',       sales_person: 'Rajesh Kumar' },
    { id: 2,  invoice_no: 'INV-2024-0155', date: '20/05/2024', customer: 'Shreeji Traders',      location: 'Surat',     amount: 10593,  gst: 1907,  total: 12500,  status: 'Pending Tally', sales_person: 'Amit Shah'    },
    { id: 3,  invoice_no: 'INV-2024-0154', date: '19/05/2024', customer: 'Bansal Sales',         location: 'Mumbai',    amount: 75424,  gst: 13576, total: 89000,  status: 'Created',       sales_person: 'Neha Patel'   },
    { id: 4,  invoice_no: 'INV-2024-0153', date: '19/05/2024', customer: 'Patel & Co.',          location: 'Mumbai',    amount: 6441,   gst: 1159,  total: 7600,   status: 'Failed',        sales_person: 'Neha Patel'   },
    { id: 5,  invoice_no: 'INV-2024-0152', date: '18/05/2024', customer: 'Balaji Enterprises',   location: 'Ahmedabad', amount: 113983, gst: 20517, total: 134500, status: 'Created',       sales_person: 'Rajesh Kumar' },
    { id: 6,  invoice_no: 'INV-2024-0151', date: '18/05/2024', customer: 'National Enterprises', location: 'Ahmedabad', amount: 19830,  gst: 3570,  total: 23400,  status: 'Pending Tally', sales_person: 'Rajesh Kumar' },
    { id: 7,  invoice_no: 'INV-2024-0150', date: '17/05/2024', customer: 'Jai Mata Di Stores',   location: 'Ahmedabad', amount: 28814,  gst: 5186,  total: 34000,  status: 'Sent to Tally', sales_person: 'Rajesh Kumar' },
    { id: 8,  invoice_no: 'INV-2024-0149', date: '17/05/2024', customer: 'Krishna Traders',      location: 'Surat',     amount: 5085,   gst: 915,   total: 6000,   status: 'Created',       sales_person: 'Amit Shah'    },
    { id: 9,  invoice_no: 'INV-2024-0148', date: '16/05/2024', customer: 'Shiv Shakti Traders',  location: 'Surat',     amount: 42373,  gst: 7627,  total: 50000,  status: 'Created',       sales_person: 'Amit Shah'    },
    { id: 10, invoice_no: 'INV-2024-0147', date: '16/05/2024', customer: 'Maa Durga Stores',     location: 'Mumbai',    amount: 9322,   gst: 1678,  total: 11000,  status: 'Sent to Tally', sales_person: 'Neha Patel'   },
];
const salesInvoicesTotal = 248;
const nextInvoiceNo = 'INV-2024-0157';

// Customer names for the invoice "Customer" picker.
const customerNames = customers.map(function (c) { return c.name; });

// Trimmed product catalogue for the line-item picker. `gst` is numeric
// (percent) and `rate` is the per-unit sales price — both consumed by
// /js/invoice.js to auto-fill a row + compute taxable/GST/amount.
const invoiceProducts = productsList.map(function (p) {
    return {
        name: p.name,
        hsn:  p.hsn,
        unit: p.unit,
        rate: p.sales_price,
        gst:  parseInt(p.gst_rate, 10) || 0,
    };
});

/* ── Purchase Invoices (TRANSACTIONS → Purchase Invoices) ───────
 * The buy side. `amount`=taxable, `gst`=tax, `total`=grand total.
 * Same Tally-sync status workflow as sales invoices.
 * ─────────────────────────────────────────────────────────── */

const purchaseInvoicesList = [
    { id: 1,  bill_no: 'PUR-2024-0088', date: '19/05/2024', supplier: 'Steelco Industries', location: 'Ahmedabad', amount: 76271,  gst: 13729, total: 90000,  status: 'Created'       },
    { id: 2,  bill_no: 'PUR-2024-0087', date: '18/05/2024', supplier: 'PackWell Pvt Ltd',   location: 'Surat',     amount: 21186,  gst: 3814,  total: 25000,  status: 'Pending Tally' },
    { id: 3,  bill_no: 'PUR-2024-0086', date: '18/05/2024', supplier: 'Gujarat Chemicals',  location: 'Vadodara',  amount: 50847,  gst: 9153,  total: 60000,  status: 'Created'       },
    { id: 4,  bill_no: 'PUR-2024-0085', date: '17/05/2024', supplier: 'Mumbai Logistics',   location: 'Mumbai',    amount: 12712,  gst: 2288,  total: 15000,  status: 'Sent to Tally' },
    { id: 5,  bill_no: 'PUR-2024-0084', date: '17/05/2024', supplier: 'Shakti Traders',     location: 'Surat',     amount: 8475,   gst: 1525,  total: 10000,  status: 'Failed'        },
    { id: 6,  bill_no: 'PUR-2024-0083', date: '16/05/2024', supplier: 'Prime Services',     location: 'Mumbai',    amount: 6780,   gst: 1220,  total: 8000,   status: 'Created'       },
    { id: 7,  bill_no: 'PUR-2024-0082', date: '16/05/2024', supplier: 'National Packaging', location: 'Ahmedabad', amount: 28814,  gst: 5186,  total: 34000,  status: 'Created'       },
    { id: 8,  bill_no: 'PUR-2024-0081', date: '15/05/2024', supplier: 'Royal Transport',    location: 'Rajkot',    amount: 4237,   gst: 763,   total: 5000,   status: 'Pending Tally' },
    { id: 9,  bill_no: 'PUR-2024-0080', date: '15/05/2024', supplier: 'Steelco Industries', location: 'Ahmedabad', amount: 101695, gst: 18305, total: 120000, status: 'Created'       },
    { id: 10, bill_no: 'PUR-2024-0079', date: '14/05/2024', supplier: 'Gujarat Chemicals',  location: 'Vadodara',  amount: 33898,  gst: 6102,  total: 40000,  status: 'Sent to Tally' },
];
const purchaseInvoicesTotal = 187;
const nextBillNo = 'PUR-2024-0089';

// Supplier names for the purchase "Supplier" picker.
const supplierNames = suppliersList.map(function (s) { return s.name; });

// Line-item catalogue priced at PURCHASE price (vs sales for invoices).
const purchaseProducts = productsList.map(function (p) {
    return {
        name: p.name,
        hsn:  p.hsn,
        unit: p.unit,
        rate: p.purchase_price,
        gst:  parseInt(p.gst_rate, 10) || 0,
    };
});

/* ── Payments (TRANSACTIONS → Payments) ─────────────────────────
 * Money paid OUT to suppliers (Tally Payment Voucher). `mode` is how
 * it was paid; `reference` is the cheque/UPI/NEFT ref ('—' for cash).
 * ─────────────────────────────────────────────────────────── */

const paymentModes = ['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT/RTGS'];

const paymentsList = [
    { id: 1,  payment_no: 'PAY-2024-0091', date: '20/05/2024', party: 'Steelco Industries', mode: 'Bank',   reference: 'NEFT-558821', amount: 45000, status: 'Created'       },
    { id: 2,  payment_no: 'PAY-2024-0090', date: '19/05/2024', party: 'PackWell Pvt Ltd',   mode: 'UPI',    reference: 'UPI-99213',   amount: 22000, status: 'Created'       },
    { id: 3,  payment_no: 'PAY-2024-0089', date: '19/05/2024', party: 'Gujarat Chemicals',  mode: 'Cheque', reference: 'CHQ-004521',  amount: 60000, status: 'Pending Tally' },
    { id: 4,  payment_no: 'PAY-2024-0088', date: '18/05/2024', party: 'Mumbai Logistics',   mode: 'Cash',   reference: '—',           amount: 8000,  status: 'Created'       },
    { id: 5,  payment_no: 'PAY-2024-0087', date: '18/05/2024', party: 'Shakti Traders',     mode: 'Bank',   reference: 'NEFT-558790', amount: 12500, status: 'Sent to Tally' },
    { id: 6,  payment_no: 'PAY-2024-0086', date: '17/05/2024', party: 'Prime Services',     mode: 'UPI',    reference: 'UPI-99100',   amount: 5600,  status: 'Created'       },
    { id: 7,  payment_no: 'PAY-2024-0085', date: '17/05/2024', party: 'National Packaging', mode: 'Cheque', reference: 'CHQ-004510',  amount: 33400, status: 'Failed'        },
    { id: 8,  payment_no: 'PAY-2024-0084', date: '16/05/2024', party: 'Royal Transport',    mode: 'Cash',   reference: '—',           amount: 5000,  status: 'Created'       },
    { id: 9,  payment_no: 'PAY-2024-0083', date: '16/05/2024', party: 'Steelco Industries', mode: 'Bank',   reference: 'NEFT-558712', amount: 90000, status: 'Created'       },
    { id: 10, payment_no: 'PAY-2024-0082', date: '15/05/2024', party: 'Gujarat Chemicals',  mode: 'UPI',    reference: 'UPI-98990',   amount: 40000, status: 'Sent to Tally' },
];
const paymentsTotal = 142;
const nextPaymentNo = 'PAY-2024-0092';

/* ── Inventory (TRANSACTIONS → Inventory) ───────────────────────
 * Stock summary synced from Tally. Per row: opening + purchased −
 * sold = current; value = current × purchase price. `status` is
 * derived (Out of Stock = 0, Low Stock < reorder, else In Stock).
 * ─────────────────────────────────────────────────────────── */

const stockStatuses   = ['In Stock', 'Low Stock', 'Out of Stock'];
const adjustmentTypes = ['Add (Stock In)', 'Reduce (Stock Out)'];

const inventoryList = [
    { id: 1,  product: 'TMT Steel Bar 12mm',     sku: 'SKU-STL-012', category: 'Steel & Metal',      unit: 'Kg',    location: 'Ahmedabad', opening: 5000, purchased: 2000, sold: 2800, current: 4200, value: 218400, status: 'In Stock'     },
    { id: 2,  product: 'MS Angle 40mm',          sku: 'SKU-STL-040', category: 'Steel & Metal',      unit: 'Kg',    location: 'Ahmedabad', opening: 2500, purchased: 800,  sold: 1500, current: 1800, value: 86400,  status: 'In Stock'     },
    { id: 3,  product: 'GI Pipe 1 inch',         sku: 'SKU-PIP-001', category: 'Pipes & Fittings',   unit: 'Meter', location: 'Surat',     opening: 1200, purchased: 400,  sold: 650,  current: 950,  value: 114000, status: 'In Stock'     },
    { id: 4,  product: 'PVC Elbow 90°',          sku: 'SKU-PIP-090', category: 'Pipes & Fittings',   unit: 'Nos',   location: 'Surat',     opening: 8000, purchased: 2000, sold: 3600, current: 6400, value: 76800,  status: 'In Stock'     },
    { id: 5,  product: 'Copper Wire 2.5sqmm',    sku: 'SKU-ELC-025', category: 'Electrical',         unit: 'Meter', location: 'Mumbai',    opening: 4000, purchased: 1000, sold: 1800, current: 3200, value: 89600,  status: 'In Stock'     },
    { id: 6,  product: 'LED Bulb 9W',            sku: 'SKU-ELC-009', category: 'Electrical',         unit: 'Nos',   location: 'Mumbai',    opening: 2000, purchased: 500,  sold: 1000, current: 1500, value: 67500,  status: 'In Stock'     },
    { id: 7,  product: 'Cement Bag 50kg',        sku: 'SKU-PKG-050', category: 'Packaging Material', unit: 'Bag',   location: 'Ahmedabad', opening: 600,  purchased: 200,  sold: 320,  current: 480,  value: 153600, status: 'In Stock'     },
    { id: 8,  product: 'Hand Drill Machine',     sku: 'SKU-TLS-001', category: 'Tools',              unit: 'Nos',   location: 'Vadodara',  opening: 100,  purchased: 20,   sold: 120,  current: 0,    value: 0,      status: 'Out of Stock' },
    { id: 9,  product: 'Steel Screw Box',        sku: 'SKU-HRD-100', category: 'Hardware',           unit: 'Box',   location: 'Rajkot',    opening: 1000, purchased: 300,  sold: 380,  current: 920,  value: 78200,  status: 'In Stock'     },
    { id: 10, product: 'Industrial Adhesive 1L', sku: 'SKU-CHM-001', category: 'Chemicals',          unit: 'Litre', location: 'Mumbai',    opening: 500,  purchased: 100,  sold: 520,  current: 80,   value: 11200,  status: 'Low Stock'    },
];
const inventoryTotal = 542;

// Summary stat cards (top of the Inventory page) — kept consistent with
// the dashboard "Stock Value" figure.
const inventoryStats = [
    { label: 'Total Stock Value', value: '₹48,20,000', icon: 'fa-warehouse',          tone: 'indigo' },
    { label: 'Total SKUs',        value: '542',        icon: 'fa-box',                tone: 'blue'   },
    { label: 'Low Stock Items',   value: '8',          icon: 'fa-triangle-exclamation', tone: 'amber' },
    { label: 'Out of Stock',      value: '3',          icon: 'fa-circle-xmark',       tone: 'teal'   },
];

/* ── Receipts (TRANSACTIONS → Receipts) ─────────────────────────
 * Money RECEIVED from customers (Tally Receipt Voucher) — the
 * customer-side mirror of Payments. `mode` is how it was received;
 * `reference` is the cheque/UPI/NEFT ref ('—' for cash).
 * ─────────────────────────────────────────────────────────── */

const receiptsList = [
    { id: 1,  receipt_no: 'RCP-2024-0060', date: '20/05/2024', party: 'Amit Enterprises',     mode: 'Bank',      reference: 'NEFT-771204', amount: 45000, status: 'Created'       },
    { id: 2,  receipt_no: 'RCP-2024-0059', date: '19/05/2024', party: 'Shreeji Traders',      mode: 'UPI',       reference: 'UPI-88431',   amount: 12500, status: 'Created'       },
    { id: 3,  receipt_no: 'RCP-2024-0058', date: '19/05/2024', party: 'Patel & Co.',          mode: 'Cheque',    reference: 'CHQ-118832',  amount: 7600,  status: 'Pending Tally' },
    { id: 4,  receipt_no: 'RCP-2024-0057', date: '18/05/2024', party: 'Bansal Sales',         mode: 'Cash',      reference: '—',           amount: 8900,  status: 'Created'       },
    { id: 5,  receipt_no: 'RCP-2024-0056', date: '18/05/2024', party: 'Balaji Enterprises',   mode: 'NEFT/RTGS', reference: 'RTGS-220198', amount: 134500, status: 'Sent to Tally' },
    { id: 6,  receipt_no: 'RCP-2024-0055', date: '17/05/2024', party: 'National Enterprises', mode: 'UPI',       reference: 'UPI-88320',   amount: 23400, status: 'Created'       },
    { id: 7,  receipt_no: 'RCP-2024-0054', date: '17/05/2024', party: 'Jai Mata Di Stores',   mode: 'Cheque',    reference: 'CHQ-118810',  amount: 34000, status: 'Failed'        },
    { id: 8,  receipt_no: 'RCP-2024-0053', date: '16/05/2024', party: 'Krishna Traders',      mode: 'Cash',      reference: '—',           amount: 6000,  status: 'Created'       },
    { id: 9,  receipt_no: 'RCP-2024-0052', date: '16/05/2024', party: 'Shiv Shakti Traders',  mode: 'Bank',      reference: 'NEFT-771188', amount: 50000, status: 'Created'       },
    { id: 10, receipt_no: 'RCP-2024-0051', date: '15/05/2024', party: 'Maa Durga Stores',     mode: 'UPI',       reference: 'UPI-88102',   amount: 11000, status: 'Sent to Tally' },
];
const receiptsTotal = 168;
const nextReceiptNo = 'RCP-2024-0061';

/* ── Tally Sync (TALLY SYNC → Sync Dashboard + Logs) ────────────
 * Live state of the local Python sync agent ↔ Tally Prime.
 * ─────────────────────────────────────────────────────────── */

const syncSummary = {
    connected:      true,
    agent_version:  'v1.4.2',
    tally_version:  'TallyPrime 4.1',
    company:        'ABC Pvt. Ltd.',
    last_heartbeat: '12 sec ago',
    last_sync:      '2 min ago',
};

// Four headline stat cards (reuse dashboard .stat-card classes).
const syncStats = [
    { label: 'Connection',          value: 'Connected', icon: 'fa-plug-circle-check',  tone: 'green'  },
    { label: 'Last Sync',           value: '2 min ago', icon: 'fa-clock-rotate-left',  tone: 'blue'   },
    { label: 'Total Records Synced', value: '12,458',   icon: 'fa-circle-check',       tone: 'purple' },
    { label: 'Failed Records',      value: '23',        icon: 'fa-triangle-exclamation', tone: 'amber' },
];

// Per-module sync status (drives the module table + Sync buttons).
const syncModules = [
    { module: 'Companies',         total: 8,   synced: 8,   pending: 0, failed: 0, last_sync: '5 min ago' },
    { module: 'Customers',         total: 156, synced: 151, pending: 4, failed: 1, last_sync: '2 min ago' },
    { module: 'Suppliers',         total: 64,  synced: 64,  pending: 0, failed: 0, last_sync: '8 min ago' },
    { module: 'Products',          total: 542, synced: 536, pending: 4, failed: 2, last_sync: '2 min ago' },
    { module: 'Sales Invoices',    total: 248, synced: 240, pending: 6, failed: 2, last_sync: '1 min ago' },
    { module: 'Purchase Invoices', total: 187, synced: 182, pending: 3, failed: 2, last_sync: '4 min ago' },
    { module: 'Payments',          total: 142, synced: 140, pending: 1, failed: 1, last_sync: '6 min ago' },
    { module: 'Receipts',          total: 168, synced: 165, pending: 2, failed: 1, last_sync: '3 min ago' },
    { module: 'Inventory',         total: 542, synced: 530, pending: 8, failed: 4, last_sync: '2 min ago' },
];

const syncModuleNames = syncModules.map(function (m) { return m.module; });
const syncDirections  = ['Push', 'Pull'];
const syncLogStatuses = ['Synced', 'Pending', 'Failed'];

const syncLogsList = [
    { id: 1,  module: 'Customers',         record: 'Amit Enterprises',   direction: 'Push', status: 'Synced',  time: '2 min ago',  message: 'Ledger created' },
    { id: 2,  module: 'Sales Invoices',    record: 'INV-2024-0155',      direction: 'Push', status: 'Pending', time: '5 min ago',  message: 'Queued for Tally' },
    { id: 3,  module: 'Products',          record: 'Steel Rod 12mm',     direction: 'Push', status: 'Synced',  time: '11 min ago', message: 'Stock item updated' },
    { id: 4,  module: 'Sales Invoices',    record: 'INV-2024-0153',      direction: 'Push', status: 'Failed',  time: '18 min ago', message: "Tally: Ledger 'Patel & Co.' not found" },
    { id: 5,  module: 'Customers',         record: 'Maa Durga Stores',   direction: 'Push', status: 'Synced',  time: '26 min ago', message: 'Ledger updated' },
    { id: 6,  module: 'Payments',          record: 'PAY-2024-0091',      direction: 'Push', status: 'Synced',  time: '34 min ago', message: 'Payment voucher created' },
    { id: 7,  module: 'Inventory',         record: 'Hand Drill Machine', direction: 'Pull', status: 'Synced',  time: '40 min ago', message: 'Stock pulled from Tally' },
    { id: 8,  module: 'Purchase Invoices', record: 'PUR-2024-0087',      direction: 'Push', status: 'Pending', time: '45 min ago', message: 'Queued' },
    { id: 9,  module: 'Products',          record: 'LED Bulb 9W',        direction: 'Push', status: 'Failed',  time: '52 min ago', message: 'Tally: Duplicate stock item name' },
    { id: 10, module: 'Receipts',          record: 'RCP-2024-0058',      direction: 'Push', status: 'Synced',  time: '1 hr ago',   message: 'Receipt voucher created' },
    { id: 11, module: 'Sales Invoices',    record: 'INV-2024-0150',      direction: 'Push', status: 'Synced',  time: '1 hr ago',   message: 'Voucher no. 1247 assigned' },
    { id: 12, module: 'Customers',         record: 'Krishna Traders',    direction: 'Push', status: 'Synced',  time: '2 hr ago',   message: 'Ledger created' },
];
const syncLogsTotal = 12458;

/* ── Reports (REPORTS → Reports) ────────────────────────────────
 * Report hub catalogue (grouped cards) + one fully-built sample
 * report (Sales Register).
 * ─────────────────────────────────────────────────────────── */

const reportGroups = [
    { group: 'Sales', reports: [
        { title: 'Sales Register',         desc: 'All sales invoices with tax breakup', icon: 'fa-file-invoice', tone: 'blue',   href: '/reports/sales-register' },
        { title: 'Sales Summary',          desc: 'Period-wise sales totals',            icon: 'fa-chart-line',   tone: 'blue',   href: '#' },
        { title: 'Customer-wise Sales',    desc: 'Sales grouped by customer',           icon: 'fa-user-group',   tone: 'blue',   href: '#' },
        { title: 'Salesperson-wise Sales', desc: 'Performance by sales person',         icon: 'fa-user-tie',     tone: 'blue',   href: '#' },
    ]},
    { group: 'Purchase', reports: [
        { title: 'Purchase Register',      desc: 'All purchase bills with tax',         icon: 'fa-file-import',  tone: 'purple', href: '#' },
        { title: 'Supplier-wise Purchase', desc: 'Purchases grouped by supplier',       icon: 'fa-truck-field',  tone: 'purple', href: '#' },
    ]},
    { group: 'Inventory', reports: [
        { title: 'Stock Summary',          desc: 'Current stock & valuation',           icon: 'fa-warehouse',    tone: 'teal',   href: '#' },
        { title: 'Stock Movement',         desc: 'Inward / outward movement',           icon: 'fa-right-left',   tone: 'teal',   href: '#' },
        { title: 'Low Stock Report',       desc: 'Items below reorder level',           icon: 'fa-triangle-exclamation', tone: 'amber', href: '#' },
        { title: 'Location-wise Stock',    desc: 'Stock split by location',             icon: 'fa-location-dot', tone: 'teal',   href: '#' },
    ]},
    { group: 'Financial', reports: [
        { title: 'Outstanding Receivables', desc: 'Customer dues with aging',           icon: 'fa-hand-holding-dollar', tone: 'green', href: '#' },
        { title: 'Outstanding Payables',    desc: 'Supplier dues with aging',           icon: 'fa-money-bill-transfer', tone: 'green', href: '#' },
        { title: 'Payments & Receipts',     desc: 'Cash / bank movement',               icon: 'fa-money-bill-wave', tone: 'green', href: '#' },
        { title: 'Day Book',                desc: 'All vouchers by date',               icon: 'fa-book',         tone: 'indigo', href: '#' },
    ]},
    { group: 'Tax / GST', reports: [
        { title: 'GST Summary',            desc: 'GSTR-1 / GSTR-3B summary',            icon: 'fa-percent',      tone: 'indigo', href: '#' },
        { title: 'HSN Summary',            desc: 'Tax grouped by HSN code',             icon: 'fa-barcode',      tone: 'indigo', href: '#' },
    ]},
    { group: 'Ledger', reports: [
        { title: 'Customer Ledger',        desc: 'Customer account statement',          icon: 'fa-address-book', tone: 'blue',   href: '#' },
        { title: 'Supplier Ledger',        desc: 'Supplier account statement',          icon: 'fa-address-book', tone: 'purple', href: '#' },
    ]},
];

// Sample report — Sales Register rows (CGST = SGST = GST / 2).
const reportSales = salesInvoicesList.map(function (inv) {
    return {
        date:        inv.date,
        invoice_no:  inv.invoice_no,
        customer:    inv.customer,
        gstin:       (function () {
            var c = customers.find(function (x) { return x.name === inv.customer; });
            return c ? c.gst : '—';
        })(),
        taxable:     inv.amount,
        cgst:        Math.round(inv.gst / 2),
        sgst:        Math.round(inv.gst / 2),
        total:       inv.total,
        status:      inv.status,
    };
});
const reportSalesSummary = [
    { label: 'Total Invoices', value: '248',        icon: 'fa-file-invoice', tone: 'blue'   },
    { label: 'Total Taxable',  value: '₹4,12,560',  icon: 'fa-indian-rupee-sign', tone: 'purple' },
    { label: 'Total GST',      value: '₹74,261',    icon: 'fa-percent',      tone: 'amber'  },
    { label: 'Total Amount',   value: '₹4,86,821',  icon: 'fa-sack-dollar',  tone: 'green'  },
];

/* ── Users (SETTINGS → Users) ───────────────────────────────────
 * The 5 roles from the spec. `last_login` is a relative time string.
 * ─────────────────────────────────────────────────────────── */

const roles = ['Super Admin', 'Company Admin', 'Sales Manager', 'Sales Person', 'Accountant'];

const usersList = [
    { id: 1, name: 'Rajesh Admin',  email: 'rajesh@abc.com',   mobile: '9876540001', role: 'Super Admin',    last_login: '2 min ago',    status: 'Active',   created_at: '01/04/2024' },
    { id: 2, name: 'Priya Shah',    email: 'priya@abc.com',    mobile: '9876540002', role: 'Company Admin',  last_login: '1 hr ago',     status: 'Active',   created_at: '03/04/2024' },
    { id: 3, name: 'Rajesh Kumar',  email: 'rajesh.k@abc.com', mobile: '9876540003', role: 'Sales Manager',  last_login: 'Yesterday',    status: 'Active',   created_at: '05/04/2024' },
    { id: 4, name: 'Amit Shah',     email: 'amit.s@abc.com',   mobile: '9876540004', role: 'Sales Person',   last_login: '3 hr ago',     status: 'Active',   created_at: '08/04/2024' },
    { id: 5, name: 'Neha Patel',    email: 'neha.p@abc.com',   mobile: '9876540005', role: 'Sales Person',   last_login: '5 hr ago',     status: 'Active',   created_at: '10/04/2024' },
    { id: 6, name: 'Suresh Mehta',  email: 'suresh@abc.com',   mobile: '9876540006', role: 'Accountant',     last_login: 'Yesterday',    status: 'Active',   created_at: '12/04/2024' },
    { id: 7, name: 'Kiran Joshi',   email: 'kiran@abc.com',    mobile: '9876540007', role: 'Sales Person',   last_login: '2 weeks ago',  status: 'Inactive', created_at: '15/04/2024' },
    { id: 8, name: 'Anjali Desai',  email: 'anjali@abc.com',   mobile: '9876540008', role: 'Accountant',     last_login: '4 hr ago',     status: 'Active',   created_at: '18/04/2024' },
];
const usersTotal = usersList.length; // 8

// Users per role → shown on the role chips.
const roleUserCounts = roles.reduce(function (acc, r) {
    acc[r] = usersList.filter(function (u) { return u.role === r; }).length;
    return acc;
}, {});

/* ── Roles & Permissions (SETTINGS → Roles & Permissions) ───────
 * RBAC matrix: modules × actions, per role. Permissions are derived
 * from simple per-role rules so the matrix is consistent + realistic.
 * ─────────────────────────────────────────────────────────── */

const rbacModules = [
    'Dashboard', 'Companies', 'Locations', 'Sales Persons', 'Customers', 'Suppliers',
    'Products', 'Categories', 'Sales Invoices', 'Purchase Invoices', 'Payments',
    'Receipts', 'Inventory', 'Tally Sync', 'Reports', 'Users', 'Settings',
];
const rbacActions = ['view', 'create', 'edit', 'delete', 'export'];

function _perm(view, create, edit, del, exp) {
    return { view: view, create: create, edit: edit, delete: del, export: exp };
}
function _buildRolePerms(role) {
    var ALL  = _perm(true, true, true, true, true);
    var NONE = _perm(false, false, false, false, false);
    var RO   = _perm(true, false, false, false, true);   // read + export
    var CRU  = _perm(true, true, true, false, true);     // create/read/update + export
    var CR   = _perm(true, true, false, false, false);   // create + read only
    var map = {};
    rbacModules.forEach(function (m) {
        if (role === 'Super Admin' || role === 'Company Admin') { map[m] = ALL; return; }
        if (role === 'Sales Manager') {
            if (['Customers', 'Sales Invoices', 'Receipts', 'Sales Persons', 'Locations'].indexOf(m) >= 0) map[m] = CRU;
            else if (['Dashboard', 'Products', 'Categories', 'Suppliers', 'Inventory', 'Reports'].indexOf(m) >= 0) map[m] = RO;
            else map[m] = NONE;
            return;
        }
        if (role === 'Sales Person') {
            if (['Customers', 'Sales Invoices'].indexOf(m) >= 0) map[m] = CR;
            else if (['Dashboard', 'Products', 'Inventory'].indexOf(m) >= 0) map[m] = RO;
            else map[m] = NONE;
            return;
        }
        if (role === 'Accountant') {
            if (['Sales Invoices', 'Purchase Invoices', 'Payments', 'Receipts', 'Reports'].indexOf(m) >= 0) map[m] = CRU;
            else if (['Dashboard', 'Customers', 'Suppliers', 'Products', 'Inventory', 'Tally Sync'].indexOf(m) >= 0) map[m] = RO;
            else map[m] = NONE;
            return;
        }
        map[m] = NONE;
    });
    return map;
}
const rbacPermissions = roles.reduce(function (acc, r) {
    acc[r] = _buildRolePerms(r);
    return acc;
}, {});

/* ── Dashboard (PAGE 3) ─────────────────────────────────────── */

// Eight stat cards. `tone` keys map to .stat-card--<tone> in theme.css
// (drives the icon chip colour). `value` is pre-formatted for display.
const dashboardStats = [
    { label: 'Total Companies',    value: '8',          icon: 'fa-building',            tone: 'blue'   },
    { label: 'Total Customers',    value: '156',        icon: 'fa-user-group',          tone: 'purple' },
    { label: 'Total Products',     value: '542',        icon: 'fa-box',                 tone: 'teal'   },
    { label: "Today's Sales",      value: '₹1,24,500',  icon: 'fa-indian-rupee-sign',   tone: 'green'  },
    { label: 'Pending Tally Sync', value: '12',         icon: 'fa-rotate',              tone: 'amber'  },
    { label: 'Stock Value',        value: '₹48,20,000', icon: 'fa-warehouse',           tone: 'indigo' },
    { label: 'Invoice Amount',     value: '₹9,75,000',  icon: 'fa-file-invoice',        tone: 'blue'   },
    { label: 'Payment Received',   value: '₹7,60,000',  icon: 'fa-money-bill-wave',     tone: 'green'  },
];

// Sales Overview — Chart.js line series (monthly). dashboard.js reads
// these via a JSON island so we keep numbers in one place.
const salesChart = {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    data:   [620000, 710000, 680000, 820000, 905000, 880000, 960000, 1024000, 990000, 1120000, 1080000, 1240000],
};

// Tally Sync Status — Chart.js doughnut (Synced / Pending / Failed).
const syncChart = {
    labels: ['Synced', 'Pending', 'Failed'],
    data:   [418, 12, 6],
};

// Recent Invoices card — rendered via the Table component.
// status maps: Created→green, Pending Tally→amber, Failed→red.
const recentInvoices = [
    { invoice: 'INV-2024-0156', customer: 'Amit Enterprises',     amount: 45000, status: 'Created',       date: '20/05/2024' },
    { invoice: 'INV-2024-0155', customer: 'Shreeji Traders',      amount: 12500, status: 'Pending Tally', date: '20/05/2024' },
    { invoice: 'INV-2024-0154', customer: 'Bansal Sales',         amount: 89000, status: 'Created',       date: '19/05/2024' },
    { invoice: 'INV-2024-0153', customer: 'Patel & Co.',          amount: 7600,  status: 'Failed',        date: '19/05/2024' },
    { invoice: 'INV-2024-0152', customer: 'Balaji Enterprises',   amount: 134500, status: 'Created',      date: '18/05/2024' },
    { invoice: 'INV-2024-0151', customer: 'National Enterprises', amount: 23400, status: 'Pending Tally', date: '18/05/2024' },
];

// Recent Sync Activity card — compact list (Module, Record, Status, Time).
const recentSync = [
    { module: 'Customers', record: 'Amit Enterprises',     status: 'Synced',  time: '2 min ago'  },
    { module: 'Invoices',  record: 'INV-2024-0155',        status: 'Pending', time: '5 min ago'  },
    { module: 'Products',  record: 'Steel Rod 12mm',       status: 'Synced',  time: '11 min ago' },
    { module: 'Invoices',  record: 'INV-2024-0153',        status: 'Failed',  time: '18 min ago' },
    { module: 'Customers', record: 'Maa Durga Stores',     status: 'Synced',  time: '26 min ago' },
    { module: 'Payments',  record: 'PAY-2024-0091',        status: 'Synced',  time: '34 min ago' },
];

/* ── Single exported object ─────────────────────────────────── */

module.exports = {
    company,
    companies,
    user,
    notificationCount,
    locations,
    salesPersons,
    customerGroups,
    customers,
    customersTotal,
    page,
    perPage,
    financialYears,
    companiesList,
    companiesTotal,
    states,
    locationsList,
    locationsTotal,
    locationNames,
    salesPersonsList,
    salesPersonsTotal,
    supplierGroups,
    paymentTerms,
    suppliersList,
    suppliersTotal,
    categoriesList,
    categoriesTotal,
    categoryNames,
    units,
    gstRates,
    productsList,
    productsTotal,
    invoiceStatuses,
    salesInvoicesList,
    salesInvoicesTotal,
    nextInvoiceNo,
    customerNames,
    invoiceProducts,
    purchaseInvoicesList,
    purchaseInvoicesTotal,
    nextBillNo,
    supplierNames,
    purchaseProducts,
    paymentModes,
    paymentsList,
    paymentsTotal,
    nextPaymentNo,
    receiptsList,
    receiptsTotal,
    nextReceiptNo,
    stockStatuses,
    adjustmentTypes,
    inventoryList,
    inventoryTotal,
    inventoryStats,
    syncSummary,
    syncStats,
    syncModules,
    syncModuleNames,
    syncDirections,
    syncLogStatuses,
    syncLogsList,
    syncLogsTotal,
    reportGroups,
    reportSales,
    reportSalesSummary,
    roles,
    usersList,
    usersTotal,
    roleUserCounts,
    rbacModules,
    rbacActions,
    rbacPermissions,
    dashboardStats,
    salesChart,
    syncChart,
    recentInvoices,
    recentSync,
};
