'use strict';

/**
 * Unit tests for the per-licence DB role layer — the SQL it emits and the
 * credential fall-back policy. No database is touched: `ensureRole` /
 * `grantDataPrivileges` take any object with a `query`/`raw` method, so we hand
 * them a recorder and assert on the statements.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const roles = require('../Helpers/tenantRoles');

function recorder() {
    const sql = [];
    return { sql, query: async (s) => sql.push(s), all: () => sql.join('\n') };
}

test('roleNameForLicense is a safe identifier derived from the numeric id', () => {
    assert.equal(roles.roleNameForLicense(7), 'tally_lic_7_app');
    // A non-numeric id cannot smuggle SQL through — Number() makes it NaN, which
    // then fails the identifier check downstream rather than being interpolated.
    assert.equal(roles.roleNameForLicense('1; DROP DATABASE x'), 'tally_lic_NaN_app');
    assert.ok(!roles.IDENT_RE.test('tally lic'));
});

test('generatePassword returns 40 unguessable alphanumeric chars, never repeating', () => {
    const a = roles.generatePassword();
    const b = roles.generatePassword();
    assert.equal(a.length, 40);
    assert.match(a, /^[A-Za-z0-9]{40}$/);
    assert.notEqual(a, b);
});

test('ensureRole revokes CONNECT from PUBLIC — the actual isolation barrier', async () => {
    const rec = recorder();
    await roles.ensureRole(rec, 'tally_lic_3', 'tally_lic_3_app', roles.generatePassword());
    const sql = rec.all();

    assert.match(sql, /REVOKE CONNECT ON DATABASE "tally_lic_3" FROM PUBLIC/);
    assert.match(sql, /GRANT\s+CONNECT ON DATABASE "tally_lic_3" TO "tally_lic_3_app"/);
    // The role must never be able to escalate out of its own database.
    assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    // CREATE ROLE has no IF NOT EXISTS, so re-running must not blow up.
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'tally_lic_3_app'\)/);
});

test('ensureRole refuses unsafe identifiers and weak passwords', async () => {
    const pw = roles.generatePassword();
    await assert.rejects(
        () => roles.ensureRole(recorder(), 'tally_lic_1"; DROP DATABASE x --', 'r_app', pw),
        /refusing unsafe db name/,
    );
    await assert.rejects(
        () => roles.ensureRole(recorder(), 'tally_lic_1', 'r; DROP ROLE postgres', pw),
        /refusing unsafe role name/,
    );
    await assert.rejects(
        () => roles.ensureRole(recorder(), 'tally_lic_1', 'r_app', 'short'),
        /weak\/empty tenant role password/,
    );
});

test('grantDataPrivileges gives rows but no DDL', async () => {
    const rec = recorder();
    rec.raw = rec.query;                       // pretend to be a Knex instance
    await roles.grantDataPrivileges(rec, 'tally_lic_3_app');
    const sql = rec.all();

    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
    // setval() on the users sequence (Helpers/tenantUsers.js) needs UPDATE.
    assert.match(sql, /GRANT USAGE, SELECT, UPDATE\s+ON ALL SEQUENCES/);
    // Tables added by later migrations must be covered automatically.
    assert.match(sql, /ALTER DEFAULT PRIVILEGES IN SCHEMA public/);
    // No CREATE on the schema — a compromised tenant cannot plant objects.
    assert.ok(!/GRANT[^;]*CREATE[^;]*ON SCHEMA/i.test(sql), 'must not grant CREATE on schema public');
    assert.match(sql, /REVOKE ALL ON SCHEMA public FROM PUBLIC/);
});

test('credentials: falls back with a warning by default, fails closed when strict', async () => {
    const credentials = require('../config/tenantCredentials');
    const prev = process.env.TENANT_DB_STRICT_ROLES;
    process.env.DB_USERNAME = 'postgres';
    process.env.DB_PASSWORD = 'admin-pw';
    try {
        process.env.TENANT_DB_STRICT_ROLES = 'false';
        const fb = credentials.get('tally_lic_999');
        assert.equal(fb.dedicated, false);
        assert.equal(fb.user, 'postgres');

        process.env.TENANT_DB_STRICT_ROLES = 'true';
        assert.throws(() => credentials.get('tally_lic_999'), /No dedicated DB role/);

        // A known licence is served its own role in either mode.
        credentials.set('tally_lic_999', 'tally_lic_999_app', 'x'.repeat(40));
        const own = credentials.get('tally_lic_999');
        assert.equal(own.dedicated, true);
        assert.equal(own.user, 'tally_lic_999_app');

        credentials.forget('tally_lic_999');
        assert.throws(() => credentials.get('tally_lic_999'), /No dedicated DB role/);
    } finally {
        if (prev === undefined) delete process.env.TENANT_DB_STRICT_ROLES;
        else process.env.TENANT_DB_STRICT_ROLES = prev;
    }
});
