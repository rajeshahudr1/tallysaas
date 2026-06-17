'use strict';

/**
 * api/Helpers/agentRelease.js
 *
 * Shared helpers for the agent auto-update release feature (Requirement 1).
 *
 *   releaseDir()         — absolute path of the folder that holds the published
 *                          exe files. From env AGENT_RELEASE_DIR, defaulting to
 *                          <api>/agent-releases. A super-admin drops the freshly
 *                          built TallyCloudSyncAgent.exe here, then publishes its
 *                          version (POST /super-admin/agent-release).
 *   currentRelease(db)   — the single agent_releases row with is_current=true,
 *                          or null. The published latest the agents update to.
 *   resolveFile(name)    — SAFE absolute path to a release file: only the
 *                          BASENAME of the stored filename is joined onto
 *                          releaseDir(), so a crafted filename can never
 *                          path-traverse out of the release folder.
 */

const path = require('node:path');

/**
 * Absolute path of the release directory (AGENT_RELEASE_DIR env, default
 * <api>/agent-releases). Resolved relative to the api root (one level up from
 * this Helpers dir) so a relative env value is stable regardless of cwd.
 */
function releaseDir() {
    const fromEnv = (process.env.AGENT_RELEASE_DIR || '').trim();
    const base = fromEnv || path.join(__dirname, '..', 'agent-releases');
    return path.resolve(base);
}

/**
 * SAFE absolute path to a file inside the release dir. We deliberately take only
 * path.basename(filename) so any directory components / "../" in a stored
 * filename are stripped — the result can never escape releaseDir().
 */
function resolveFile(filename) {
    const safe = path.basename(String(filename || ''));
    if (!safe || safe === '.' || safe === '..') return null;
    return path.join(releaseDir(), safe);
}

/**
 * The single published-current release row (is_current=true) or null. The
 * agent_releases table guarantees one current row (publish() clears the rest in
 * a transaction); .first() is still used defensively.
 */
async function currentRelease(db) {
    return db('agent_releases').where('is_current', true).orderBy('id', 'desc').first();
}

module.exports = { releaseDir, resolveFile, currentRelease };
