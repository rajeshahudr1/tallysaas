'use strict';
/* Create (or remove) a DEDICATED browser-test login on licence 2.
 *
 * Uses the product's own createLicensedUser(), which writes master, mirrors the
 * row into the tenant at the SAME id and provisions a seat — the three things a
 * working login needs. Hand-inserting into master alone produces an account
 * that authenticates but fails /me, because /me reads the tenant mirror.
 *
 *   node db/scripts/make-test-login.js            create/refresh
 *   node db/scripts/make-test-login.js --remove   delete from both planes
 */
require('dotenv').config({ quiet: true });
// A maintenance CLI: the tenant pool below opens with the ADMIN login rather
// than the licence's restricted runtime role (see config/tenantCredentials.js).
require('../../config/tenantCredentials').useAdminCredentials('make-test-login');
const masterDb = require('../../config/masterDb').db;
const { getKnexForLicense } = require('../../config/tenantDb');
const { createLicensedUser } = require('../../Helpers/tenantUsers');
const passwords = require('../../Helpers/passwords');

const EMAIL = 'qa.browser@teloora.test';
const PASSWORD = 'Verify@12345';
const LICENSE_ID = 2;

(async () => {
    const tenant = getKnexForLicense(LICENSE_ID);

    // Always start clean so a re-run cannot leave half a user behind.
    const old = await masterDb('users').where('email', EMAIL).first('id');
    if (old) {
        await tenant('users').where('id', old.id).del().catch(() => {});
        await masterDb('subscriptions').where('user_id', old.id).del().catch(() => {});
        await masterDb('users').where('id', old.id).del();
        console.log('removed the previous test user (id ' + old.id + ')');
    }
    if (process.argv.includes('--remove')) { process.exit(0); }

    // Model the real company-admin on this licence so the test account has
    // exactly the same access — no more.
    const model = await masterDb('users')
        .where({ license_id: LICENSE_ID, role_slug: 'company-admin' })
        .first('company_id', 'role_id', 'license_id', 'role_slug', 'current_company_id');
    if (!model) { console.log('no company-admin on this licence to model'); process.exit(1); }

    const created = await createLicensedUser({
        name: 'QA Browser',
        email: EMAIL,
        password_hash: await passwords.hash(PASSWORD),
        status: 'Active',
        approval_status: 'approved',
        company_id: model.company_id,
        role_id: model.role_id,
        license_id: LICENSE_ID,
        current_company_id: model.current_company_id,
    }, model.role_slug);

    const inTenant = await tenant('users').where('id', created.id).first('id');
    const seat = await masterDb('subscriptions').where({ user_id: created.id, status: 'active' }).first('id');
    console.log('created id ' + created.id + ' | status ' + created.status
        + ' | tenant mirror: ' + (inTenant ? 'yes' : 'NO')
        + ' | seat: ' + (seat ? 'yes' : 'NO'));
    console.log('  ' + EMAIL + ' / ' + PASSWORD);
    process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
