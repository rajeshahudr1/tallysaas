'use strict';

/**
 * web/lib/menuTree.js
 *
 * Sidebar के menu का एकमात्र source of truth. दो consumers:
 *   • views/partials/sidebar.ejs — नेविगेशन render करता है
 *   • routes/web.js → views/licenses/permissions.ejs — License Modules screen
 *     को sidebar जैसे groups में दिखाता है
 * हर item का `module` वही permission slug है जिससे canModule()/canDo() चलते हैं।
 * `soon: true` = screen अभी बना नहीं — menu में disabled दिखता है, पर module
 * पहले से catalogue में है, इसलिए entitlement अभी से set किया जा सकता है।
 */

const MENU_TREE = [
    { label: null, items: [
        { key: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', href: '/', module: 'dashboard' },
    ]},
    { label: 'Create Vouchers', icon: 'fa-plus', items: [
        { key: 'new-quotation',   label: 'Quotation',        icon: 'fa-file-lines',        href: '/quotations/create', module: 'quotations' },
        { key: 'new-sales-inv',   label: 'Sales Invoice',    icon: 'fa-file-invoice',      href: '/sales-invoices/create',    module: 'sales-invoices' },
        { key: 'new-receipt',     label: 'Receipt',          icon: 'fa-receipt',           href: '/receipts/add',             module: 'receipts' },
        { key: 'new-payment',     label: 'Payment',          icon: 'fa-money-bill-wave',   href: '/payments/add',             module: 'payments' },
        { key: 'new-sales-order', label: 'Sales Order',      icon: 'fa-cart-shopping',     href: '/sales-orders/create', module: 'sales-orders' },
        { key: 'new-purchase',    label: 'Purchase Invoice', icon: 'fa-file-import',       href: '/purchase-invoices/create', module: 'purchase-invoices' },
        { key: 'new-journal',     label: 'Journal',          icon: 'fa-book',              href: '/journals',                 module: 'journals' },
        { key: 'new-contra',      label: 'Contra',           icon: 'fa-right-left',        href: '#', soon: true, module: 'contra' },
        { key: 'new-po',          label: 'Purchase Order',   icon: 'fa-cart-flatbed',      href: '/purchase-orders/create', module: 'purchase-orders' },
        { key: 'new-credit-note', label: 'Credit Note',      icon: 'fa-file-circle-minus', href: '/credit-notes/create', module: 'credit-notes' },
        { key: 'new-debit-note',  label: 'Debit Note',       icon: 'fa-file-circle-plus',  href: '/debit-notes/create', module: 'debit-notes' },
        { key: 'new-stock-jrnl',  label: 'Stock Journal',    icon: 'fa-boxes-packing',     href: '#', soon: true, module: 'stock-journal' },
        { key: 'new-phys-stock',  label: 'Physical Stock',   icon: 'fa-clipboard-list',    href: '#', soon: true, module: 'physical-stock' },
        { key: 'new-recpt-note',  label: 'Receipt Note',     icon: 'fa-dolly',             href: '/receipt-notes/create', module: 'receipt-notes' },
        { key: 'new-dely-note',   label: 'Delivery Note',    icon: 'fa-truck-fast',        href: '/delivery-notes/create', module: 'delivery-notes' },
    ]},
    { label: 'Sales', icon: 'fa-chart-line', items: [
        { key: 'sales-inv',     label: 'Sales',                icon: 'fa-file-invoice',      href: '/sales-invoices',           module: 'sales-invoices' },
        { key: 'credit-notes',  label: 'Credit Note',          icon: 'fa-file-circle-minus', href: '/credit-notes', module: 'credit-notes' },
        { key: 'receipts',      label: 'Receipt',              icon: 'fa-receipt',           href: '/receipts',                 module: 'receipts' },
        { key: 'receivables',   label: 'Receivables',          icon: 'fa-hand-holding-dollar', href: '/receivables',            module: 'receivables' },
        { key: 'sales-orders',  label: 'Sales Order',          icon: 'fa-cart-shopping',     href: '/sales-orders', module: 'sales-orders' },
        { key: 'dely-notes',    label: 'Delivery Note',        icon: 'fa-truck-fast',        href: '/delivery-notes', module: 'delivery-notes' },
        { key: 'approvals',     label: 'Invoice Approvals',    icon: 'fa-clipboard-check',   href: '/sales-invoices/approvals', approve: true, module: 'sales-invoices' },
        { key: 'recurring',     label: 'Recurring Invoices',   icon: 'fa-repeat',            href: '/recurring-invoices',       module: 'recurring-invoices' },
        { key: 'einvoice',      label: 'e-Invoice & e-Way',    icon: 'fa-file-circle-check', href: '/einvoices',                module: 'einvoice' },
        { key: 'einvoice-dash', label: 'e-Invoice Dashboard',  icon: 'fa-gauge-high',        href: '/einvoices/dashboard',      module: 'einvoice' },
        { key: 'reminders',     label: 'Payment Reminders',    icon: 'fa-bell',              href: '/reminders',                module: 'payments' },
    ]},
    { label: 'Purchase', icon: 'fa-cart-flatbed', items: [
        { key: 'purchase-inv', label: 'Purchase',       icon: 'fa-file-import',      href: '/purchase-invoices', module: 'purchase-invoices' },
        { key: 'debit-notes',  label: 'Debit Note',     icon: 'fa-file-circle-plus', href: '/debit-notes', module: 'debit-notes' },
        { key: 'payments',     label: 'Payment',        icon: 'fa-money-bill-wave',  href: '/payments',          module: 'payments' },
        { key: 'payables',     label: 'Payables',       icon: 'fa-hand-holding-dollar', href: '/payables',       module: 'payables' },
        { key: 'purch-orders', label: 'Purchase Order', icon: 'fa-cart-flatbed',     href: '/purchase-orders', module: 'purchase-orders' },
        { key: 'recpt-notes',  label: 'Receipt Note',   icon: 'fa-dolly',            href: '/receipt-notes', module: 'receipt-notes' },
        { key: 'expenses',     label: 'Expenses',       icon: 'fa-wallet',           href: '/expenses',          module: 'expenses' },
    ]},
    { label: 'Cash & Bank', icon: 'fa-sack-dollar', items: [
        { key: 'cash',         label: 'Cash',                icon: 'fa-money-bill-1',     href: '/cash',                module: 'cash-bank' },
        { key: 'bank-ledgers', label: 'Bank',                icon: 'fa-building-columns', href: '/bank',                module: 'cash-bank' },
        { key: 'bank',         label: 'Bank Reconciliation', icon: 'fa-scale-balanced',   href: '/bank-reconciliation', module: 'bank-reconciliation' },
        { key: 'journals',     label: 'Journals',            icon: 'fa-book',             href: '/journals',            module: 'journals' },
    ]},
    { label: null, items: [
        { key: 'collect-payments', label: 'Collect Payments', icon: 'fa-credit-card', href: '#', soon: true, module: 'collect-payments' },
    ]},
    { label: 'Customers', icon: 'fa-address-book', items: [
        { key: 'customers', label: 'Customers', icon: 'fa-user-group',  href: '/customers', module: 'customers' },
        { key: 'suppliers', label: 'Suppliers', icon: 'fa-truck-field', href: '/suppliers', module: 'suppliers' },
    ]},
    { label: 'Items', icon: 'fa-box', items: [
        { key: 'products',   label: 'Products',   icon: 'fa-box',       href: '/products',   module: 'products' },
        { key: 'categories', label: 'Categories', icon: 'fa-tags',      href: '/categories', module: 'categories' },
        { key: 'inventory',  label: 'Inventory',  icon: 'fa-warehouse', href: '/inventory',  module: 'inventory' },
    ]},
    { label: 'Reports', icon: 'fa-chart-simple', items: [
        { key: 'reports',   label: 'Reports',            icon: 'fa-chart-column', href: '/reports',   module: 'reports' },
        { key: 'analytics', label: 'Business Analytics', icon: 'fa-chart-pie',    href: '/analytics', module: 'reports' },
    ]},
    { label: 'My Entries', icon: 'fa-square-check', items: [
        { key: 'my-vouchers',   label: 'My Vouchers',    icon: 'fa-file-lines',        href: '#', soon: true, module: 'field-sales' },
        { key: 'my-quotations', label: 'My Quotations',  icon: 'fa-file-signature',    href: '/quotations?mine=1', module: 'quotations' },
        { key: 'my-eway',       label: 'My eWay Bills',  icon: 'fa-truck-fast',        href: '#', soon: true, module: 'field-sales' },
        { key: 'my-einvoices',  label: 'My eInvoices',   icon: 'fa-file-circle-check', href: '#', soon: true, module: 'field-sales' },
        { key: 'my-parties',    label: 'My Parties',     icon: 'fa-address-book',      href: '#', soon: true, module: 'field-sales' },
        { key: 'my-stock',      label: 'My Stock Items', icon: 'fa-boxes-stacked',     href: '#', soon: true, module: 'field-sales' },
        { key: 'field-tracking', label: 'Tracking Report', icon: 'fa-map-location-dot', href: '/field-tracking', approve: true, module: 'field-sales' },
    ]},
    { label: 'Field Sales', icon: 'fa-location-dot', items: [
        { key: 'my-field',     label: 'My Dashboard',  icon: 'fa-location-dot',        href: '/my-field',     salesmanOnly: true, module: 'field-sales' },
        { key: 'sales',        label: 'Sales Persons', icon: 'fa-user-tie',            href: '/sales-persons', module: 'sales-persons' },
        { key: 'gps-settings', label: 'GPS Tracking',  icon: 'fa-location-crosshairs', href: '/gps-settings',  adminOnly: true, module: 'gps-tracking' },
    ]},
    { label: 'Portals', icon: 'fa-globe', items: [
        { key: 'customer-users', label: 'Customer Users', icon: 'fa-user-lock', href: '/customer-users', module: 'customer-users' },
        { key: 'website-users',  label: 'Website Users',  icon: 'fa-globe',     href: '/website-users',  module: 'website-users' },
    ]},
    { label: 'Tally Sync', icon: 'fa-rotate', items: [
        { key: 'sync-dash', label: 'Sync Dashboard', icon: 'fa-rotate',            href: '/sync-dashboard', adminOnly: true, module: 'tally-sync' },
        { key: 'sync-logs', label: 'Sync Logs',      icon: 'fa-list-check',        href: '/sync-logs',      adminOnly: true, module: 'tally-sync' },
        { key: 'history',   label: 'Change History', icon: 'fa-clock-rotate-left', href: '/history',        adminOnly: true, module: 'tally-sync' },
    ]},
    { label: 'Configurations', icon: 'fa-sliders', items: [
        { key: 'settings',     label: 'Settings',           icon: 'fa-gear',         href: '/settings',           module: 'settings' },
        { key: 'users',        label: 'Users',              icon: 'fa-users',        href: '/users',              module: 'users' },
        { key: 'accountant',   label: 'Accountant Access',  icon: 'fa-user-tie',     href: '/accountant-access',  module: 'accountant' },
        { key: 'companies',    label: 'Companies',          icon: 'fa-building',     href: '/companies',          module: 'companies' },
        { key: 'locations',    label: 'Locations',          icon: 'fa-location-dot', href: '/locations',          module: 'locations' },
        { key: 'einvoice-gsp', label: 'e-Invoice GSP',      icon: 'fa-file-invoice-dollar', href: '/einvoice-gsp', superOnly: true, module: 'einvoice' },
    ]},
    { label: null, items: [
        { key: 'gst-search',  label: 'GST Search',  icon: 'fa-magnifying-glass', href: '#', soon: true, module: 'gst-search' },
        { key: 'data-backup', label: 'Data Backup', icon: 'fa-cloud-arrow-up',   href: '#', soon: true, module: 'data-backup' },
    ]},
];

// MENU_TREE से derive — group order वही, हर module सिर्फ़ पहली बार जहाँ दिखा वहीं।
// MENU_TREE में तीन unlabelled (label: null) groups हैं — वे सब "General" बन जाते
// हैं, इसलिए यहाँ label से merge किया जाता है ताकि एक ही नाम की तीन अलग-अलग
// sections न बनें; order पहली बार दिखने वाले position से तय होता है।
const MODULE_GROUPS = (function build() {
    const seen = new Set();
    const out = [];
    const byLabel = new Map(); // label -> entry in `out`
    for (const g of MENU_TREE) {
        const mods = [];
        for (const it of g.items) {
            if (!it.module || seen.has(it.module)) continue;
            seen.add(it.module);
            mods.push(it.module);
        }
        if (!mods.length) continue;
        const label = g.label || 'General';
        const existing = byLabel.get(label);
        if (existing) {
            existing.modules.push(...mods);
        } else {
            const entry = { label: label, icon: g.icon || 'fa-folder', modules: mods };
            byLabel.set(label, entry);
            out.push(entry);
        }
    }
    return out;
})();

/**
 * API से आई modules list ([{key,label}]) को sidebar के groups में बाँटता है।
 * जो module किसी menu group में नहीं मिलता वो आख़िर में "Other" में जाता है —
 * ताकि entitlement screen से कोई module चुपचाप गायब न हो। खाली groups गिरते हैं।
 */
function groupModules(apiModules) {
    const list = Array.isArray(apiModules) ? apiModules : [];
    const byKey = new Map(list.map((m) => [m.key, m]));
    const used = new Set();
    const out = [];
    for (const g of MODULE_GROUPS) {
        const mods = [];
        for (const key of g.modules) {
            const m = byKey.get(key);
            if (!m || used.has(key)) continue;
            used.add(key);
            mods.push(m);
        }
        if (mods.length) out.push({ label: g.label, icon: g.icon, modules: mods });
    }
    const rest = list.filter((m) => !used.has(m.key));
    if (rest.length) out.push({ label: 'Other', icon: 'fa-cubes', modules: rest });
    return out;
}

module.exports = { MENU_TREE, MODULE_GROUPS, groupModules };
