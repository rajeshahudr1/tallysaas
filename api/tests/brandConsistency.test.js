const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const webBrand = require(path.join(ROOT, 'web', 'config', 'brand.js'));
const apiBrand = require(path.join(ROOT, 'api', 'config', 'brand.js'));

const NAME    = 'Teloora';
const TAGLINE = 'Connected Accounting';

test('the API and web agree on the brand', () => {
    assert.strictEqual(webBrand.name, NAME);
    assert.strictEqual(apiBrand.name, NAME);
    assert.strictEqual(webBrand.tagline, TAGLINE);
    assert.strictEqual(apiBrand.tagline, TAGLINE);
});

test('the agent carries the same name', () => {
    const src = fs.readFileSync(path.join(ROOT, 'agent', 'brand.py'), 'utf8');
    assert.ok(src.includes(`"${NAME}"`) || src.includes(`'${NAME}'`), 'agent/brand.py has the wrong name');
    assert.ok(src.includes(TAGLINE), 'agent/brand.py has the wrong tagline');
});

test('the mobile app carries the same name', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'core', 'brand.dart'), 'utf8');
    assert.ok(src.includes(`'${NAME}'`), 'brand.dart has the wrong name');
    assert.ok(src.includes(TAGLINE), 'brand.dart has the wrong tagline');
});

test('no runtime still answers to the old name', () => {
    for (const f of [
        path.join(ROOT, 'web', 'config', 'brand.js'),
        path.join(ROOT, 'api', 'config', 'brand.js'),
        path.join(ROOT, 'agent', 'brand.py'),
        path.join(ROOT, 'app', 'lib', 'core', 'brand.dart'),
    ]) {
        assert.ok(!fs.readFileSync(f, 'utf8').includes('Tally Cloud'), `${f} still says the old name`);
    }
});
