'use strict';

/**
 * web/lib/date-ranges.js
 *
 * The dashboard Summary panel's date-range presets. PURE — every function
 * takes the "current" date as an argument so the presets are testable and
 * so the server never depends on ambient clock state mid-request.
 *
 * Financial-year conventions (Indian FY): a year runs 1 Apr → 31 Mar, and
 * quarters are the FY quarters (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar).
 * Weeks run Monday → Monday, matching the reference product.
 *
 * Labels render like "This Year (1st Apr '26 - 31st Mar '27)".
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RANGE_VALUES = [
    'today', 'yesterday', 'this_week', 'last_week',
    'this_month', 'last_month', 'this_quarter',
    'this_year', 'last_year',
];

const DEFAULT_RANGE = 'this_year';

// 1 → "1st", 2 → "2nd", 3 → "3rd", 11..13 → "th", else by last digit.
function ordinal(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
    switch (n % 10) {
        case 1:  return `${n}st`;
        case 2:  return `${n}nd`;
        case 3:  return `${n}rd`;
        default: return `${n}th`;
    }
}

// Date → 'YYYY-MM-DD' using LOCAL components (never toISOString, which would
// shift the date backwards for any positive UTC offset such as IST).
function iso(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Date → "3rd Aug '26".
function pretty(d) {
    const yy = String(d.getFullYear()).slice(-2);
    return `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} '${yy}`;
}

function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Most recent Monday STRICTLY BEFORE d. Weeks are Monday→Monday inclusive of
// both ends (the reference product shows 27th Jul - 3rd Aug for a week whose
// "today" IS Monday 3rd Aug), so a Monday belongs to the week that opened the
// previous Monday rather than opening a zero-length week of its own.
function startOfWeek(d) {
    const dow = d.getDay();                 // 0 = Sunday
    const back = ((dow + 6) % 7) || 7;      // Tue → 1 … Sun → 6, Mon → 7
    return addDays(d, -back);
}

function startOfMonth(d, monthOffset = 0) {
    return new Date(d.getFullYear(), d.getMonth() + monthOffset, 1);
}

function endOfMonth(d, monthOffset = 0) {
    return new Date(d.getFullYear(), d.getMonth() + monthOffset + 1, 0);
}

// The calendar year in which this date's financial year STARTED.
// Jan/Feb/Mar belong to the FY that began the previous April.
function fyStartYear(d) {
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

// Financial quarter index 0..3 (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar).
function fyQuarter(d) {
    return Math.floor(((d.getMonth() - 3 + 12) % 12) / 3);
}

function span(title, from, to) {
    return { title, from, to, label: `${title} (${pretty(from)} - ${pretty(to)})` };
}

function single(title, day) {
    return { title, from: day, to: day, label: `${title} (${pretty(day)})` };
}

/**
 * Build all nine presets for a given "now".
 * @returns {Array<{value:string,label:string,from:string,to:string}>}
 */
function buildRanges(now) {
    const d = now instanceof Date ? now : new Date();

    const weekStart = startOfWeek(d);
    const fyStart   = fyStartYear(d);
    const q         = fyQuarter(d);
    const qStart    = new Date(fyStart, 3 + q * 3, 1);
    const qEnd      = new Date(fyStart, 3 + q * 3 + 3, 0);

    const defs = {
        today:        single('Today', d),
        yesterday:    single('Yesterday', addDays(d, -1)),
        this_week:    span('This Week', weekStart, d),
        last_week:    span('Last Week', addDays(weekStart, -7), weekStart),
        this_month:   span('This Month', startOfMonth(d), endOfMonth(d)),
        last_month:   span('Last Month', startOfMonth(d, -1), endOfMonth(d, -1)),
        this_quarter: span('This Quarter', qStart, qEnd),
        this_year:    span('This Year', new Date(fyStart, 3, 1), new Date(fyStart + 1, 2, 31)),
        last_year:    span('Last Year', new Date(fyStart - 1, 3, 1), new Date(fyStart, 2, 31)),
    };

    return RANGE_VALUES.map((value) => {
        const def = defs[value];
        return { value, label: def.label, from: iso(def.from), to: iso(def.to) };
    });
}

/**
 * Resolve one preset by key. Unknown or missing keys fall back to this_year,
 * so a hand-edited URL can never produce an undefined range.
 */
function resolveRange(value, now) {
    const all = buildRanges(now);
    return all.find((r) => r.value === value) || all.find((r) => r.value === DEFAULT_RANGE);
}

module.exports = { RANGE_VALUES, DEFAULT_RANGE, buildRanges, resolveRange };
