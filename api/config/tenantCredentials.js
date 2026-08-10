'use strict';

/**
 * api/config/tenantCredentials.js
 *
 * The dbName → { user, password } directory that config/tenantDb.js uses to
 * open each tenant pool under that licence's OWN PostgreSQL role rather than
 * the cluster superuser. See Helpers/tenantRoles.js for the why.
 *
 * SYNCHRONOUS BY DESIGN. `getTenantKnex()` has ~20 sync call sites across
 * controllers, middlewares and helpers; making it async would ripple through
 * all of them. Instead the whole directory is loaded ONCE at boot
 * (`await credentials.load()` in index.js) into a plain Map, and `get()` is a
 * sync lookup. Newly provisioned licences call `set()` so they work without a
 * restart.
 *
 * FALLBACK POLICY — the flag that makes this safe to roll out:
 *   • TENANT_DB_STRICT_ROLES unset/false (DEFAULT, and what you want while
 *     testing locally): a licence with no role yet falls back to the admin
 *     credentials exactly as before, with a one-time warning per db. Nothing
 *     breaks; nothing is secured either.
 *   • TENANT_DB_STRICT_ROLES=true (what production should end up with, AFTER
 *     db/scripts/upgrade-tenant-roles.js has run for every licence): a missing
 *     role is a hard error instead of a silent superuser connection. Without
 *     this, forgetting to migrate one licence would quietly leave the original
 *     hole open on it.
 */

const keyCrypto = require('../Helpers/keyCrypto');

// dbName → { user, password }
const creds = new Map();

let _loaded = false;
let _adminMode = null;          // non-null ⇒ a CLI tool asked for admin creds
const _warned = new Set();

function strict() {
    return String(process.env.TENANT_DB_STRICT_ROLES || '').toLowerCase() === 'true';
}

/** The shared admin credentials the app used before per-licence roles existed. */
function adminCredentials() {
    return {
        user    : String(process.env.DB_USERNAME || 'postgres'),
        password: String(process.env.DB_PASSWORD || ''),
    };
}

/**
 * Credentials for a tenant db — the licence's own role when known.
 * Throws in strict mode when the licence has not been migrated yet.
 * @param {string} dbName
 * @returns {{user: string, password: string, dedicated: boolean}}
 */
function get(dbName) {
    // A maintenance CLI that declared itself: admin creds even in strict mode.
    if (_adminMode) return { ...adminCredentials(), dedicated: false };

    const hit = creds.get(dbName);
    if (hit) return { ...hit, dedicated: true };

    if (strict()) {
        throw new Error(
            `No dedicated DB role for "${dbName}" and TENANT_DB_STRICT_ROLES=true. ` +
            `Run: node db/scripts/upgrade-tenant-roles.js`,
        );
    }
    if (!_warned.has(dbName)) {
        _warned.add(dbName);
        console.warn(
            `tenantCredentials: "${dbName}" has NO dedicated role — falling back to the shared ` +
            `admin login (no tenant isolation). Run db/scripts/upgrade-tenant-roles.js.`,
        );
    }
    return { ...adminCredentials(), dedicated: false };
}

/**
 * Remember a licence's role in-process (called by provision.js right after it
 * creates the role, so the new tenant is usable without a restart).
 */
function set(dbName, user, password) {
    if (!dbName || !user || !password) return;
    creds.set(dbName, { user: String(user), password: String(password) });
    _warned.delete(dbName);
}

/** Forget one entry (a dropped licence). */
function forget(dbName) { creds.delete(dbName); }

/**
 * Load every licence's role from master.licenses. Call once at boot, BEFORE
 * the first request can open a tenant pool.
 *
 * Never throws: a master that is briefly unreachable at boot must not take the
 * API down. It logs and leaves the cache empty — in strict mode the tenant
 * routes then fail closed (401/500) rather than falling back to superuser.
 *
 * @returns {Promise<number>} how many licences have a usable dedicated role
 */
async function load() {
    let rows = [];
    try {
        const { db: master } = require('./masterDb');
        rows = await master('licenses').select('id', 'db_role', 'db_role_password_enc');
    } catch (err) {
        console.error('tenantCredentials.load: could not read master.licenses —', err.message);
        return 0;
    }

    let ok = 0, undecryptable = 0;
    for (const r of rows) {
        if (!r.db_role || !r.db_role_password_enc) continue;
        const pw = keyCrypto.decryptKey(r.db_role_password_enc);
        if (!pw) { undecryptable++; continue; }        // wrong/missing LICENSE_KEY_SECRET
        creds.set(`tally_lic_${r.id}`, { user: r.db_role, password: pw });
        ok++;
    }
    _loaded = true;
    if (undecryptable) {
        console.error(
            `tenantCredentials: ${undecryptable} licence(s) have a role password that will not ` +
            `decrypt — is LICENSE_KEY_SECRET the same value the roles were created with?`,
        );
    }
    return ok;
}

/**
 * Declare this process a MAINTENANCE TOOL: tenant pools open with the admin
 * login, on purpose, even under TENANT_DB_STRICT_ROLES.
 *
 * Call it at the top of any CLI in db/scripts/ that touches a tenant pool.
 * Those tools legitimately need admin rights (they create tables, backfill,
 * re-grant) — the restricted runtime role cannot do their job. Without this
 * they would either silently fall back (looks fine, isn't declared) or, in
 * strict mode, fail with a confusing "no dedicated DB role" error.
 *
 * NEVER call it from index.js or anything serving requests.
 *
 * @param {string} reason  short note, printed so the choice is visible in logs
 */
function useAdminCredentials(reason) {
    _adminMode = String(reason || 'maintenance tool');
    console.log(`tenantCredentials: using the ADMIN login for tenant pools (${_adminMode}).`);
}

/** Ops/health: how many licences are on a dedicated role, and the mode. */
function stats() {
    return { loaded: _loaded, dedicated: creds.size, strict: strict(), adminMode: _adminMode };
}

module.exports = { load, get, set, forget, stats, adminCredentials, useAdminCredentials };
