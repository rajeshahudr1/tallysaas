'use strict';

/**
 * api/Helpers/gstin.js
 *
 * Pure GSTIN validation/decoding — no db, no network. A GSTIN encodes its
 * own truth: the first two characters are the state code, the next ten are
 * the PAN, the next character is the entity number (how many registrations
 * this PAN has in this state), then a fixed 'Z', then a check digit
 * computed from the other fourteen. So validity/state/PAN can all be
 * established offline, with zero guessing.
 *
 * `GST_STATES` comes from api/config/gstStates.js — the ONE source of state
 * names in this codebase. Do not duplicate that list here.
 */

const { GST_STATES } = require('../config/gstStates');

// 2 digits state + 10 char PAN (5 letters, 4 digits, 1 letter) + 1 digit
// entity number + 'Z' (fixed, reserved by GSTN) + 1 check digit.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const STATE_NAME_BY_CODE = new Map(GST_STATES.map((s) => [s.code, s.name]));

/**
 * Character value used by the checksum: '0'-'9' -> 0-9, 'A'-'Z' -> 10-35.
 */
function charValue(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) return code - 48;       // '0'-'9'
    if (code >= 65 && code <= 90) return code - 55;        // 'A'-'Z' (10-35)
    return -1;
}

function valueToChar(v) {
    if (v >= 0 && v <= 9) return String(v);
    return String.fromCharCode(55 + v); // 10 -> 'A' ... 35 -> 'Z'
}

/**
 * GSTIN check-digit algorithm (standard GSTN scheme — do not "simplify"
 * this later, it is exactly the published algorithm):
 *   1. Map each of the first 14 characters to its value (0-9 -> 0-9,
 *      A-Z -> 10-35).
 *   2. Multiply alternating characters (starting at position 1) by 1, 2,
 *      1, 2, ... (i.e. odd positions *1, even positions *2).
 *   3. For each product, add floor(product / 36) + (product % 36) — this
 *      folds the product back into 0-35 range ("Mod 36 with carry").
 *   4. Sum all 14 folded values, take that sum mod 36.
 *   5. checkValue = (36 - (sum mod 36)) mod 36; convert back to a char.
 *
 * Returns the expected check-digit CHARACTER for the given 14-character
 * prefix, or null if the prefix contains a character outside 0-9A-Z.
 */
function computeCheckDigit(prefix14) {
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const v = charValue(prefix14[i]);
        if (v < 0) return null;
        const factor = (i % 2 === 0) ? 1 : 2; // position 1 (index 0) *1, position 2 *2, ...
        const product = v * factor;
        sum += Math.floor(product / 36) + (product % 36);
    }
    const checkValue = (36 - (sum % 36)) % 36;
    return valueToChar(checkValue);
}

/**
 * isValidGstin(s) -> boolean. True only when the shape (15 chars, correct
 * pattern) AND the check digit both hold.
 */
function isValidGstin(s) {
    if (typeof s !== 'string') return false;
    const gstin = s.toUpperCase();
    if (!GSTIN_RE.test(gstin)) return false;
    const expected = computeCheckDigit(gstin.slice(0, 14));
    if (expected === null) return false;
    return expected === gstin[14];
}

/**
 * stateNameForCode(code) -> string or null. Null (never invented) when the
 * code isn't in GST_STATES.
 */
function stateNameForCode(code) {
    return STATE_NAME_BY_CODE.has(code) ? STATE_NAME_BY_CODE.get(code) : null;
}

/**
 * decodeGstin(s) -> null if invalid, otherwise
 *   { gstin, stateCode, stateName, pan, entityNumber, checkDigit }
 */
function decodeGstin(s) {
    if (!isValidGstin(s)) return null;
    const gstin = s.toUpperCase();
    return {
        gstin,
        stateCode:    gstin.slice(0, 2),
        stateName:    stateNameForCode(gstin.slice(0, 2)),
        pan:          gstin.slice(2, 12),
        entityNumber: gstin.slice(12, 13),
        checkDigit:   gstin.slice(14, 15),
    };
}

module.exports = { isValidGstin, decodeGstin, stateNameForCode };
