const test = require('node:test');
const assert = require('node:assert');
const geo = require('../Helpers/geo');

test('countries load and India is there', () => {
    const list = geo.countries();
    assert.ok(list.length > 200, `expected 200+ countries, got ${list.length}`);
    const india = list.find((c) => c.name === 'India');
    assert.ok(india, 'India missing');
    assert.strictEqual(india.id, geo.INDIA_COUNTRY_ID);
});

test("India's states carry their GST code where the name matches", () => {
    const states = geo.statesOf(geo.INDIA_COUNTRY_ID);
    assert.ok(states.length >= 30, `expected 30+ Indian states, got ${states.length}`);
    const guj = states.find((s) => s.name === 'Gujarat');
    assert.ok(guj, 'Gujarat missing');
    assert.strictEqual(guj.gst_code, '24');
});

test('cities come back for a state and are indexed, not rescanned', () => {
    const states = geo.statesOf(geo.INDIA_COUNTRY_ID);
    const guj = states.find((s) => s.name === 'Gujarat');
    const cities = geo.citiesOf(guj.id);
    assert.ok(cities.length > 10, `expected many Gujarat cities, got ${cities.length}`);
    assert.ok(cities.every((c) => c.id && c.name));
    // second call returns the same array (index stays built, no re-scan of files)
    assert.strictEqual(geo.citiesOf(guj.id), cities);
});

test('an unknown state gives an empty list, not a throw', () => {
    assert.deepStrictEqual(geo.citiesOf(99999999), []);
});
