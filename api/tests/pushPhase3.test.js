const test = require('node:test');
const assert = require('node:assert');
const { isPushableVoucherRow } = require('../Controllers/Agent/AgentController');

test('a row created here and waiting to sync is pushable', () => {
    assert.strictEqual(isPushableVoucherRow({ tally_guid: null, status: 'pending_tally' }), true);
});

test('a row that came from Tally is never pushed back', () => {
    assert.strictEqual(isPushableVoucherRow({ tally_guid: 'g-1', status: 'pending_tally' }), false);
});

test('a row that is not waiting to sync is not pushed', () => {
    for (const s of ['draft_cloud', 'created', 'failed', 'sent_to_tally']) {
        assert.strictEqual(isPushableVoucherRow({ tally_guid: null, status: s }), false, `status ${s}`);
    }
});
