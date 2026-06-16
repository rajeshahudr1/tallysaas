'use strict';

/**
 * web/Helpers/syncReason.js
 *
 * Web-side COPY of api/Helpers/syncReason.js — a pure, dependency-free mapping
 * from a raw Tally sync message to a SHORT human cause + fix. The web BFF uses
 * it to render friendly reasons + restart guidance on the Sync Logs page
 * without an extra API round-trip. Keep it in sync with the api copy.
 *
 *   friendlyReason(message, status) -> { cause, fix, severity }
 *     severity: 'success' | 'info' | 'error'
 *
 *   RESTART_HELP — one-line, reusable "how to restart sync" string.
 */

const RESTART_HELP =
    'To restart sync: close the agent window and double-click ' +
    'TallyCloudSyncAgent.exe again (it re-activates from config.ini and ' +
    'resumes). The cloud keeps retrying failed records every 60s automatically.';

const RETRY_NOTE =
    'Restart: stop the agent (Ctrl+C) and run it again, or it retries ' +
    'automatically every 60s.';

function friendlyReason(message, status) {
    const raw = String(message == null ? '' : message);
    const m   = raw.toLowerCase();
    const st  = String(status == null ? '' : status).toLowerCase();

    if (st === 'synced' || st === 'created') {
        if (m.indexOf('imported from tally') !== -1) {
            return { cause: 'Imported from Tally', fix: 'No action needed.', severity: 'success' };
        }
        return { cause: 'Synced to Tally', fix: 'No action needed.', severity: 'success' };
    }

    if (m.indexOf('duplicate') !== -1) {
        return {
            cause: 'Already exists in Tally',
            fix: 'No action needed (idempotent).',
            severity: 'info',
        };
    }

    if (m.indexOf('not reachable') !== -1 || m.indexOf('refused') !== -1 ||
        m.indexOf('timed out') !== -1 || m.indexOf('gateway') !== -1) {
        return {
            cause: 'Tally is closed or its XML gateway is off',
            fix: 'Open TallyPrime, load the company, enable F1 > Settings > ' +
                 'Connectivity (Server, port 9000), then it retries automatically.',
            severity: 'error',
        };
    }

    if (m.indexOf('is not open') !== -1 || m.indexOf('no company') !== -1) {
        return {
            cause: 'The company is not open in Tally',
            fix: 'In Tally press Alt+F3 > Open Company and select it; sync ' +
                 'resumes next cycle.',
            severity: 'error',
        };
    }

    if (m.indexOf('voucher date is missing') !== -1) {
        return {
            cause: 'Tally Educational only allows vouchers dated the 1st-2nd of a month',
            fix: 'Use a LICENSED TallyPrime (any date works) - no app change needed.',
            severity: 'error',
        };
    }

    if (m.indexOf('unit') !== -1 && m.indexOf('does not exist') !== -1) {
        return {
            cause: 'The stock unit is not a usable unit in this company',
            fix: 'On Educational Tally predefined units (Nos/Box) can\'t be ' +
                 'auto-created via XML; on LICENSED Tally this works. Or create ' +
                 'the unit in Tally.',
            severity: 'error',
        };
    }

    if ((m.indexOf('godown') !== -1 || m.indexOf('stock group') !== -1) &&
        m.indexOf('does not exist') !== -1) {
        return {
            cause: 'Parent group/godown missing',
            fix: 'Usually transient from an older attempt; re-runs fix it.',
            severity: 'error',
        };
    }

    if (m.indexOf('exceptions') !== -1) {
        return {
            cause: 'Tally rejected the record',
            fix: 'Check the ledger/voucher in Tally; see raw message. ' + RETRY_NOTE,
            severity: 'error',
        };
    }

    return {
        cause: raw || 'Sync failed',
        fix: 'It will retry automatically each cycle; if it persists, restart the agent.',
        severity: st === 'failed' ? 'error' : 'info',
    };
}

module.exports = { friendlyReason, RESTART_HELP, RETRY_NOTE };
