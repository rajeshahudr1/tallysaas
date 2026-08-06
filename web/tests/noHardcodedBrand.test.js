const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', 'docs', 'coverage', '.superpowers']);
// These two test files legitimately contain the old-name literal as the
// needle they search/assert for — not as a hard-coded brand display string.
const SELF_TEST_FILES = new Set(['noHardcodedBrand.test.js', 'brandConsistency.test.js']);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(js|ejs|json|css)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('no web or api source still hard-codes the old product name', () => {
    const files = [...walk(path.join(ROOT, 'web')), ...walk(path.join(ROOT, 'api'))]
        .filter((f) => !SELF_TEST_FILES.has(path.basename(f)));
    const bad = files.filter((f) => /Tally Cloud/.test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(bad.map((f) => path.relative(ROOT, f)), [],
        'these files still say the old name instead of reading the brand config');
});
