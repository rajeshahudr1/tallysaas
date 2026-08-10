'use strict';

/**
 * api/tests/reminderTemplate.test.js
 *
 * The custom reminder wording. This text is written by a user and then sent to
 * their customers, so the two things that matter are that placeholders resolve
 * to the right values and that nothing else in the string is interpreted.
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyTemplate, reminderText, TEMPLATE_TOKENS } = require('../Helpers/reminders');

test('placeholders are replaced with their values', () => {
    assert.equal(
        applyTemplate('Dear {customer}, you owe {outstanding}.', { customer: 'ACME', outstanding: '₹5,000.00' }),
        'Dear ACME, you owe ₹5,000.00.');
});

test('a repeated placeholder is replaced everywhere', () => {
    assert.equal(applyTemplate('{customer}, hello {customer}', { customer: 'ACME' }), 'ACME, hello ACME');
});

test('an unknown placeholder is left alone, not blanked', () => {
    // A typo should look like a typo. Blanking it silently deletes the sentence
    // the user wrote, and they find out from their customer.
    assert.equal(applyTemplate('Hi {custmer}, pay {outstanding}', { outstanding: '₹1' }),
        'Hi {custmer}, pay ₹1');
});

test('only declared tokens are substituted', () => {
    // The template is user text. Anything that is not on the list stays literal
    // — there is no expression evaluation here to reach for.
    const out = applyTemplate('{constructor} {__proto__} {toString}', { customer: 'ACME' });
    assert.equal(out, '{constructor} {__proto__} {toString}');
});

test('reminderText uses the custom template when there is one', () => {
    const text = reminderText({
        customerName: 'ACME', companyName: 'Teloora', outstanding: 5000,
        overdueCount: 2, oldestDue: '2026-01-15',
        template: '{customer} owes {company} {outstanding} on {overdue} bill(s).',
    });
    assert.match(text, /^ACME owes Teloora ₹/);
    assert.match(text, /on 2 bill\(s\)\.$/);
});

test('a blank or whitespace template falls back to the standard message', () => {
    // Saving an empty box means "use the standard text", not "send nothing".
    for (const template of ['', '   ', '\n\n', null, undefined]) {
        const text = reminderText({
            customerName: 'ACME', companyName: 'Teloora', outstanding: 5000, overdueCount: 1, template,
        });
        assert.match(text, /gentle payment reminder/, 'fell through on ' + JSON.stringify(template));
    }
});

test('every advertised token actually resolves', () => {
    // The UI lists these to the user; one that does not work is a lie on screen.
    const template = TEMPLATE_TOKENS.map((t) => t.token).join(' | ');
    const text = reminderText({
        customerName: 'ACME', companyName: 'Teloora', outstanding: 5000,
        overdueCount: 2, oldestDue: '2026-01-15', template,
    });
    assert.ok(!/\{\w+\}/.test(text), 'an advertised token was left unresolved: ' + text);
});
