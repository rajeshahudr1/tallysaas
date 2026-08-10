'use strict';

/**
 * api/Helpers/tenantRoles.js
 *
 * Per-licence PostgreSQL LOGIN roles — the real tenant isolation boundary.
 *
 * WHY. Before this, every tenant pool connected as the cluster SUPERUSER
 * (DB_USERNAME/DB_PASSWORD, usually `postgres`). That means one SQL-injection
 * or one buggy raw query inside licence 1's request could read licence 2's
 * whole database (`dblink`, `COPY … PROGRAM`, `pg_read_file`, …) — the
 * per-database split bought us nothing, because the same key opened every door.
 * Renaming the databases would not have helped: `SELECT datname FROM
 * pg_database` lists them all in one line.
 *
 * WHAT. Each licence gets `tally_lic_<id>_app`: a NOSUPERUSER LOGIN role that
 * can CONNECT to exactly one database and, inside it, only read/write rows —
 * no DDL, no new objects. CONNECT is revoked from PUBLIC on the tenant db, so
 * a leaked tenant credential is a `permission denied for database` on every
 * OTHER tenant.
 *
 * Migrations keep running as the admin/owner role (see db/migrate-tenants.js) —
 * the runtime role must never be able to DROP or ALTER a table.
 *
 * The generated password is stored ONLY as an AES-256-GCM blob in
 * master.licenses.db_role_password_enc (Helpers/keyCrypto, LICENSE_KEY_SECRET).
 * No human ever sees or types it. NEVER log it.
 *
 * Identifier safety: role/db names are interpolated into DDL (Postgres cannot
 * parameterise identifiers), so both are checked against IDENT_RE first and the
 * password is escaped as a single-quoted literal.
 */

const crypto = require('node:crypto');

// Same shape as tenantDb.DB_NAME_RE — a plain unquoted-safe SQL identifier.
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

// Alphanumeric only: 62^40 ≈ 2^238 of entropy, and nothing that could ever
// need escaping inside a SQL literal or a connection string.
const PW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PW_LEN      = 40;

/** The runtime LOGIN role for a licence id, e.g. 7 → "tally_lic_7_app". */
function roleNameForLicense(licenseId) {
    return `tally_lic_${Number(licenseId)}_app`;
}

/** A fresh 40-char alphanumeric password (CSPRNG, unbiased). */
function generatePassword() {
    const bytes = crypto.randomBytes(PW_LEN * 2);
    let out = '';
    for (let i = 0; out.length < PW_LEN; i++) {
        // Reject bytes in the biased tail rather than modulo-folding them.
        const b = bytes[i % bytes.length];
        if (b >= 248) continue;                     // 248 = 4 × 62
        out += PW_ALPHABET[b % PW_ALPHABET.length];
    }
    return out;
}

function assertIdent(name, what) {
    if (!IDENT_RE.test(String(name || ''))) {
        throw new Error(`refusing unsafe ${what} "${name}"`);
    }
}

/** Escape a password for use as a single-quoted SQL literal. */
function sqlLiteral(s) { return `'${String(s).replace(/'/g, "''")}'`; }

/**
 * Create-or-update the licence's LOGIN role and lock the tenant database down
 * to it. Runs on an ADMIN connection (pg Client or Knex) pointed at any db —
 * roles and database-level GRANTs are cluster-wide.
 *
 * Idempotent: safe to re-run; an existing role just has its password rotated
 * to the value passed in.
 *
 * @param {{query: Function}|import('knex').Knex} admin  pg Client or Knex
 * @param {string} dbName    e.g. "tally_lic_1"
 * @param {string} roleName  e.g. "tally_lic_1_app"
 * @param {string} password  plaintext — never logged, never persisted in clear
 */
async function ensureRole(admin, dbName, roleName, password) {
    assertIdent(dbName, 'db name');
    assertIdent(roleName, 'role name');
    if (!password || String(password).length < 24) {
        throw new Error('ensureRole: refusing a weak/empty tenant role password.');
    }
    const run = (sql) => (typeof admin.raw === 'function' ? admin.raw(sql) : admin.query(sql));

    // CREATE ROLE has no IF NOT EXISTS — guard it, then ALTER unconditionally so
    // the attribute set and password are re-asserted on every run.
    await run(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
                CREATE ROLE "${roleName}" LOGIN;
            END IF;
        END
        $$;
    `);
    await run(`
        ALTER ROLE "${roleName}" WITH LOGIN PASSWORD ${sqlLiteral(password)}
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    `);

    // The isolation barrier: nobody may CONNECT to this db except its own role
    // (and superusers, who bypass all GRANTs by definition).
    await run(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC;`);
    await run(`GRANT  CONNECT ON DATABASE "${dbName}" TO "${roleName}";`);
}

/**
 * Grant the runtime role its (data-only) privileges INSIDE the tenant db.
 * Must run on a connection to `dbName` itself, as the object OWNER — which is
 * the admin role that created the tables, so the bare ALTER DEFAULT PRIVILEGES
 * below correctly targets future tables created by migrations.
 *
 * Deliberately NOT granted: CREATE on the schema, TRUNCATE, or any DDL. A
 * compromised runtime role can corrupt rows (recoverable from backup) but
 * cannot drop a table or plant a function.
 *
 * Call this AFTER the schema + migrations have run, and again after any
 * migration that adds tables (upgrade-tenant-roles.js re-runs it).
 *
 * @param {import('knex').Knex} tenantKnex  connected to dbName as the owner
 * @param {string} roleName
 */
async function grantDataPrivileges(tenantKnex, roleName) {
    assertIdent(roleName, 'role name');
    await tenantKnex.raw(`
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT  USAGE ON SCHEMA public TO "${roleName}";

        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO "${roleName}";
        GRANT USAGE, SELECT, UPDATE         ON ALL SEQUENCES IN SCHEMA public TO "${roleName}";

        ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${roleName}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${roleName}";
    `);
}

/**
 * Close the MASTER database to everyone but the admin login.
 *
 * Revoking CONNECT on each tenant db is only half the fence. A brand-new
 * Postgres database grants CONNECT to PUBLIC, so until this runs, every
 * `tally_lic_<id>_app` role can open `tallysaas_master` and read the entire
 * control plane: all users' password hashes, licence rows, sessions — and the
 * db_role_password_enc column, i.e. every OTHER tenant's credential blob. (The
 * blobs need LICENSE_KEY_SECRET to decrypt, but the password hashes need
 * nothing.) That single hop undoes the per-tenant isolation completely.
 *
 * Superusers bypass GRANTs, so the app keeps working when DB_USERNAME is
 * `postgres`; CONNECT is granted to it explicitly anyway so a future
 * non-superuser admin role also works.
 *
 * @param {{query: Function}} admin  pg Client on any database
 * @param {string} masterDb          e.g. "tallysaas_master"
 * @param {string} adminRole         the DB_USERNAME the app/migrations use
 */
async function lockdownMasterDb(admin, masterDb, adminRole) {
    assertIdent(masterDb, 'master db name');
    assertIdent(adminRole, 'admin role name');
    const run = (sql) => (typeof admin.raw === 'function' ? admin.raw(sql) : admin.query(sql));
    await run(`REVOKE CONNECT ON DATABASE "${masterDb}" FROM PUBLIC;`);
    await run(`GRANT  CONNECT ON DATABASE "${masterDb}" TO "${adminRole}";`);
}

/**
 * Report any OTHER database on this cluster that a tenant role could still
 * open, i.e. one that has not had CONNECT revoked from PUBLIC.
 *
 * We only WARN. Those databases usually belong to unrelated applications
 * sharing the server, and silently revoking CONNECT on them could break
 * something we know nothing about — that call belongs to the operator.
 *
 * @returns {Promise<string[]>} database names still reachable by PUBLIC
 */
async function findPubliclyConnectableDbs(admin) {
    const run = (sql) => (typeof admin.raw === 'function' ? admin.raw(sql) : admin.query(sql));
    const res = await run(`
        SELECT datname
        FROM pg_database
        WHERE datallowconn
          AND NOT datistemplate
          AND datname <> 'postgres'
          AND has_database_privilege('public', datname, 'CONNECT')
        ORDER BY datname;
    `);
    const rows = res.rows || res[0] || [];
    return rows.map((r) => r.datname);
}

/**
 * Drop a licence's role (used when a tenant db is dropped). Privileges the role
 * still holds must go first or DROP ROLE fails with "role cannot be dropped
 * because some objects depend on it".
 */
async function dropRoleIfExists(admin, dbName, roleName) {
    assertIdent(dbName, 'db name');
    assertIdent(roleName, 'role name');
    const run = (sql) => (typeof admin.raw === 'function' ? admin.raw(sql) : admin.query(sql));
    try {
        await run(`REVOKE ALL ON DATABASE "${dbName}" FROM "${roleName}";`);
    } catch { /* db or role already gone */ }
    try {
        await run(`DROP ROLE IF EXISTS "${roleName}";`);
    } catch (e) {
        console.warn(`tenantRoles: could not drop "${roleName}": ${e.message}`);
    }
}

module.exports = {
    IDENT_RE,
    roleNameForLicense,
    generatePassword,
    ensureRole,
    grantDataPrivileges,
    lockdownMasterDb,
    findPubliclyConnectableDbs,
    dropRoleIfExists,
};
