'use strict';

/**
 * api/db/scripts/upgrade-customer-users.js
 *
 * One-off idempotent upgrade: apply the Customer Users schema (customers.user_id
 * + customer_user_categories + customer_user_products) to EVERY existing tenant
 * database (tally_lic_<id>). New tenants get it from tenant-schema.sql at
 * provision time; this script back-fills the ones provisioned before the feature.
 *
 * Run:  node db/scripts/upgrade-customer-users.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const knexLib = require('knex');

const MASTER_DB = String(process.env.MASTER_DB_DATABASE || 'tallysaas_master');

function baseConn(database) {
    return {
        host:     process.env.DB_HOST || '127.0.0.1',
        port:     parseInt(process.env.DB_PORT, 10) || 5432,
        user:     process.env.DB_USERNAME || 'postgres',
        password: String(process.env.DB_PASSWORD || ''),
        database,
    };
}

const SQL = `
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS user_id bigint;

CREATE TABLE IF NOT EXISTS public.customer_user_categories (
    id bigserial PRIMARY KEY,
    company_id bigint NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    customer_id bigint NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    category_id bigint NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
    discount_pct numeric(6,2) NOT NULL DEFAULT 0,
    addition_pct numeric(6,2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT customer_user_categories_unique UNIQUE (company_id, customer_id, category_id)
);

CREATE TABLE IF NOT EXISTS public.customer_user_products (
    id bigserial PRIMARY KEY,
    company_id bigint NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    customer_id bigint NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    category_id bigint NOT NULL,
    product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT customer_user_products_unique UNIQUE (company_id, customer_id, product_id)
);

CREATE INDEX IF NOT EXISTS customer_user_categories_customer_idx ON public.customer_user_categories (company_id, customer_id);
CREATE INDEX IF NOT EXISTS customer_user_products_customer_idx ON public.customer_user_products (company_id, customer_id, category_id);
CREATE INDEX IF NOT EXISTS customers_user_id_idx ON public.customers (user_id);
`;

(async () => {
    const master = knexLib({ client: 'pg', connection: baseConn(MASTER_DB), pool: { min: 1, max: 2 } });
    try {
        const licenses = await master('licenses').select('id');
        console.log(`Found ${licenses.length} license(s).`);
        for (const lic of licenses) {
            const dbName = `tally_lic_${lic.id}`;
            const tenant = knexLib({ client: 'pg', connection: baseConn(dbName), pool: { min: 1, max: 2 } });
            try {
                await tenant.raw(SQL);
                console.log(`✓ ${dbName} upgraded`);
            } catch (err) {
                console.error(`✗ ${dbName}: ${err.message}`);
            } finally {
                await tenant.destroy();
            }
        }
    } finally {
        await master.destroy();
    }
    console.log('Done.');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
