const test = require('node:test');
const assert = require('node:assert');
const { pctChange } = require('../Controllers/Tenant/DashboardController');

test('pctChange reports a plain rise and fall', () => {
    assert.deepStrictEqual(pctChange(150, 100), { dir: 'up', pct: 50 });
    assert.deepStrictEqual(pctChange(50, 100), { dir: 'down', pct: 50 });
});

test('pctChange calls an unchanged value flat', () => {
    assert.deepStrictEqual(pctChange(100, 100), { dir: 'flat', pct: 0 });
});

test('pctChange refuses to invent a percentage when there is nothing to compare against', () => {
    // शून्य से बढ़ोतरी का प्रतिशत होता ही नहीं — "+∞%" या "+100%" दोनों झूठ हैं।
    assert.strictEqual(pctChange(80, 0).pct, null);
    assert.strictEqual(pctChange(80, 0).dir, 'up');
    assert.strictEqual(pctChange(0, 0).pct, 0);
    assert.strictEqual(pctChange(0, 0).dir, 'flat');
});

test('pctChange rounds to one decimal so the caption stays readable', () => {
    assert.strictEqual(pctChange(107, 93).pct, 15.1);
});
