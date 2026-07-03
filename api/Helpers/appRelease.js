'use strict';

/**
 * api/Helpers/appRelease.js
 *
 * Shared helpers for the MOBILE-APP auto-update feature (mirrors
 * Helpers/agentRelease.js for the Python agent).
 *
 *   releaseDir()          — absolute folder holding the published .apk files.
 *                           From env APP_RELEASE_DIR, default <api>/app-releases.
 *   resolveFile(name)     — SAFE absolute path inside releaseDir() (basename-only,
 *                           so a crafted filename can never path-traverse out).
 *   currentRelease(db)    — the single app_releases row with is_current=true.
 *   autoUpdateEnabled(db) — the GLOBAL master switch (system_settings
 *                           `app_auto_update`); defaults ON if unreadable.
 *   setAutoUpdate(db, on) — flip that switch (super-admin).
 */

const path = require('node:path');

function releaseDir() {
    const fromEnv = (process.env.APP_RELEASE_DIR || '').trim();
    const base = fromEnv || path.join(__dirname, '..', 'app-releases');
    return path.resolve(base);
}

function resolveFile(filename) {
    const safe = path.basename(String(filename || ''));
    if (!safe || safe === '.' || safe === '..') return null;
    return path.join(releaseDir(), safe);
}

async function currentRelease(db) {
    return db('app_releases').where('is_current', true).orderBy('id', 'desc').first();
}

/** The global on/off. jsonb comes back already-parsed from pg; guard a string
 * form too. Any read error → default ON (never block a working app-update flow). */
async function autoUpdateEnabled(db) {
    try {
        const row = await db('system_settings').where('key', 'app_auto_update').first('value');
        if (row && row.value != null) {
            const v = (typeof row.value === 'string') ? JSON.parse(row.value) : row.value;
            return !!v;
        }
    } catch (_) { /* fall through */ }
    return true;
}

async function setAutoUpdate(db, enabled) {
    const val = JSON.stringify(!!enabled);
    const existing = await db('system_settings').where('key', 'app_auto_update').first('id');
    if (existing) {
        await db('system_settings').where('id', existing.id).update({ value: val, updated_at: new Date() });
    } else {
        await db('system_settings').insert({ key: 'app_auto_update', value: val, updated_at: new Date() });
    }
}

module.exports = { releaseDir, resolveFile, currentRelease, autoUpdateEnabled, setAutoUpdate };
