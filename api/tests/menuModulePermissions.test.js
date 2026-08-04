const test = require('node:test');
const assert = require('node:assert');

const { NEW_MODULES } = require('../db/migrations/20260804130000_menu_module_permissions');
const provision = require('../db/provision');

test('every new module is in the provision MODULES catalogue', () => {
    const catalogue = provision.MODULES;
    assert.ok(Array.isArray(catalogue), 'provision.js must export MODULES');
    for (const mod of NEW_MODULES) {
        assert.ok(catalogue.includes(mod), `MODULES missing "${mod}"`);
    }
});

test('the catalogue has no duplicate module slugs', () => {
    const catalogue = provision.MODULES;
    assert.strictEqual(new Set(catalogue).size, catalogue.length);
});
