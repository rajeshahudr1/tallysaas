'use strict';

/**
 * api/db/scripts/upgrade-website-users.js
 *
 * One-off idempotent upgrade: apply the Website Users schema (customers
 * is_website_user/api_token/cash_extra_pct/online_extra_pct +
 * invoices.payment_mode) to EVERY existing tenant database. New tenants get it
 * from tenant-schema.sql at provision time.
 *
 * Run:  node db/scripts/upgrade-website-users.js
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
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS is_website_user boolean NOT NULL DEFAULT false;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS api_token character varying(80);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS cash_extra_pct numeric(6,2) NOT NULL DEFAULT 0;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS online_extra_pct numeric(6,2) NOT NULL DEFAULT 0;
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS payment_mode character varying(20);
CREATE UNIQUE INDEX IF NOT EXISTS customers_api_token_uq ON public.customers (api_token) WHERE api_token IS NOT NULL;
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
