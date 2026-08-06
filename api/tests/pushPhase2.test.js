const test = require('node:test');
const assert = require('node:assert');
const { isPushableReturnNote } = require('../Controllers/Agent/AgentController');

test('a note created here and waiting to sync is pushable', () => {
    assert.strictEqual(isPushableReturnNote({ tally_guid: null, status: 'pending_tally' }), true);
});

test('a note that came FROM Tally is never pushed back', () => {
    // वरना ग्राहक की books में हर note दो बार बन जाएगी।
    assert.strictEqual(isPushableReturnNote({ tally_guid: 'abc-123', status: 'pending_tally' }), false);
    assert.strictEqual(isPushableReturnNote({ tally_guid: '', status: 'pending_tally' }), true);
});

test('a note that is not waiting to sync is not pushed', () => {
    for (const s of ['draft_cloud', 'created', 'failed', 'sent_to_tally']) {
        assert.strictEqual(isPushableReturnNote({ tally_guid: null, status: s }), false, `status ${s}`);
    }
});
