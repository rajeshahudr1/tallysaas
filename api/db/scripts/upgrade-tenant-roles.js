'use strict';

/**
 * api/db/scripts/upgrade-tenant-roles.js
 *
 * One-off (and re-runnable) upgrade: give EVERY existing licence its own
 * PostgreSQL LOGIN role, revoke CONNECT on its tenant db from PUBLIC, and grant
 * that role data-only privileges inside it. See Helpers/tenantRoles.js.
 *
 * Licences provisioned from now on get this automatically (db/provision.js
 * step 7); this back-fills the ones created before the change — and, because
 * every run mints a fresh password, doubles as the credential ROTATION tool.
 *
 * Re-run it after any tenant migration that ADDS tables: `GRANT … ON ALL
 * TABLES` only covers tables that existed at grant time. (ALTER DEFAULT
 * PRIVILEGES covers new ones created by the admin role, so this is a belt-and-
 * braces re-assert rather than a strict requirement.)
 *
 * Requires LICENSE_KEY_SECRET in api/.env — the role passwords are stored
 * AES-256-GCM encrypted and can only be read back with it. If you ever change
 * that secret, re-run this script to re-key every licence.
 *
 * Run:
 *   node db/scripts/upgrade-tenant-roles.js              # every licence
 *   node db/scripts/upgrade-tenant-roles.js --license 2  # just one
 *   node db/scripts/upgrade-tenant-roles.js --dry-run    # report, change nothing
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const knexLib = require('knex');

const keyCrypto   = require('../../Helpers/keyCrypto');
const tenantRoles = require('../../Helpers/tenantRoles');
const { withSsl } = require('../../config/pgSsl');
const { ensureTenantRole, MASTER_DB } = require('../provision');

function baseConn(database) {
    return {
        host:     process.env.DB_HOST || '127.0.0.1',
        port:     parseInt(process.env.DB_PORT, 10) || 5432,
        user:     process.env.DB_USERNAME || 'postgres',
        password: String(process.env.DB_PASSWORD || ''),
        database,
        ...withSsl(),
    };
}
const open = (database) => knexLib({ client: 'pg', connection: baseConn(database), pool: { min: 1, max: 2 } });

function parseArgs(argv) {
    const args = { dryRun: false, licenseId: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--license') args.licenseId = parseInt(argv[++i], 10);
    }
    return args;
}

(async () => {
    const args = parseArgs(process.argv.slice(2));

    if (!keyCrypto.isConfigured()) {
        console.error('✗ LICENSE_KEY_SECRET is not set in api/.env.');
        console.error('  Role passwords are stored encrypted with it; without it they could never');
        console.error('  be decrypted and every licence would be locked out of its own database.');
        process.exit(1);
    }

    const master = open(MASTER_DB);
    let ok = 0, failed = 0;
    try {
        // The columns land via `npm run migrate`; state them here too so this
        // script works on a master that has not been migrated yet.
        await master.raw('ALTER TABLE licenses ADD COLUMN IF NOT EXISTS db_role varchar(64)');
        await master.raw('ALTER TABLE licenses ADD COLUMN IF NOT EXISTS db_role_password_enc text');

        // Shut the back door FIRST: without this, every tenant role can open the
        // master db and read all password hashes + every other licence's row.
        if (!args.dryRun) {
            await tenantRoles.lockdownMasterDb(master, MASTER_DB, String(process.env.DB_USERNAME || 'postgres'));
            console.log(`✓ ${MASTER_DB}: CONNECT revoked from PUBLIC\n`);
        }

        const q = master('licenses').select('id', 'holder_name', 'db_role').orderBy('id');
        if (args.licenseId) q.where('id', args.licenseId);
        const licenses = await q;
        console.log(`Found ${licenses.length} licence(s).${args.dryRun ? '  [DRY RUN — nothing will change]' : ''}\n`);

        for (const lic of licenses) {
            const dbName = `tally_lic_${lic.id}`;
            const state  = lic.db_role ? `has role "${lic.db_role}" (password will be ROTATED)` : 'no role yet';
            console.log(`• licence ${lic.id} "${lic.holder_name}" → ${dbName} — ${state}`);
            if (args.dryRun) continue;

            const tenant = open(dbName);
            try {
                await ensureTenantRole(master, lic.id, tenant, (s) => console.log(`    ${s}`));
                ok++;
            } catch (err) {
                failed++;
                console.error(`    ✗ ${dbName}: ${err.message}`);
            } finally {
                await tenant.destroy().catch(() => {});
            }
        }

        // Anything still open to PUBLIC is a database a tenant role could hop
        // into. We report rather than revoke — other apps may share this cluster.
        if (!args.dryRun) {
            const open = await tenantRoles.findPubliclyConnectableDbs(master);
            if (open.length) {
                console.log(`\n⚠  Still connectable by ANY role on this cluster: ${open.join(', ')}`);
                console.log('   A tenant role can open these. If they are yours, run:');
                for (const d of open) console.log(`     REVOKE CONNECT ON DATABASE "${d}" FROM PUBLIC;`);
            }
        }
    } finally {
        await master.destroy();
    }

    if (args.dryRun) { console.log('\nDry run complete — no changes made.'); process.exit(0); }

    console.log(`\nDone: ${ok} secured, ${failed} failed.`);
    if (failed === 0 && ok > 0) {
        console.log('\nNext:');
        console.log('  1. Restart the API so it picks up the new credentials.');
        console.log('  2. Smoke-test a login for each licence.');
        console.log('  3. Then set TENANT_DB_STRICT_ROLES=true in api/.env and restart again —');
        console.log('     that turns off the shared-superuser fallback for good.');
    }
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
