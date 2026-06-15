'use strict';

/**
 * 04_licensing.js — backfill the licensing layer onto the demo data.
 *
 * Creates ONE demo license, links the seeded company (`abc`) + super-admin
 * user to it, and gives the super-admin an active 1-year subscription. The
 * generated license key is printed to the console (and stored only as a hash)
 * so you can paste it into the Python agent at activation time.
 *
 * Idempotent: re-running re-uses the existing demo license (matched by
 * holder_name) instead of creating duplicates, and re-prints a NEW key only
 * if none exists yet.
 */

const licenseKey = require('../../Helpers/licenseKey');

exports.seed = async function seed(knex) {
    const HOLDER = 'Demo License (ABC Pvt. Ltd.)';

    // 1. License (re-use if present; the stored hash can't be reversed, so we
    //    only mint+print a key when creating a fresh row).
    let lic = await knex('licenses').where('holder_name', HOLDER).whereNull('deleted_at').first();
    if (!lic) {
        const { key, prefix, hash } = licenseKey.generate();
        const validUntil = new Date(); validUntil.setFullYear(validUntil.getFullYear() + 1);
        const [row] = await knex('licenses').insert({
            license_key_hash: hash, key_prefix: prefix, holder_name: HOLDER,
            plan: 'standard', max_companies: 5, max_users: 10,
            valid_until: validUntil.toISOString().slice(0, 10), status: 'active',
        }).returning('*');
        lic = row;
        console.log('  ✓ license created:', HOLDER, '(id=' + lic.id + ')');
        console.log('    ┌──────────────────────────────────────────────┐');
        console.log('    │  AGENT LICENSE KEY (copy now, shown once):    │');
        console.log('    │  ' + key + '              │');
        console.log('    └──────────────────────────────────────────────┘');
    } else {
        console.log('  ✓ license already exists:', HOLDER, '(id=' + lic.id + ') — key not re-shown');
    }

    // 2. Link company `abc` + super-admin user to the license.
    const company = await knex('companies').where('slug', 'abc').first();
    if (company) {
        await knex('companies').where('id', company.id).update({ license_id: lic.id });
    }
    const admin = await knex('users').where('email', 'admin@tallysaas.test').first();
    if (admin) {
        await knex('users').where('id', admin.id)
            .update({ license_id: lic.id, current_company_id: company ? company.id : admin.company_id });

        // 3. Active 1-year subscription for the super-admin (so the per-user
        //    subscription gate has data to validate against).
        const exists = await knex('subscriptions').where('user_id', admin.id).first();
        if (!exists) {
            const from = new Date().toISOString().slice(0, 10);
            const until = new Date(); until.setFullYear(until.getFullYear() + 1);
            await knex('subscriptions').insert({
                user_id: admin.id, plan: 'standard',
                valid_from: from, valid_until: until.toISOString().slice(0, 10), status: 'active',
            });
            console.log('  ✓ subscription: admin@tallysaas.test → active (1 year)');
        }
    }
};
