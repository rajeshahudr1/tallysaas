'use strict';

/**
 * api/Helpers/reminderSchedule.js
 *
 * Per-party payment-reminder schedules — the "Set Reminder" feature.
 *
 * The licence already has a blunt auto-reminder (jobs/reminderScheduler.js:
 * one pass at a fixed hour, chasing every overdue customer on fixed offset
 * days). This adds a schedule a user can set on ONE party: pick the channel,
 * the hour, and how often. When a party has its own schedule that schedule
 * wins; parties without one keep the licence-wide behaviour.
 *
 * Channels are Email and WhatsApp — what the product already sends. There is
 * deliberately no SMS: no gateway, no DLT templates, no credit ledger.
 *
 * PURE — no db access, so the "should this fire right now?" decision is
 * unit-testable without a database or a clock.
 */

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'due_date'];
const CHANNELS    = ['email', 'whatsapp', 'both'];

const DEFAULT_HOUR = 10;

function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < lo || n > hi) return fallback;
    return n;
}

/**
 * Coerce a stored or posted schedule into a complete, valid object. Anything
 * unrecognised falls back rather than throwing — a bad row must never take the
 * scheduler down.
 *
 * `weekday` is 0=Sunday..6=Saturday (JS convention).
 */
function normalizeSchedule(raw) {
    const s = raw || {};
    return {
        enabled:      s.enabled === true || s.enabled === 'true' || s.enabled === 1,
        channel:      CHANNELS.includes(s.channel) ? s.channel : 'whatsapp',
        frequency:    FREQUENCIES.includes(s.frequency) ? s.frequency : 'daily',
        send_hour:    clampInt(s.send_hour, 0, 23, DEFAULT_HOUR),
        weekday:      clampInt(s.weekday, 0, 6, 1),
        day_of_month: clampInt(s.day_of_month, 1, 31, 1),
    };
}

// Last calendar day of the month `d` falls in.
function lastDayOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Should this schedule fire at `now`?
 *
 * @param {object} schedule  a normalized schedule
 * @param {Date} now
 * @param {{days_overdue:number|null}} party  0 = due today, >0 = overdue
 * @returns {boolean}
 */
function dueNow(schedule, now, party) {
    const s = normalizeSchedule(schedule);
    if (!s.enabled) return false;

    // The scheduler ticks several times an hour; the hour gate is what keeps a
    // schedule to one send per day.
    if (now.getHours() !== s.send_hour) return false;

    const overdue = (party && party.days_overdue);
    if (overdue == null) return false;          // nothing outstanding → never chase

    switch (s.frequency) {
        case 'daily':
            return overdue >= 0;

        case 'weekly':
            return overdue >= 0 && now.getDay() === s.weekday;

        case 'monthly': {
            if (overdue < 0) return false;
            const dom = now.getDate();
            // A "31st" schedule must still fire in a 30-day month, on its last
            // day — otherwise it silently never runs.
            const target = Math.min(s.day_of_month, lastDayOfMonth(now));
            return dom === target;
        }

        case 'due_date':
            // Exactly on the due date, not after.
            return overdue === 0;

        default:
            return false;
    }
}

/**
 * The channel to actually send on, given the choice and what contact details
 * the party has. 'both' prefers WhatsApp (more immediate); either choice falls
 * back to the other channel rather than silently not sending.
 *
 * @returns {'email'|'whatsapp'|null}  null when the party is unreachable
 */
function pickChannel(choice, party) {
    const p = party || {};
    const hasMobile = !!String(p.mobile || '').trim();
    const hasEmail  = !!String(p.email  || '').trim();

    if (choice === 'email')    return hasEmail ? 'email' : (hasMobile ? 'whatsapp' : null);
    if (choice === 'whatsapp') return hasMobile ? 'whatsapp' : (hasEmail ? 'email' : null);
    // 'both' (or anything unrecognised)
    if (hasMobile) return 'whatsapp';
    if (hasEmail)  return 'email';
    return null;
}

module.exports = { FREQUENCIES, CHANNELS, DEFAULT_HOUR, normalizeSchedule, dueNow, pickChannel };
