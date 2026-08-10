'use strict';

/**
 * api/config/masterDb.js
 *
 * The MASTER database connection (control plane) for the per-license multi-DB
 * model. Master holds: licenses, users (auth), the permission catalogue,
 * license_permissions (entitlements), subscriptions, sessions, platform
 * settings + the license→db_name directory. Tenant business data lives in each
 * license's own `tally_lic_<id>` db (see config/tenantDb.js).
 *
 * NOTE (during the migration): until the flip, the running app still uses
 * config/db.js (single DB). This module is wired in Phase 2 as auth/super-admin
 * controllers move off the global db onto masterDb. It reads MASTER_DB_DATABASE
 * (default 'tallysaas_master') so it can point at the provisioned master
 * without disturbing config/db.js.
 */

const knex = require('knex');

const { withSsl } = require('./pgSsl');

const db = knex({
    client: 'pg',
    connection: {
        host    : String(process.env.DB_HOST     || '127.0.0.1'),
        port    : parseInt(process.env.DB_PORT, 10) || 5432,
        database: String(process.env.MASTER_DB_DATABASE || 'tallysaas_master'),
        user    : String(process.env.DB_USERNAME || 'postgres'),
        password: String(process.env.DB_PASSWORD || ''),
        ...withSsl(),
    },
    pool: {
        min: 2,
        max: 10,
        afterCreate: (conn, done) => {
            conn.query("SET timezone = 'Asia/Kolkata';", (err) => done(err, conn));
        },
    },
});

async function ping() { await db.raw('SELECT 1'); }

module.exports = { db, ping };
