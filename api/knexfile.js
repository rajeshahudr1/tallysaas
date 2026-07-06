'use strict';

/**
 * api/knexfile.js
 *
 * Knex config for the MASTER control-plane database (tallysaas_master). Since
 * the per-license DB split, TallySaaS is master + per-license `tally_lic_<id>`
 * dbs. This connection = the master (DB_DATABASE=tallysaas_master), so:
 *   `knex migrate:latest` + `knex seed:run`  → build the MASTER (11 tables +
 *   super-admin). db/migrations holds ONE master migration; the 68 old single-DB
 *   migrations are archived under db/migrations_legacy_presplit/.
 * TENANT dbs are NOT migrated with knex — db/provision.js creates each licence's
 * db from db/tenant-schema.sql when a licence is provisioned (web "Create
 * Licence" or `node db/provision.js license --holder .. --email ..`).
 *
 * Connection values come from `.env`. The pool's `afterCreate` pins every new
 * connection to IST so TIMESTAMPTZ reads/writes report in local Indian time.
 *
 * - master migration lives in ./db/migrations   (table: knex_migrations)
 * - master seed      lives in ./db/seeds
 *
 * Two named environments are exported:
 *   development — local defaults, modest pool.
 *   production  — relaxed SSL (managed-PG friendly) + larger pool.
 *
 * The active environment is chosen by `APP_ENV` (see config/db.js).
 */

require('dotenv').config();

// Single DB connection — shared by the whole process. Every value is
// coerced to its expected type so a stray quoted env var can't surprise pg.
const connection = {
    host    : String(process.env.DB_HOST     || '127.0.0.1'),
    port    : parseInt(process.env.DB_PORT, 10) || 5432,
    database: String(process.env.DB_DATABASE || 'tallysaas'),
    user    : String(process.env.DB_USERNAME || 'postgres'),
    password: String(process.env.DB_PASSWORD || ''),
};

const base = {
    client    : 'pg',
    connection,
    migrations: {
        directory: __dirname + '/db/migrations',
        tableName: 'knex_migrations',
    },
    seeds: {
        directory: __dirname + '/db/seeds',
    },
    pool: {
        min: 2,
        max: 10,
        // Pin every new connection to Indian Standard Time (IST) so now() +
        // every TIMESTAMPTZ read / date function reports in local Indian time.
        afterCreate: (conn, done) => {
            conn.query("SET timezone = 'Asia/Kolkata';", (err) => done(err, conn));
        },
    },
};

module.exports = {
    development: base,

    production: {
        ...base,
        // Managed Postgres (RDS / Render / Railway / etc.) commonly presents
        // a cert chain Node doesn't trust by default; rejectUnauthorized:false
        // keeps TLS on the wire without failing on chain validation.
        connection: { ...connection, ssl: { rejectUnauthorized: false } },
        pool      : { ...base.pool, min: 2, max: 20 },
    },
};
