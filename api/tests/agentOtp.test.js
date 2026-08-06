'use strict';

/**
 * agentOtp holds the security decisions of agent activation, so the cases that
 * matter here are the REFUSALS. A bug in this file does not throw — it accepts
 * something it should have turned away, and a happy-path test sails straight
 * past it. Every rejection therefore gets its own test.
 */

const test = require('node:test');
const assert = require('node:assert');

const otp = require('../Helpers/agentOtp');

const T0 = new Date('2026-08-03T10:00:00Z');
const later = (ms) => new Date(T0.getTime() + ms);

/** A live, untouched challenge for machine M1 with code '123456'. */
function challenge(over = {}) {
    return {
        id: 'c-1',
        user_id: 7,
        machine_id: 'M1',
        code_hash: otp.hashCode('123456'),
        expires_at: later(otp.CODE_TTL_MS),
        attempts: 0,
        resends: 0,
        last_sent_at: T0,
        consumed_at: null,
        ...over,
    };
}

const verify = (row, over = {}, now = T0) =>
    otp.verifyChallenge(row, { code: '123456', machineId: 'M1', ...over }, now);

// ── Codes ────────────────────────────────────────────────────────
test('a fresh code from the right machine verifies', () => {
    const v = verify(challenge());
    assert.equal(v.ok, true);
    assert.equal(v.reason, 'verified');
});

test('the generated code is six digits', () => {
    for (let i = 0; i < 200; i += 1) {
        assert.match(otp.generateCode(), /^\d{6}$/);
    }
});

test('the plaintext code is never what gets stored', () => {
    const { row } = otp.buildChallenge({ id: 'c', userId: 1, machineId: 'M1', code: '123456', now: T0 });
    assert.notEqual(row.code_hash, '123456');
    assert.equal(row.code_hash, otp.hashCode('123456'));
    assert.equal(Object.values(row).includes('123456'), false);
});

// ── Refusals ─────────────────────────────────────────────────────
test('a wrong code is refused and counts an attempt', () => {
    const v = verify(challenge(), { code: '999999' });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'wrong_code');
    assert.equal(v.countAttempt, true);
    assert.equal(v.attemptsLeft, otp.MAX_ATTEMPTS - 1);
});

test('the last allowed attempt burns the challenge', () => {
    // Without this the row would sit at MAX_ATTEMPTS and be re-tried forever.
    const v = verify(challenge({ attempts: otp.MAX_ATTEMPTS - 1 }), { code: '999999' });
    assert.equal(v.ok, false);
    assert.equal(v.attemptsLeft, 0);
    assert.equal(v.burn, true);
});

test('a challenge already at the attempt cap is refused outright', () => {
    const v = verify(challenge({ attempts: otp.MAX_ATTEMPTS }));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'locked');
    assert.equal(v.burn, true);
});

test('an expired code is refused even when correct', () => {
    const v = verify(challenge(), {}, later(otp.CODE_TTL_MS + 1));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'expired');
});

test('expiry is exclusive at the boundary', () => {
    // A code that expires "now" is dead now, not in a millisecond.
    assert.equal(verify(challenge(), {}, later(otp.CODE_TTL_MS)).reason, 'expired');
    assert.equal(verify(challenge(), {}, later(otp.CODE_TTL_MS - 1)).ok, true);
});

test('a consumed code cannot be replayed', () => {
    const v = verify(challenge({ consumed_at: T0 }));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'consumed');
});

test('a correct code from a DIFFERENT machine is refused and burned', () => {
    // The point of binding: a code phished off one PC is useless on another.
    const v = verify(challenge(), { machineId: 'M2' });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'machine_mismatch');
    assert.equal(v.burn, true);
});

test('the machine is checked BEFORE the code', () => {
    // Otherwise a wrong-machine attempt reveals, via the message, whether the
    // code itself was right.
    const v = verify(challenge(), { machineId: 'M2', code: '999999' });
    assert.equal(v.reason, 'machine_mismatch');
});

test('a missing challenge and a consumed one give the same customer message', () => {
    // Distinguishing them would confirm that a given challenge_id once existed.
    const gone = otp.verifyChallenge(null, { code: '123456', machineId: 'M1' }, T0);
    const used = verify(challenge({ consumed_at: T0 }));
    assert.equal(gone.ok, false);
    assert.equal(gone.message, used.message);
});

test('a missing challenge does not throw', () => {
    assert.equal(otp.verifyChallenge(null, {}, T0).ok, false);
});

// ── Resend ───────────────────────────────────────────────────────
test('a resend inside the cooldown is refused with the wait remaining', () => {
    const r = otp.canResend(challenge(), later(20_000));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cooldown');
    assert.equal(r.retryInSeconds, 40);
});

test('a resend after the cooldown is allowed', () => {
    assert.equal(otp.canResend(challenge(), later(otp.RESEND_COOLDOWN_MS)).ok, true);
});

test('the resend cap holds even after the cooldown has passed', () => {
    // Well past the 60s cooldown but still inside the 10-minute TTL, so the cap
    // is the only thing that can refuse this.
    const r = otp.canResend(challenge({ resends: otp.MAX_RESENDS }), later(5 * 60_000));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'resend_cap');
});

test('an expired challenge cannot be resent', () => {
    // Resending would otherwise extend a dead challenge indefinitely.
    const r = otp.canResend(challenge(), later(otp.CODE_TTL_MS + 1));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
});

test('a consumed challenge cannot be resent', () => {
    assert.equal(otp.canResend(challenge({ consumed_at: T0 }), later(90_000)).ok, false);
});

// ── Hash compare ─────────────────────────────────────────────────
test('hash compare is exact and tolerates length mismatches', () => {
    const h = otp.hashCode('123456');
    assert.equal(otp.hashesEqual(h, h), true);
    assert.equal(otp.hashesEqual(h, otp.hashCode('123457')), false);
    // timingSafeEqual throws on unequal lengths; this must return false instead.
    assert.equal(otp.hashesEqual(h, 'short'), false);
    assert.equal(otp.hashesEqual(h, ''), false);
    assert.equal(otp.hashesEqual(undefined, undefined), false);
});

// ── Masking ──────────────────────────────────────────────────────
test('the masked address shows enough to recognise, not enough to guess', () => {
    assert.equal(otp.maskEmail('rajeshah2020@gmail.com'), 'ra***@gmail.com');
    assert.equal(otp.maskEmail('a@b.com'), 'a***@b.com');
});

test('a malformed address masks to empty rather than leaking it', () => {
    assert.equal(otp.maskEmail('not-an-email'), '');
    assert.equal(otp.maskEmail('@nolocal.com'), '');
    assert.equal(otp.maskEmail(''), '');
    assert.equal(otp.maskEmail(null), '');
});
