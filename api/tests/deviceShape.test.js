'use strict';

/**
 * The device list is what someone reads after a back-office PC goes missing, so
 * the rows have to be honest about two things: whether a machine can still
 * reach the books, and whether it is actually reachable right now. Those are
 * different questions — a revoked machine that is still switched on must never
 * read as "online".
 *
 * `shape` is where both are decided, so it is tested directly.
 */

const test = require('node:test');
const assert = require('node:assert');

const { shape, OFFLINE_AFTER_MS } = require('../Controllers/Tenant/DeviceController');

const NOW = new Date('2026-08-03T12:00:00Z').getTime();
const ago = (ms) => new Date(NOW - ms).toISOString();

const row = (over = {}) => ({
    id: 7,
    machine_name: 'MAINPC',
    agent_version: '1.0.0',
    status: 'active',
    last_seen_at: ago(30_000),
    activated_at: ago(86_400_000),
    revoked_at: null,
    user_name: 'Raje',
    ...over,
});

test('a recently seen active device is online', () => {
    const d = shape(row(), NOW);
    assert.equal(d.online, true);
    assert.equal(d.status, 'active');
    assert.equal(d.name, 'MAINPC');
    assert.equal(d.connected_by, 'Raje');
});

test('a device silent past the cutoff is offline, not missing', () => {
    // A back-office PC is switched off most nights; that is not an error state.
    assert.equal(shape(row({ last_seen_at: ago(OFFLINE_AFTER_MS + 1000) }), NOW).online, false);
});

test('the online cutoff spans several missed heartbeats', () => {
    // The agent beats each cycle (60s default). A cutoff shorter than a couple
    // of cycles would make every device flicker on a slow connection.
    assert.ok(OFFLINE_AFTER_MS >= 120_000, 'cutoff is too tight to be stable');
});

test('a REVOKED device is never online even if it just phoned home', () => {
    // The dangerous confusion: a stolen laptop still powered on. It can no
    // longer sync, and the row must not suggest otherwise.
    const d = shape(row({ status: 'revoked', last_seen_at: ago(1000) }), NOW);
    assert.equal(d.online, false);
    assert.equal(d.status, 'revoked');
});

test('a device that has never been seen is offline rather than crashing', () => {
    const d = shape(row({ last_seen_at: null }), NOW);
    assert.equal(d.online, false);
    assert.equal(d.last_seen_at, null);
});

test('an unnamed machine gets a readable placeholder', () => {
    // Better than a blank cell in a list someone is choosing from.
    assert.equal(shape(row({ machine_name: null }), NOW).name, 'Unnamed computer');
});

test('the machine fingerprint is never exposed', () => {
    // It is a hash: useless to a person picking a machine, and an identifier
    // there is no reason to put on a screen.
    const d = shape({ ...row(), machine_id: 'a1b2c3-secret-fingerprint' }, NOW);
    assert.equal(JSON.stringify(d).includes('secret-fingerprint'), false);
    assert.equal('machine_id' in d, false);
});

test('the id is a number so the revoke call cannot be fed a string', () => {
    assert.strictEqual(shape({ ...row(), id: '7' }, NOW).id, 7);
});
