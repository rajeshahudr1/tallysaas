'use strict';

/**
 * api/Helpers/syncReason.js
 *
 * Pure, dependency-free mapping from a raw Tally sync message (the text the
 * agent stored in tally_sync_logs.message) to a SHORT, human cause + fix.
 *
 * Used by SyncController.notifications (the bell feed) so the web/app surface a
 * plain-language reason + how to recover, instead of the raw Tally error. Kept
 * deliberately tiny and side-effect free so the web BFF can ship an identical
 * copy (web/Helpers/syncReason.js) without importing across packages.
 *
 *   friendlyReason(message, status) -> { cause, fix, severity }
 *     severity: 'success' | 'info' | 'error'
 *
 *   RESTART_HELP — one-line, reusable "how to restart sync" string.
 */

// Shown anywhere the user might need to bounce the local agent.
const RESTART_HELP =
    'To restart sync: close the agent window and double-click ' +
    'TallyCloudSyncAgent.exe again (it re-activates from config.ini and ' +
    'resumes). The cloud keeps retrying failed records every 60s automatically.';

// Generic restart sentence reused inside a couple of fixes.
const RETRY_NOTE =
    'Restart: stop the agent (Ctrl+C) and run it again, or it retries ' +
    'automatically every 60s.';

/**
 * Map a raw Tally message + status to a short cause/fix the user can act on.
 * Matching is case-insensitive and substring-based against the message text.
 *
 * @param {string} message  raw tally_sync_logs.message
 * @param {string} status   'synced' | 'created' | 'failed' | ...
 * @returns {{cause:string, fix:string, severity:'success'|'info'|'error'}}
 */
function friendlyReason(message, status) {
    const raw = String(message == null ? '' : message);
    const m   = raw.toLowerCase();
    const st  = String(status == null ? '' : status).toLowerCase();

    // ── Success rows (push 'synced'/'created', pull 'synced') ───────────
    if (st === 'synced' || st === 'created') {
        // Pull rows carry "Imported from Tally: X"; keep that context if present.
        if (m.indexOf('imported from tally') !== -1) {
            return { cause: 'Imported from Tally', fix: 'No action needed.', severity: 'success' };
        }
        return { cause: 'Synced to Tally', fix: 'No action needed.', severity: 'success' };
    }

    // ── DUPLICATE — already in Tally; treat as info, not a hard error ────
    if (m.indexOf('duplicate') !== -1) {
        return {
            cause: 'Already exists in Tally',
            fix: 'No action needed (idempotent).',
            severity: 'info',
        };
    }

    // ── Connectivity: Tally closed / gateway off ────────────────────────
    if (m.indexOf('not reachable') !== -1 || m.indexOf('refused') !== -1 ||
        m.indexOf('timed out') !== -1 || m.indexOf('gateway') !== -1) {
        return {
            cause: 'Tally is closed or its XML gateway is off',
            fix: 'Open TallyPrime, load the company, enable F1 > Settings > ' +
                 'Connectivity (Server, port 9000), then it retries automatically.',
            severity: 'error',
        };
    }

    // ── Company not open in Tally ───────────────────────────────────────
    if (m.indexOf('is not open') !== -1 || m.indexOf('no company') !== -1) {
        return {
            cause: 'The company is not open in Tally',
            fix: 'In Tally press Alt+F3 > Open Company and select it; sync ' +
                 'resumes next cycle.',
            severity: 'error',
        };
    }

    // ── Educational Tally: voucher date restriction ─────────────────────
    if (m.indexOf('voucher date is missing') !== -1) {
        return {
            cause: 'Tally Educational only allows vouchers dated the 1st-2nd of a month',
            fix: 'Use a LICENSED TallyPrime (any date works) - no app change needed.',
            severity: 'error',
        };
    }

    // ── Stock unit not usable in this company ───────────────────────────
    if (m.indexOf('unit') !== -1 && m.indexOf('does not exist') !== -1) {
        return {
            cause: 'The stock unit is not a usable unit in this company',
            fix: 'On Educational Tally predefined units (Nos/Box) can\'t be ' +
                 'auto-created via XML; on LICENSED Tally this works. Or create ' +
                 'the unit in Tally.',
            severity: 'error',
        };
    }

    // ── Parent group / godown missing (usually transient) ───────────────
    if ((m.indexOf('godown') !== -1 || m.indexOf('stock group') !== -1) &&
        m.indexOf('does not exist') !== -1) {
        return {
            cause: 'Parent group/godown missing',
            fix: 'Usually transient from an older attempt; re-runs fix it.',
            severity: 'error',
        };
    }

    // ── Generic Tally rejection ─────────────────────────────────────────
    if (m.indexOf('exceptions') !== -1) {
        return {
            cause: 'Tally rejected the record',
            fix: 'Check the ledger/voucher in Tally; see raw message. ' + RETRY_NOTE,
            severity: 'error',
        };
    }

    // ── Fallback: echo the message + reassure it retries ────────────────
    return {
        cause: raw || 'Sync failed',
        fix: 'It will retry automatically each cycle; if it persists, restart the agent.',
        severity: st === 'failed' ? 'error' : 'info',
    };
}

module.exports = { friendlyReason, RESTART_HELP, RETRY_NOTE };
