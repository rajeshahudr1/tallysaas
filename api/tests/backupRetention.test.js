const test = require('node:test');
const assert = require('node:assert');
const { copiesToDelete } = require('../Controllers/Tenant/BackupController');

const mk = (names) => names.map((n) => ({ name: n }));

test('nothing is deleted while there is room', () => {
    assert.deepStrictEqual(copiesToDelete(mk(['a', 'b']), 7), []);
});

test('the oldest copies go first once the limit is passed', () => {
    // सबसे पुरानी पहले — सूची पुराने से नए के क्रम में आती है।
    const del = copiesToDelete(mk(['1', '2', '3', '4', '5']), 3);
    assert.deepStrictEqual(del.map((d) => d.name), ['1', '2']);
});

test('keeping zero copies is refused — a backup that deletes everything is not a backup', () => {
    assert.deepStrictEqual(copiesToDelete(mk(['1', '2']), 0), []);
});

test('an empty destination needs no deletions', () => {
    assert.deepStrictEqual(copiesToDelete([], 3), []);
});
