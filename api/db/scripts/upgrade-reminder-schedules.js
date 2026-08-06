'use strict';

/**
 * api/db/scripts/upgrade-reminder-schedules.js
 *
 * One-off idempotent upgrade: add customer_reminder_schedules (the per-party
 * "Set Reminder" schedule) to EVERY existing tenant database (tally_lic_<id>).
 * New tenants get it from tenant-schema.sql at provision time; this script
 * back-fills the ones provisioned before the feature.
 *
 * Safe to re-run — every statement is IF NOT EXISTS.
 *
 * Run:  node db/scripts/upgrade-reminder-schedules.js
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
CREATE TABLE IF NOT EXISTS public.customer_reminder_schedules (
    id bigserial PRIMARY KEY,
    company_id bigint NOT NULL,
    customer_id bigint NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    channel varchar(16) NOT NULL DEFAULT 'whatsapp',
    frequency varchar(16) NOT NULL DEFAULT 'daily',
    send_hour integer NOT NULL DEFAULT 10,
    weekday integer NOT NULL DEFAULT 1,
    day_of_month integer NOT NULL DEFAULT 1,
    created_by bigint,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_reminder_schedules_customer_uniq
    ON public.customer_reminder_schedules (company_id, customer_id);
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
