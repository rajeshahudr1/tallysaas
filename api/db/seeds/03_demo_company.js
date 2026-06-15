'use strict';

/**
 * db/seeds/03_demo_company.js
 *
 * Seeds a small set of demo records for the 'abc' company so list endpoints
 * return data out of the box:
 *
 *   customer_groups: Retail, Wholesale, Distributor
 *   categories:      Electronics, Stationery, Hardware
 *   products:        a few items tied to those categories
 *   customers:       a few customers tied to the groups
 *
 * Everything is scoped to company 'abc' (resolved by slug). Idempotent —
 * each row is matched by (company_id, name) and inserted only if absent, so
 * re-running never duplicates and never clobbers edited demo data.
 *
 * Depends on 02_super_admin.js having created the 'abc' company.
 */

exports.seed = async function (knex) {

    // Resolve the demo company.
    const company = await knex('companies').where('slug', 'abc').first();
    if (!company) {
        throw new Error("Seed 03 requires the 'abc' company from seed 02 — run seeds in order.");
    }
    const companyId = company.id;

    /**
     * Insert a row if no active row with the same name exists for this company;
     * return the id either way. Generic helper for the simple lookup tables.
     */
    async function ensure(table, name, extra = {}) {
        const found = await knex(table)
            .where({ company_id: companyId, name })
            .whereNull('deleted_at')
            .first();
        if (found) return found.id;
        const [row] = await knex(table)
            .insert({ company_id: companyId, name, ...extra })
            .returning('id');
        return row.id;
    }

    // 1) CUSTOMER GROUPS
    const groupRetail      = await ensure('customer_groups', 'Retail');
    const groupWholesale   = await ensure('customer_groups', 'Wholesale');
    const groupDistributor = await ensure('customer_groups', 'Distributor');
    console.log(`✓ customer_groups: Retail=${groupRetail}, Wholesale=${groupWholesale}, Distributor=${groupDistributor}`);

    // 2) CATEGORIES
    const catElectronics = await ensure('categories', 'Electronics', { status: 'Active' });
    const catStationery  = await ensure('categories', 'Stationery',  { status: 'Active' });
    const catHardware    = await ensure('categories', 'Hardware',    { status: 'Active' });
    console.log(`✓ categories: Electronics=${catElectronics}, Stationery=${catStationery}, Hardware=${catHardware}`);

    // 3) PRODUCTS
    const products = [
        { name: 'LED Bulb 9W',        category_id: catElectronics, sku: 'ELE-LED-9W',  unit: 'PCS', hsn_code: '8539', gst_rate: 12, purchase_price: 45,  sales_price: 70,  opening_stock: 200 },
        { name: 'USB Cable Type-C',   category_id: catElectronics, sku: 'ELE-USB-C',   unit: 'PCS', hsn_code: '8544', gst_rate: 18, purchase_price: 30,  sales_price: 99,  opening_stock: 500 },
        { name: 'A4 Paper Ream',      category_id: catStationery,  sku: 'STA-A4-500',  unit: 'REM', hsn_code: '4802', gst_rate: 12, purchase_price: 220, sales_price: 300, opening_stock: 150 },
        { name: 'Ball Pen Blue',      category_id: catStationery,  sku: 'STA-PEN-BLU', unit: 'PCS', hsn_code: '9608', gst_rate: 18, purchase_price: 4,   sales_price: 10,  opening_stock: 1000 },
        { name: 'Steel Screw 1in',    category_id: catHardware,    sku: 'HDW-SCR-1IN', unit: 'BOX', hsn_code: '7318', gst_rate: 18, purchase_price: 80,  sales_price: 130, opening_stock: 80 },
    ];
    let prodCount = 0;
    for (const p of products) {
        const exists = await knex('products')
            .where({ company_id: companyId, name: p.name })
            .whereNull('deleted_at')
            .first();
        if (exists) continue;
        await knex('products').insert({ company_id: companyId, status: 'Active', is_tally_item: true, ...p });
        prodCount++;
    }
    console.log(`✓ products: ${prodCount} inserted (of ${products.length})`);

    // 4) CUSTOMERS
    const customers = [
        { name: 'Sharma Electronics',  mobile: '9876500011', email: 'sharma@demo.test',  gst_number: '24ABCDE1234F1Z5', customer_group_id: groupRetail,      opening_balance: 0,     credit_limit: 50000  },
        { name: 'Patel Traders',       mobile: '9876500012', email: 'patel@demo.test',   gst_number: '24PQRSX5678G2Z9', customer_group_id: groupWholesale,   opening_balance: 12500, credit_limit: 200000 },
        { name: 'Mehta Distributors',  mobile: '9876500013', email: 'mehta@demo.test',   gst_number: '24LMNOP9012H3Z1', customer_group_id: groupDistributor, opening_balance: 0,     credit_limit: 500000 },
        { name: 'Verma Stationers',    mobile: '9876500014', email: 'verma@demo.test',   gst_number: '',                customer_group_id: groupRetail,      opening_balance: 3200,  credit_limit: 30000  },
    ];
    let custCount = 0;
    for (const c of customers) {
        const exists = await knex('customers')
            .where({ company_id: companyId, name: c.name })
            .whereNull('deleted_at')
            .first();
        if (exists) continue;
        await knex('customers').insert({ company_id: companyId, status: 'Active', is_tally_ledger: true, ...c });
        custCount++;
    }
    console.log(`✓ customers: ${custCount} inserted (of ${customers.length})`);
};
