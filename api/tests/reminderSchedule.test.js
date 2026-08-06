'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    FREQUENCIES, CHANNELS, normalizeSchedule, dueNow, pickChannel,
} = require('../Helpers/reminderSchedule');

// A Wednesday, 11:00, 5th of the month.
const WED_11 = new Date(2026, 7, 5, 11, 0, 0);

const S = (patch) => normalizeSchedule({
    enabled: true, channel: 'whatsapp', frequency: 'daily',
    send_hour: 11, weekday: 3, day_of_month: 5, ...patch,
});

test('the frequency and channel vocabularies are fixed', () => {
    assert.deepStrictEqual(FREQUENCIES, ['daily', 'weekly', 'monthly', 'due_date']);
    assert.deepStrictEqual(CHANNELS, ['email', 'whatsapp', 'both']);
});

test('normalizeSchedule falls back to safe values for junk input', () => {
    const s = normalizeSchedule({ channel: 'sms', frequency: 'hourly', send_hour: 99, weekday: 12, day_of_month: 40 });
    assert.strictEqual(s.channel, 'whatsapp');
    assert.strictEqual(s.frequency, 'daily');
    assert.strictEqual(s.send_hour, 10);
    assert.strictEqual(s.weekday, 1);
    assert.strictEqual(s.day_of_month, 1);
    assert.strictEqual(s.enabled, false);
});

test('a disabled schedule never fires', () => {
    assert.strictEqual(dueNow(S({ enabled: false }), WED_11, { days_overdue: 3 }), false);
});

test('the hour must match — the scheduler ticks more than once an hour', () => {
    assert.strictEqual(dueNow(S({ send_hour: 11 }), WED_11, { days_overdue: 3 }), true);
    assert.strictEqual(dueNow(S({ send_hour: 12 }), WED_11, { days_overdue: 3 }), false);
});

test('daily fires every day at the hour', () => {
    assert.strictEqual(dueNow(S({ frequency: 'daily' }), WED_11, { days_overdue: 1 }), true);
    assert.strictEqual(dueNow(S({ frequency: 'daily' }), new Date(2026, 7, 9, 11), { days_overdue: 1 }), true);
});

test('weekly fires only on its weekday', () => {
    const wed = S({ frequency: 'weekly', weekday: 3 });   // 3 = Wednesday
    assert.strictEqual(dueNow(wed, WED_11, { days_overdue: 1 }), true);
    // Thursday 6 Aug 2026
    assert.strictEqual(dueNow(wed, new Date(2026, 7, 6, 11), { days_overdue: 1 }), false);
});

test('monthly fires only on its day of month', () => {
    const fifth = S({ frequency: 'monthly', day_of_month: 5 });
    assert.strictEqual(dueNow(fifth, WED_11, { days_overdue: 1 }), true);
    assert.strictEqual(dueNow(fifth, new Date(2026, 7, 6, 11), { days_overdue: 1 }), false);
});

test('monthly on the 31st still fires in a short month, on its last day', () => {
    const last = S({ frequency: 'monthly', day_of_month: 31 });
    // 30 Sep 2026 is September's last day — a 31st schedule must not be skipped.
    assert.strictEqual(dueNow(last, new Date(2026, 8, 30, 11), { days_overdue: 1 }), true);
    assert.strictEqual(dueNow(last, new Date(2026, 8, 29, 11), { days_overdue: 1 }), false);
});

test('due_date fires only on the day the invoice falls due', () => {
    const onDue = S({ frequency: 'due_date' });
    assert.strictEqual(dueNow(onDue, WED_11, { days_overdue: 0 }), true);
    assert.strictEqual(dueNow(onDue, WED_11, { days_overdue: 1 }), false);
    assert.strictEqual(dueNow(onDue, WED_11, { days_overdue: -2 }), false);
});

test('a party with nothing overdue is never chased', () => {
    assert.strictEqual(dueNow(S({ frequency: 'daily' }), WED_11, { days_overdue: null }), false);
    assert.strictEqual(dueNow(S({ frequency: 'daily' }), WED_11, {}), false);
});

test('pickChannel honours the choice and the party\'s contact details', () => {
    const cust = { mobile: '9876543210', email: 'a@b.com' };
    assert.strictEqual(pickChannel('whatsapp', cust), 'whatsapp');
    assert.strictEqual(pickChannel('email', cust), 'email');
    // 'both' prefers WhatsApp, the more immediate channel.
    assert.strictEqual(pickChannel('both', cust), 'whatsapp');
});

test('pickChannel falls back when the chosen channel has no address', () => {
    assert.strictEqual(pickChannel('whatsapp', { email: 'a@b.com' }), 'email');
    assert.strictEqual(pickChannel('email', { mobile: '98765' }), 'whatsapp');
    assert.strictEqual(pickChannel('both', { email: 'a@b.com' }), 'email');
});

test('pickChannel returns null when the party is unreachable', () => {
    assert.strictEqual(pickChannel('both', {}), null);
    assert.strictEqual(pickChannel('email', { mobile: '', email: '  ' }), null);
});
