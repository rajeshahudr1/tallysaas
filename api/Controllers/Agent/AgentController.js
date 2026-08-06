'use strict';

/**
 * api/Controllers/Agent/AgentController.js
 *
 * Endpoints the local Python sync agent calls. NO user auth — the agent
 * proves itself with the secret license key (activate) and then an agent
 * token (heartbeat/sync).
 *
 *   activate  — POST /api/v1/agent/activate   (public; presents the license key)
 *   heartbeat — POST /api/v1/agent/heartbeat  (authenticateAgent; req.license)
 *
 * Security:
 *   • The key is verified by sha256 hash (we never store it in clear).
 *   • First activation BINDS the license to the caller's machine fingerprint;
 *     a different machine is rejected (a copied key is useless elsewhere).
 *   • The returned agent token carries NO entitlement — every later call
 *     re-checks the license (status/expiry/machine) server-side, so a license
 *     can be suspended instantly and nothing is trusted from the client.
 */

const fs         = require('node:fs');
const path       = require('node:path');
const R          = require('../../Helpers/response');
const jwt        = require('../../Helpers/jwt');
const crypto     = require('node:crypto');
const passwords  = require('../../Helpers/passwords');
const mail       = require('../../Helpers/mail');
const agentOtp   = require('../../Helpers/agentOtp');
const throttle   = require('../../Helpers/throttle');
const db         = require('../../config/db').db;
const masterDb   = require('../../config/masterDb').db;
const { runWithTenant } = require('../../config/db');
const { getKnexForLicense } = require('../../config/tenantDb');
const { recordHistory } = require('../../Helpers/history');
const agentRelease      = require('../../Helpers/agentRelease');
const envelopeSigning   = require('../../Helpers/envelopeSigning');
const { logger }        = require('../../Helpers/logger');

// ── Toggleable agent diagnostics ────────────────────────────────
// AGENT_DEBUG=1 in the api .env logs exactly WHAT each agent sent and WHAT the
// cloud did with it (received counts vs accepted/skipped). Pairs with the
// agent's own log_level=DEBUG so a "Tally had data but the cloud stored
// nothing" gap is visible from BOTH ends. Turn OFF (AGENT_DEBUG=0) after testing.
const AGENT_DEBUG = process.env.AGENT_DEBUG === '1';
function adbg(...args) {
    if (AGENT_DEBUG) { try { console.log('[AGENT_DEBUG]', new Date().toISOString(), ...args); } catch (_) { /* never break a request on a log */ } }
}


/**
 * Company SYNC gating (on-the-fly, NO stored flag): a license may sync only its
 * FIRST `max_companies` companies, ordered by created_at asc (id asc as a
 * tie-break), non-deleted. Companies beyond the cap do NOT sync (they're
 * excluded from the pull/push queue, the activate list and the command targets).
 * A null/absent max_companies → unlimited (no cap applied). The cap auto-adjusts
 * whenever max_companies changes — there is nothing to migrate.
 *
 * Returns the ordered, capped company rows for the license (the columns asked
 * for). `maxCompanies` is read from the license row; pass it through so callers
 * that already hold it avoid a second read.
 */
async function syncingCompanies(licenseId, maxCompanies, columns) {
    let qb = db('companies')
        .where('license_id', licenseId)
        .whereNull('deleted_at')
        .orderBy('created_at', 'asc').orderBy('id', 'asc')
        .select(columns);
    if (maxCompanies != null) qb = qb.limit(Number(maxCompanies));
    return qb;
}

/**
 * ── AGENT SIGN-IN ────────────────────────────────────────────────
 *
 * Replaces licence-key activation. A licence key typed into a desktop app is a
 * bearer secret: anyone who reads it over a shoulder can activate an agent and
 * pull the whole book, and it binds one licence to one machine with no way to
 * revoke a single device.
 *
 * The flow is two calls. `login` checks the password and emails a code;
 * `verify` exchanges the code for a long-lived, machine-bound agent token and
 * records the device in `agents`.
 *
 * NO VALIDATION HAPPENS IN THE AGENT. Joi schemas in Validators/agent.js own
 * every rule, and the desktop app renders whatever `msg` comes back — so the
 * rules and the wording can change without shipping a new exe.
 */

// Effectively non-expiring. The agent is a Windows service that runs unattended
// for months; a token that expires stops sync until somebody walks to the PC and
// signs in again. Revocation is `agents.status`, enforced on every request by
// authenticateAgent — which is a better control anyway, because it can be
// applied the moment a machine is lost rather than whenever the token happens
// to lapse. (The previous 7-day token only worked because the agent kept the
// licence key and silently re-activated itself; with the key gone, that crutch
// is gone too.)
const AGENT_TOKEN_TTL = '3650d';

// Sign-in throttles. Two keys, because they defend against different things: a
// per-email counter stops password guessing against one account, a per-IP
// counter stops one host spraying many accounts. See Helpers/throttle.js for
// why this is in-process and why the OTP attempt cap is NOT.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_EMAIL = 5;
const LOGIN_MAX_PER_IP = 20;

// One response for every rejection in `login`. Returning "no such user" or
// "wrong password" would turn this endpoint into an email-enumeration oracle —
// an attacker could discover which addresses are registered without ever
// guessing a password. forgotPassword already takes this line; this follows it.
const LOGIN_GENERIC_MSG = 'Email or password is incorrect.';

function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
}

/**
 * POST /api/v1/agent/login   (public)
 * Body (validated): { email, password, machine_id, machine_name?, agent_version? }
 * → { challenge_id, email_masked, expires_in }
 */
async function login(req, res) {
    const { email, password, machine_id } = req.body;
    const ip = clientIp(req);

    try {
        const byIp = throttle.hit(`agent:login:ip:${ip}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
        const byEmail = throttle.hit(`agent:login:email:${email}`, LOGIN_MAX_PER_EMAIL, LOGIN_WINDOW_MS);
        if (!byIp.allowed || !byEmail.allowed) {
            const wait = Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds);
            return R.errorResponse(res,
                `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429);
        }

        // Auth is against the MASTER db (users/licences live there, not in a
        // tenant). role_slug is denormalised onto master.users for exactly this.
        const user = await masterDb('users')
            .whereRaw('lower(email) = ?', [String(email).toLowerCase()])
            .whereNull('deleted_at')
            .first('id', 'name', 'email', 'password_hash', 'status', 'license_id', 'role_slug');

        // Every failure below returns LOGIN_GENERIC_MSG with the same status, so
        // the caller cannot tell which check failed. The REASON is logged, since
        // support needs to distinguish "wrong password" from "licence expired".
        const deny = (reason) => {
            logger.warn(`[agent-login] denied ip=${ip} email=${email} reason=${reason}`);
            return R.errorResponse(res, LOGIN_GENERIC_MSG, 401);
        };

        if (!user) return deny('no_user');
        if (user.status !== 'Active') return deny(`user_status:${user.status}`);
        if (!(await passwords.verify(password, user.password_hash))) return deny('bad_password');
        if (!user.license_id) return deny('no_license');

        const lic = await masterDb('licenses').where('id', user.license_id)
            .whereNull('deleted_at').first('id', 'status', 'valid_until');
        if (!lic) return deny('license_missing');
        if (lic.status !== 'active') return deny(`license_status:${lic.status}`);
        const today = new Date().toISOString().slice(0, 10);
        if (lic.valid_until && String(lic.valid_until).slice(0, 10) < today) {
            return deny('license_expired');
        }

        // Not every user of a licence may attach a machine to it. Reuses the
        // existing 'tally-sync' RBAC module rather than inventing a permission.
        if (!(await canSetUpAgent(user))) return deny('no_permission');

        // Latest-wins: one live challenge per (user, machine). Without this a
        // user who clicks Continue twice ends up with two valid codes, and the
        // attempt cap applies to each separately.
        await masterDb('agent_otp_challenges')
            .where({ user_id: user.id, machine_id }).whereNull('consumed_at').del();

        const code = agentOtp.generateCode();
        const { row, expires_in } = agentOtp.buildChallenge({
            id: crypto.randomUUID(), userId: user.id, machineId: machine_id, code,
        });
        await masterDb('agent_otp_challenges').insert(row);

        // THE MAIL IS SENT AFTER THE RESPONSE, not before it. Handing the SMTP
        // round-trip to the customer meant the agent sat on a dead "Continue"
        // button for as long as the mail server felt like taking — several
        // seconds on a bad day, and the customer cannot tell a slow send from a
        // hung app.
        //
        // Waiting bought exactly one thing: a 502 when the send failed. That is
        // now covered by Resend, which IS synchronous and reports the failure —
        // the code screen already offers it, and a customer who never got a mail
        // reaches for it anyway. The challenge is left in place so that resend
        // has something to resend.
        setImmediate(() => {
            mail.sendAgentLoginCode(user.email, code, user.name)
                .catch((mailErr) => logger.error(
                    `[agent-login] mail failed for ${user.email}: ${mailErr.message}`));
        });

        return R.successResponse(res, {
            challenge_id: row.id,
            email_masked: agentOtp.maskEmail(user.email),
            expires_in,
        }, 'We emailed you a 6-digit code.');
    } catch (err) {
        console.error('AgentController.login error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * Whether this user may attach a machine to the licence.
 *
 * Roles live in the TENANT db while auth happens against master, so this binds
 * the licence's tenant to read the role's permissions. Super Admin bypasses, as
 * everywhere else. Any error is a denial: failing open here would let a user
 * with no permission activate an agent.
 */
async function canSetUpAgent(user) {
    if (user.role_slug === 'super-admin') return true;
    try {
        return await runWithTenant(getKnexForLicense(user.license_id), async () => {
            const row = await db('role_permissions as rp')
                .join('permissions as p', 'p.id', 'rp.permission_id')
                .join('roles as r', 'r.id', 'rp.role_id')
                .where('r.slug', user.role_slug)
                .where('p.module', 'tally-sync')
                .whereIn('p.action', ['create', 'manage'])
                .first('p.id');
            return !!row;
        });
    } catch (err) {
        logger.error(`[agent-login] permission check failed for user=${user.id}: ${err.message}`);
        return false;
    }
}

/**
 * POST /api/v1/agent/verify   (public — the challenge_id is the proof)
 * Body (validated): { challenge_id, code, machine_id, machine_name?, agent_version? }
 * → { agent_token, agent_id, license }
 */
async function verify(req, res) {
    const { challenge_id, code, machine_id, machine_name, agent_version } = req.body;

    try {
        const row = await masterDb('agent_otp_challenges').where('id', challenge_id).first();
        const verdict = agentOtp.verifyChallenge(row, { code, machineId: machine_id });

        if (!verdict.ok) {
            // The helper decides WHAT should happen; the writes happen here.
            if (verdict.countAttempt && row) {
                await masterDb('agent_otp_challenges').where('id', row.id).increment('attempts', 1);
            }
            if (verdict.burn && row) {
                await masterDb('agent_otp_challenges').where('id', row.id).del();
            }
            logger.warn(`[agent-verify] refused challenge=${challenge_id} reason=${verdict.reason}`);
            return R.errorResponse(res, verdict.message, 401);
        }

        // Consume BEFORE issuing the token. If token signing then fails the code
        // is spent and the customer requests a new one — annoying but safe. The
        // other order would leave a valid code usable after a token was issued.
        const consumed = await masterDb('agent_otp_challenges')
            .where('id', row.id).whereNull('consumed_at')
            .update({ consumed_at: new Date() });
        if (!consumed) {
            // Lost a race with a concurrent verify of the same code.
            return R.errorResponse(res, 'This code is no longer valid. Start again.', 401);
        }

        const user = await masterDb('users').where('id', row.user_id)
            .whereNull('deleted_at')
            .first('id', 'email', 'license_id', 'status');
        if (!user || user.status !== 'Active' || !user.license_id) {
            return R.errorResponse(res, 'This account can no longer sign in.', 403);
        }

        // Re-check the licence: it may have lapsed between login and verify.
        const lic = await masterDb('licenses').where('id', user.license_id)
            .whereNull('deleted_at')
            .first('id', 'holder_name', 'plan', 'valid_until', 'max_companies', 'status');
        if (!lic || lic.status !== 'active') {
            return R.errorResponse(res, 'This licence is not active. Contact support.', 403);
        }

        const now = new Date();
        // Upsert on (license_id, machine_id): re-activating the SAME PC updates
        // its row. Inserting a second row would inflate the device list and make
        // any future seat limit count one machine repeatedly.
        const [agent] = await masterDb('agents')
            .insert({
                license_id: lic.id, user_id: user.id,
                machine_id, machine_name: machine_name || null,
                agent_version: agent_version || null,
                status: 'active', activated_at: now,
                last_seen_at: now, created_at: now, updated_at: now,
                revoked_at: null, revoked_by: null,
            })
            .onConflict(['license_id', 'machine_id'])
            .merge({
                user_id: user.id, machine_name: machine_name || null,
                agent_version: agent_version || null,
                // A previously revoked machine that signs in again with a valid
                // password AND a valid emailed code is legitimately back.
                status: 'active', revoked_at: null, revoked_by: null,
                last_seen_at: now, updated_at: now,
            })
            .returning(['id']);

        const companies = await runWithTenant(
            getKnexForLicense(lic.id),
            () => syncingCompanies(lic.id, lic.max_companies, ['id', 'name', 'slug', 'status']),
        );

        const agentToken = jwt.sign(
            { kind: 'agent', license_id: lic.id, machine_id, agent_id: agent.id },
            AGENT_TOKEN_TTL,
        );

        // A completed sign-in clears the throttle so a user who fumbled their
        // password first is not left locked out of their own machine.
        throttle.reset(`agent:login:email:${String(user.email).toLowerCase()}`);

        logger.info(`[agent-verify] activated agent=${agent.id} license=${lic.id} machine=${machine_id}`);
        return R.successResponse(res, {
            agent_token: agentToken,
            agent_id: agent.id,
            license: {
                id: lic.id, holder_name: lic.holder_name, plan: lic.plan,
                valid_until: lic.valid_until, max_companies: lic.max_companies,
            },
            companies,
        }, 'This computer is now connected.');
    } catch (err) {
        console.error('AgentController.verify error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/otp/resend   (public)
 * Body (validated): { challenge_id }
 */
async function resendOtp(req, res) {
    const { challenge_id } = req.body;
    try {
        const row = await masterDb('agent_otp_challenges').where('id', challenge_id).first();
        const verdict = agentOtp.canResend(row);
        if (!verdict.ok) {
            return R.errorResponse(res, verdict.message,
                verdict.reason === 'cooldown' ? 429 : 401);
        }

        const user = await masterDb('users').where('id', row.user_id)
            .whereNull('deleted_at').first('id', 'name', 'email', 'status');
        if (!user || user.status !== 'Active') {
            return R.errorResponse(res, 'This code is no longer valid. Start again.', 401);
        }

        // A resend REPLACES the code. Leaving the old one alive would multiply
        // the number of guessable codes for a single challenge.
        const code = agentOtp.generateCode();
        const now = new Date();
        try {
            await mail.sendAgentLoginCode(user.email, code, user.name);
        } catch (mailErr) {
            logger.error(`[agent-resend] mail failed for ${user.email}: ${mailErr.message}`);
            return R.errorResponse(res,
                'Could not send the code by email. Try again in a moment.', 502);
        }
        await masterDb('agent_otp_challenges').where('id', row.id).update({
            code_hash: agentOtp.hashCode(code),
            // The attempt budget resets with the code: the attempts already
            // spent were against a code that no longer exists.
            attempts: 0,
            resends: Number(row.resends) + 1,
            last_sent_at: now,
        });

        return R.successResponse(res, {
            challenge_id: row.id,
            email_masked: agentOtp.maskEmail(user.email),
        }, 'We emailed you a new code.');
    } catch (err) {
        console.error('AgentController.resendOtp error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}


/**
 * POST /api/v1/agent/heartbeat   (behind authenticateAgent → req.license)
 * The agent pings periodically; we refresh last_seen + version and echo the
 * live license status so the agent halts if it was suspended in the cloud.
 *
 * The response ALSO echoes the per-license AUTO-sync DIRECTION toggles
 * (push_enabled / pull_enabled) so the agent loop can skip the push and/or pull
 * pass when the cloud has them turned off (Requirement 1). Both default to true
 * when the column is null/unreadable, so an older license / pre-migration DB
 * behaves exactly as before (both directions ON).
 *
 * The MASTER "Auto-sync" switch (licenses.sync_enabled) sits ABOVE the two
 * direction toggles: when it is OFF, NOTHING auto-syncs. We enforce that here,
 * cloud-side, by echoing EFFECTIVE gates — push_enabled = sync_enabled &&
 * sync_push_enabled and pull_enabled = sync_enabled && sync_pull_enabled — so
 * the ALREADY-DEPLOYED agent (no rebuild) skips ALL automatic push AND pull
 * while Auto-sync is OFF. sync_enabled is echoed too for completeness. Both the
 * master flag and the direction flags default ON when null/unreadable.
 */
async function heartbeat(req, res) {
    try {
        const now = new Date();
        const patch = {
            last_seen_at: now,
            agent_version: (req.body && req.body.agent_version) || undefined,
            updated_at: now,
        };
        // The agent reports the companies currently OPEN in Tally so the cloud
        // (and the web Sync page) can show what is live. Stored JSON-encoded.
        // Only written when the heartbeat actually carries the array, so a
        // heartbeat sent while Tally is down leaves the last value untouched.
        if (Array.isArray(req.body && req.body.open_companies)) {
            const names = req.body.open_companies
                .map((n) => String(n == null ? '' : n).trim())
                .filter((n) => n);
            patch.last_open_companies = JSON.stringify(names);
        }
        await masterDb('licenses').where('id', req.license.id).update(patch);

        // Liveness is per DEVICE now. The licence-level columns above are still
        // written so the existing admin screens keep working, but with several
        // machines on one licence they only ever show whichever agent phoned in
        // last — which is why the device list reads from `agents` instead.
        if (req.agent && req.agent.agent_id) {
            await masterDb('agents').where('id', req.agent.agent_id).update({
                last_seen_at: now,
                agent_version: (req.body && req.body.agent_version) || undefined,
                updated_at: now,
            });
        }

        // Per-license AUTO-sync toggles: the MASTER switch (sync_enabled) and the
        // two DIRECTION toggles (push/pull). authenticateAgent selects a fixed
        // column set (no sync flags), so read them here. Each defaults ON when the
        // column is null OR the table predates the migration (best-effort: a read
        // error must never break a working heartbeat).
        let syncEnabled = true;
        let pushEnabled = true;
        let pullEnabled = true;
        const SM = require('../../Helpers/syncModules');
        let pushModules = SM.ALL_KEYS.slice();   // default ALL
        let pullModules = SM.ALL_KEYS.slice();
        try {
            const lic = await masterDb('licenses').where('id', req.license.id)
                .first('sync_enabled', 'sync_push_enabled', 'sync_pull_enabled',
                       'sync_push_modules', 'sync_pull_modules');
            if (lic) {
                if (lic.sync_enabled      != null) syncEnabled = !!lic.sync_enabled;
                if (lic.sync_push_enabled != null) pushEnabled = !!lic.sync_push_enabled;
                if (lic.sync_pull_enabled != null) pullEnabled = !!lic.sync_pull_enabled;
                pushModules = SM.effectiveKeys(lic.sync_push_modules);
                pullModules = SM.effectiveKeys(lic.sync_pull_modules);
            }
        } catch (e) {
            syncEnabled = true;
            pushEnabled = true;
            pullEnabled = true;
        }

        // EFFECTIVE gates: the master Auto-sync switch beats the direction toggles.
        // With Auto-sync OFF, BOTH effective gates are false → the deployed agent
        // skips ALL automatic push and pull (no rebuild needed). With Auto-sync ON,
        // the direction toggles decide each pass as before.
        const effectivePush = syncEnabled && pushEnabled;
        const effectivePull = syncEnabled && pullEnabled;

        return R.successResponse(res, {
            status: req.license.status,
            license_id: req.license.id,
            server_time: now.toISOString(),
            // Selected modules for AUTO push/pull (for the agent's logs; the server
            // already filters /pending + /import by these). ALL when unconfigured.
            push_modules: pushModules,
            pull_modules: pullModules,
            // EFFECTIVE auto-sync direction gates the agent loop reads each cycle
            // (master Auto-sync AND the per-direction toggle). Auto-sync OFF → both
            // false so the agent skips every automatic sync pass.
            push_enabled: effectivePush,
            pull_enabled: effectivePull,
            // The raw master switch, echoed for completeness.
            sync_enabled: syncEnabled,
        }, 'ok');
    } catch (err) {
        console.error('AgentController.heartbeat error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/offline   (behind authenticateAgent → req.license)
 *
 * GRACEFUL SHUTDOWN signal. When the agent stops ON PURPOSE (service stop / GUI
 * Stop / Uninstall) it sends this so the cloud flips the license to Disconnected
 * IMMEDIATELY rather than waiting out the ~150s CONNECTED_WINDOW. We do this by
 * CLEARING licenses.last_seen_at (and last_open_companies, since nothing is open
 * any more) → SyncController.summary + LicenseController then compute
 * connected=false at once because last_seen_at is null.
 *
 * Idempotent + safe: clearing an already-null value is a no-op. The agent calls
 * this best-effort/non-blocking, so a failure here must never matter to it. An
 * UNGRACEFUL crash/force-kill never reaches this path and falls back to the
 * 150s window (unavoidable — the cloud cannot ping behind the firewall).
 */
async function offline(req, res) {
    try {
        const now = new Date();
        await masterDb('licenses').where('id', req.license.id).update({
            last_seen_at: null,
            last_open_companies: null,
            updated_at: now,
        });
        return R.successResponse(res, { offline: true }, 'ok');
    } catch (err) {
        console.error('AgentController.offline error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

// Date → Tally's YYYYMMDD. Handles pg Date objects (whose String() is the JS
// toString, NOT yyyy-mm-dd) by reading local Y/M/D components; falls back to
// slicing an ISO/string date. (A bad date made Tally reject vouchers with
// "Voucher date is missing".)
function tallyDate(d) {
    const dt = (d instanceof Date) ? d : (d ? new Date(d) : new Date());
    if (!isNaN(dt)) {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
    }
    return String(d || '').slice(0, 10).replace(/-/g, '');
}

/**
 * Whether a credit/debit note row may be pushed to Tally.
 *
 * Credit and Debit Notes land in the `invoices` table from TWO directions:
 * created here in the cloud (tally_guid empty) or pulled FROM Tally
 * (tally_guid set, by importFromTally). Only the former may ever be pushed
 * back — pushing a Tally-origin note would create it in Tally a second
 * time, duplicating it in the customer's books. Kept as a single exported,
 * pure predicate (rather than inlined at each call site) so the rule lives
 * in exactly one place and is directly testable.
 */
function isPushableReturnNote(row) {
    return !(row && row.tally_guid) && !!row && row.status === 'pending_tally';
}

/**
 * Whether a Quotation / Sales Order / Purchase Order / Delivery Note /
 * Receipt Note row may be pushed to Tally.
 *
 * Same rule as isPushableReturnNote above, and for the same reason: these
 * five tables (like `invoices`) can be written to from Tally in a later
 * phase, and a row that already carries a tally_guid must never be pushed
 * BACK — that would create it in Tally a second time. Kept identical in
 * shape to isPushableReturnNote on purpose, not merged with it, because the
 * two source tables are unrelated and a future divergence (e.g. these five
 * gaining a status Tally-origin rows never use) should not have to fight a
 * shared implementation.
 */
function isPushableVoucherRow(row) {
    return !!row && row.status === 'pending_tally' && !row.tally_guid;
}

/**
 * GET /api/v1/agent/pending   (authenticateAgent → req.license)
 *
 * Everything under this license that still needs pushing to Tally, shaped for
 * the connector. Masters first (ledgers + stock items must exist before
 * vouchers reference them), then vouchers.
 *   • ledgers      — customers (Sundry Debtors) + suppliers (Sundry Creditors)
 *                    that are Tally ledgers and not yet synced (tally_guid NULL)
 *   • stock_items  — products marked as Tally items, not yet synced
 *   • vouchers     — invoices + payments still in 'pending_tally'
 * Batched (50 of each) so a big backlog drains over several passes.
 */
async function pending(req, res) {
    try {
        // SYNC GATE: only the first max_companies companies (created_at asc, id
        // asc) sync — the rest are excluded from the pull/push queue. max_companies
        // isn't on req.license (authenticateAgent selects a fixed set), so read it.
        const licRow = await masterDb('licenses').where('id', req.license.id)
            .first('max_companies', 'sync_push_modules');
        const maxCompanies = licRow ? licRow.max_companies : null;
        // Selective AUTO-push: only the operator-selected modules are queued for
        // Tally (null column = ALL). We filter the assembled push payload at the
        // return below via this parsed selection.
        const SM = require('../../Helpers/syncModules');
        const pushSel = SM.parseModules(licRow && licRow.sync_push_modules);
        const companies = await syncingCompanies(
            req.license.id, maxCompanies,
            ['id', 'name', 'slug', 'tally_guid', 'tally_synced_at', 'tally_dirty', 'mailing_name', 'email', 'phone', 'mobile',
             'gst_number', 'pan_number', 'state', 'pincode', 'country', 'address', 'books_from'],
        );
        const companyIds = companies.map((c) => c.id);
        if (!companyIds.length) {
            return R.successResponse(res, {
                ledgers: [], stock_items: [], vouchers: [], locations: [], categories: [],
                companies: [], companies_to_create: [],
            });
        }

        // Web-made companies not yet created in Tally — the agent creates each in
        // Tally then reports back so result() stamps tally_synced_at.
        // Gate on tally_synced_at, NOT tally_guid: a Tally master-import response
        // carries no GUID, so the guid only ever arrives on a later PULL. Keying
        // "exists in Tally" off the guid is what forced the old placeholder writes.
        const companiesToCreate = companies
            .filter((c) => !c.tally_synced_at || c.tally_dirty)
            .map((c) => ({
                id: c.id, name: c.name,
                action: c.tally_synced_at ? 'Alter' : 'Create',
                mailing_name: c.mailing_name || null, email: c.email || null,
                phone: c.phone || null, mobile: c.mobile || null,
                gst: c.gst_number || null, pan: c.pan_number || null,
                state: c.state || null, pincode: c.pincode || null,
                country: c.country || null, address: c.address || null,
                // Cloud stores "YYYY-MM-DD"; Tally wants "YYYYMMDD".
                books_from: c.books_from ? String(c.books_from).replace(/-/g, '').slice(0, 8) : null,
            }));

        // ── Ledgers ──
        // Never-pushed (tally_synced_at NULL) OR edited-after-sync (tally_dirty)
        // records — the latter re-push as an ALTER so cloud edits reach Tally.
        const _newOrDirty = (q) => q.whereNull('tally_synced_at').orWhere('tally_dirty', true);
        const customers = await db('customers')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('is_tally_ledger', true).where(_newOrDirty)
            .limit(50)
            .select('id', 'company_id', 'name', 'gst_number', 'opening_balance',
                    'mobile', 'email', 'pan_number', 'billing_address', 'credit_limit', 'tally_synced_at');
        const suppliers = await db('suppliers')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('is_tally_ledger', true).where(_newOrDirty)
            .limit(50)
            .select('id', 'company_id', 'name', 'gst_number', 'opening_balance',
                    'mobile', 'email', 'pan_number', 'address', 'tally_synced_at');
        // FULL party record pushed to Tally (not just name/gstin/opening). Already-
        // synced rows (tally_guid set) come through dirty → ACTION 'Alter'.
        const ledgers = [
            ...customers.map((c) => ({
                record_type: 'customer', id: c.id, company_id: c.company_id, name: c.name,
                parent: 'Sundry Debtors', gstin: c.gst_number || null, opening: Number(c.opening_balance) || 0,
                mobile: c.mobile || null, email: c.email || null, pan: c.pan_number || null,
                address: c.billing_address || null,
                credit_limit: (c.credit_limit != null ? Number(c.credit_limit) : null),
                action: c.tally_synced_at ? 'Alter' : 'Create',
            })),
            ...suppliers.map((s) => ({
                record_type: 'supplier', id: s.id, company_id: s.company_id, name: s.name,
                parent: 'Sundry Creditors', gstin: s.gst_number || null, opening: Number(s.opening_balance) || 0,
                mobile: s.mobile || null, email: s.email || null, pan: s.pan_number || null,
                address: s.address || null,
                action: s.tally_synced_at ? 'Alter' : 'Create',
            })),
        ];

        // ── Stock items ──
        const products = await db('products')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('is_tally_item', true).where(_newOrDirty)
            .limit(50)
            .select('id', 'company_id', 'name', 'unit', 'hsn_code', 'gst_rate', 'tally_synced_at');
        const stock_items = products.map((p) => ({
            record_type: 'product', id: p.id, company_id: p.company_id, name: p.name,
            unit: p.unit || 'Nos', hsn: p.hsn_code || null, gst_rate: Number(p.gst_rate) || 0,
            action: p.tally_synced_at ? 'Alter' : 'Create',
        }));

        // ── Locations → Tally godowns ──
        // All non-deleted locations not yet pushed. result() stamps
        // tally_synced_at so these stop appearing here.
        const locationRows = await db('locations')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where(_newOrDirty)
            .limit(50)
            .select('id', 'company_id', 'name');
        const locations = locationRows.map((l) => ({
            record_type: 'location', id: l.id, company_id: l.company_id, name: l.name,
        }));

        // ── Categories → Tally stock groups ──
        // Categories now carry tally_synced_at/tally_dirty (tenant migration 002),
        // so they push ONCE and are stamped — no more re-pushing every cycle, and
        // result() can finally write the audit row for them.
        const categoryRows = await db('categories')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where(_newOrDirty)
            .limit(50)
            .select('id', 'company_id', 'name');
        const categories = categoryRows.map((c) => ({
            record_type: 'category', id: c.id, company_id: c.company_id, name: c.name,
        }));

        // ── Vouchers: invoices ──
        const invoices = await db('invoices as i')
            .whereIn('i.company_id', companyIds).whereNull('i.deleted_at')
            .where('i.status', 'pending_tally')
            // Field-sales approval gate: a salesman's invoice only reaches Tally
            // AFTER a company admin approves it (default 'approved' → admin/web
            // invoices + all historical rows sync exactly as before).
            .andWhere('i.approval_status', 'approved')
            .leftJoin('customers as c', 'c.id', 'i.customer_id')
            .leftJoin('suppliers as s', 'i.supplier_id', 's.id')
            .limit(50)
            .select('i.id', 'i.company_id', 'i.type', 'i.invoice_no', 'i.invoice_date', 'i.total',
                    'i.taxable', 'i.cgst', 'i.sgst', 'i.igst',
                    'c.name as customer', 's.name as supplier');
        const invIds = invoices.map((i) => i.id);
        let itemsByInvoice = {};
        if (invIds.length) {
            const items = await db('invoice_items as it')
                .whereIn('it.invoice_id', invIds)
                .leftJoin('products as p', 'p.id', 'it.product_id')
                .select('it.invoice_id', 'it.quantity', 'it.rate', 'it.gst_rate',
                        'it.description', 'p.name as product_name');
            itemsByInvoice = items.reduce((acc, it) => {
                (acc[it.invoice_id] = acc[it.invoice_id] || []).push({
                    name: it.product_name || it.description || 'Item',
                    qty: Number(it.quantity) || 0, rate: Number(it.rate) || 0, gst_rate: Number(it.gst_rate) || 0,
                });
                return acc;
            }, {});
        }
        // ── Vouchers: credit / debit notes (fetched here, ahead of ledMap, so
        // their companies are included in the ledger-name detection below) ──
        // These live in the SAME `invoices` table as ordinary sales/purchase
        // invoices (see ReturnNoteController's header comment), so this is a
        // sibling query to the invoices one above — NOT a modification of it,
        // and excludeReturns() (InvoiceController) is untouched: that filter
        // exists precisely so plain invoice listings skip these rows, while
        // this query exists precisely to pick them up.
        //
        // CRITICAL: a note can arrive from either direction — created here
        // (tally_guid null) or pulled FROM Tally (tally_guid set, see
        // importFromTally's Credit Note / Debit Note handling). Only the
        // former may be pushed BACK to Tally; pushing a Tally-origin note
        // would duplicate it in the customer's books on the next pull. That
        // rule lives in isPushableReturnNote (above), a single exported
        // predicate, defined once and tested once rather than re-derived at
        // each call site.
        const returnNoteRows = await db('invoices as i')
            .whereIn('i.company_id', companyIds).whereNull('i.deleted_at')
            .whereIn('i.tally_voucher_type', ['Credit Note', 'Debit Note'])
            .where('i.status', 'pending_tally')
            .andWhere('i.approval_status', 'approved')
            .leftJoin('customers as c', 'c.id', 'i.customer_id')
            .leftJoin('suppliers as s', 'i.supplier_id', 's.id')
            .limit(50)
            .select('i.id', 'i.company_id', 'i.type', 'i.tally_voucher_type', 'i.tally_guid', 'i.status',
                    'i.invoice_no', 'i.invoice_date', 'i.total', 'i.taxable', 'i.cgst', 'i.sgst', 'i.igst',
                    'c.name as customer', 's.name as supplier')
            .then((rows) => rows.filter(isPushableReturnNote));
        const rnIds = returnNoteRows.map((i) => i.id);
        let itemsByReturnNote = {};
        if (rnIds.length) {
            const rnItems = await db('invoice_items as it')
                .whereIn('it.invoice_id', rnIds)
                .leftJoin('products as p', 'p.id', 'it.product_id')
                .select('it.invoice_id', 'it.quantity', 'it.rate', 'it.gst_rate',
                        'it.description', 'p.name as product_name');
            itemsByReturnNote = rnItems.reduce((acc, it) => {
                (acc[it.invoice_id] = acc[it.invoice_id] || []).push({
                    name: it.product_name || it.description || 'Item',
                    qty: Number(it.quantity) || 0, rate: Number(it.rate) || 0, gst_rate: Number(it.gst_rate) || 0,
                });
                return acc;
            }, {});
        }

        // ── Vouchers: Quotation / Sales Order / Purchase Order / Delivery Note /
        // Receipt Note — five item-voucher kinds that carry NO ledger double-
        // entry (Task 1's shared _inventory_voucher_xml builder just wants
        // party + items + dates), so unlike invoices/returnNoteRows above these
        // do not need ledMap. Each is its own table with its own items table
        // (see the migrations under api/db/migrations_tenant/), so five
        // sibling queries rather than one shared one. isPushableVoucherRow is
        // the SAME "never push a Tally-origin row back" rule as
        // isPushableReturnNote, applied here for exactly the same reason.
        const quotationRows = await db('quotations as q')
            .whereIn('q.company_id', companyIds).whereNull('q.deleted_at')
            .where('q.status', 'pending_tally')
            .leftJoin('customers as c', 'c.id', 'q.customer_id')
            .limit(50)
            .select('q.id', 'q.company_id', 'q.quotation_no', 'q.quotation_date', 'q.valid_till',
                    'q.tally_voucher_type', 'q.tally_guid', 'q.status', 'c.name as customer')
            .then((rows) => rows.filter(isPushableVoucherRow));
        const salesOrderRows = await db('sales_orders as so')
            .whereIn('so.company_id', companyIds).whereNull('so.deleted_at')
            .where('so.status', 'pending_tally')
            .leftJoin('customers as c', 'c.id', 'so.customer_id')
            .limit(50)
            .select('so.id', 'so.company_id', 'so.order_no', 'so.order_date', 'so.due_on',
                    'so.tally_voucher_type', 'so.tally_guid', 'so.status', 'c.name as customer')
            .then((rows) => rows.filter(isPushableVoucherRow));
        const purchaseOrderRows = await db('purchase_orders as po')
            .whereIn('po.company_id', companyIds).whereNull('po.deleted_at')
            .where('po.status', 'pending_tally')
            .leftJoin('suppliers as s', 's.id', 'po.supplier_id')
            .limit(50)
            .select('po.id', 'po.company_id', 'po.order_no', 'po.order_date', 'po.due_on',
                    'po.tally_voucher_type', 'po.tally_guid', 'po.status', 's.name as supplier')
            .then((rows) => rows.filter(isPushableVoucherRow));
        const deliveryNoteRows = await db('delivery_notes as dn')
            .whereIn('dn.company_id', companyIds).whereNull('dn.deleted_at')
            .where('dn.status', 'pending_tally')
            .leftJoin('customers as c', 'c.id', 'dn.customer_id')
            .limit(50)
            .select('dn.id', 'dn.company_id', 'dn.note_no', 'dn.note_date', 'dn.dispatch_date',
                    'dn.tally_voucher_type', 'dn.tally_guid', 'dn.status', 'c.name as customer')
            .then((rows) => rows.filter(isPushableVoucherRow));
        const receiptNoteRows = await db('receipt_notes as rn')
            .whereIn('rn.company_id', companyIds).whereNull('rn.deleted_at')
            .where('rn.status', 'pending_tally')
            .leftJoin('suppliers as s', 's.id', 'rn.supplier_id')
            .limit(50)
            .select('rn.id', 'rn.company_id', 'rn.note_no', 'rn.note_date', 'rn.received_date',
                    'rn.tally_voucher_type', 'rn.tally_guid', 'rn.status', 's.name as supplier')
            .then((rows) => rows.filter(isPushableVoucherRow));

        const qIds  = quotationRows.map((r) => r.id);
        const soIds = salesOrderRows.map((r) => r.id);
        const poIds = purchaseOrderRows.map((r) => r.id);
        const dnIds = deliveryNoteRows.map((r) => r.id);
        const rnIds2 = receiptNoteRows.map((r) => r.id);

        const loadItems = async (table, fkCol) => {
            const ids = { quotation_items: qIds, sales_order_items: soIds,
                          purchase_order_items: poIds, delivery_note_items: dnIds,
                          receipt_note_items: rnIds2 }[table];
            if (!ids.length) return {};
            const rows = await db(`${table} as it`)
                .whereIn(`it.${fkCol}`, ids)
                .leftJoin('products as p', 'p.id', 'it.product_id')
                .select(`it.${fkCol} as header_id`, 'it.quantity', 'it.rate', 'it.godown',
                        'it.description', 'p.name as product_name');
            return rows.reduce((acc, it) => {
                (acc[it.header_id] = acc[it.header_id] || []).push({
                    name: it.product_name || it.description || 'Item',
                    qty: Number(it.quantity) || 0, rate: Number(it.rate) || 0,
                    godown: it.godown || null,
                });
                return acc;
            }, {});
        };
        const itemsByQuotation     = await loadItems('quotation_items', 'quotation_id');
        const itemsBySalesOrder    = await loadItems('sales_order_items', 'sales_order_id');
        const itemsByPurchaseOrder = await loadItems('purchase_order_items', 'purchase_order_id');
        const itemsByDeliveryNote  = await loadItems('delivery_note_items', 'delivery_note_id');
        const itemsByReceiptNote   = await loadItems('receipt_note_items', 'receipt_note_id');

        const quotationVouchers = quotationRows.map((q) => ({
            record_type: 'quotation', id: q.id, company_id: q.company_id,
            voucher_kind: 'quotation', vch_type: q.tally_voucher_type || 'Quotation',
            voucher_no: q.quotation_no, date: tallyDate(q.quotation_date),
            valid_till: q.valid_till ? tallyDate(q.valid_till) : null,
            party: q.customer, items: itemsByQuotation[q.id] || [],
        }));
        const salesOrderVouchers = salesOrderRows.map((so) => ({
            record_type: 'sales_order', id: so.id, company_id: so.company_id,
            voucher_kind: 'sales_order', vch_type: so.tally_voucher_type || 'Sales Order',
            voucher_no: so.order_no, date: tallyDate(so.order_date),
            due_on: so.due_on ? tallyDate(so.due_on) : null,
            party: so.customer, items: itemsBySalesOrder[so.id] || [],
        }));
        const purchaseOrderVouchers = purchaseOrderRows.map((po) => ({
            record_type: 'purchase_order', id: po.id, company_id: po.company_id,
            voucher_kind: 'purchase_order', vch_type: po.tally_voucher_type || 'Purchase Order',
            voucher_no: po.order_no, date: tallyDate(po.order_date),
            due_on: po.due_on ? tallyDate(po.due_on) : null,
            party: po.supplier, items: itemsByPurchaseOrder[po.id] || [],
        }));
        const deliveryNoteVouchers = deliveryNoteRows.map((dn) => ({
            record_type: 'delivery_note', id: dn.id, company_id: dn.company_id,
            voucher_kind: 'delivery_note', vch_type: dn.tally_voucher_type || 'Delivery Note',
            voucher_no: dn.note_no, date: tallyDate(dn.note_date),
            dispatch_date: dn.dispatch_date ? tallyDate(dn.dispatch_date) : null,
            party: dn.customer, items: itemsByDeliveryNote[dn.id] || [],
        }));
        const receiptNoteVouchers = receiptNoteRows.map((rn) => ({
            record_type: 'receipt_note', id: rn.id, company_id: rn.company_id,
            voucher_kind: 'receipt_note', vch_type: rn.tally_voucher_type || 'Receipt Note',
            voucher_no: rn.note_no, date: tallyDate(rn.note_date),
            received_date: rn.received_date ? tallyDate(rn.received_date) : null,
            party: rn.supplier, items: itemsByReceiptNote[rn.id] || [],
        }));

        // Detect each company's REAL Sales/Purchase + GST + Round-off ledger names
        // (from its synced vouchers) so a pushed invoice reproduces Tally's EXACT
        // double-entry — Party + Sales/Purchase + C GST/S GST/I GST + Round Off —
        // not just a 2-line total. Names vary per company ("Local Sales", "C GST").
        const ledMap = {};
        for (const co of [...new Set([...invoices, ...returnNoteRows].map((i) => i.company_id))]) {
            const rows = await db('tally_voucher_entries')
                .where('company_id', co).select('ledger_name').count('id as c')
                .groupBy('ledger_name').orderBy('c', 'desc').limit(60);
            const names = rows.map((r) => r.ledger_name || '');
            const find = (re, excl) => names.find((n) => re.test(n) && !(excl && excl.test(n))) || null;
            ledMap[co] = {
                sales:    find(/sales/i, /return|purchase/i) || 'Sales',
                purchase: find(/purchase/i, /return/i) || 'Purchase',
                cgst:     find(/c\s*gst|central\s*tax/i),
                sgst:     find(/s\s*gst|state\s*tax/i),
                igst:     find(/i\s*gst|integ/i),
                roundoff: find(/round/i),
            };
        }
        const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
        const invoiceVouchers = invoices.map((i) => {
            const isPurch = i.type === 'purchase';
            const party = isPurch ? i.supplier : i.customer;
            const total = r2(i.total);
            const L = ledMap[i.company_id] || {};
            const its = itemsByInvoice[i.id] || [];
            // GST breakdown: prefer the stored split, else derive from the items.
            let taxable = Number(i.taxable) || 0;
            let cgst = Number(i.cgst) || 0, sgst = Number(i.sgst) || 0, igst = Number(i.igst) || 0;
            if (!taxable && its.length) {
                taxable = its.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);
                const g = its.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0) * (Number(it.gst_rate) || 0) / 100, 0);
                cgst = sgst = g / 2;
            }
            // Explicit ledger double-entry (only when we have a party + taxable base);
            // otherwise the agent falls back to the simple party+account total form.
            let ledgers = null;
            if (party && taxable > 0) {
                const partyDebit = !isPurch;        // sales: party Dr; purchase: party Cr
                const acctDebit  = !partyDebit;
                ledgers = [
                    { name: party, amount: total, is_debit: partyDebit },
                    { name: isPurch ? L.purchase : L.sales, amount: r2(taxable), is_debit: acctDebit },
                ];
                if (cgst && L.cgst) ledgers.push({ name: L.cgst, amount: r2(cgst), is_debit: acctDebit });
                if (sgst && L.sgst) ledgers.push({ name: L.sgst, amount: r2(sgst), is_debit: acctDebit });
                if (igst && L.igst) ledgers.push({ name: L.igst, amount: r2(igst), is_debit: acctDebit });
                const roundoff = r2(total - taxable - cgst - sgst - igst);
                if (roundoff && L.roundoff) {
                    ledgers.push({ name: L.roundoff, amount: Math.abs(roundoff), is_debit: roundoff < 0 ? partyDebit : acctDebit });
                }
            }
            return {
                record_type: isPurch ? 'purchase_invoice' : 'sales_invoice',
                id: i.id, company_id: i.company_id,
                voucher_kind: isPurch ? 'purchase' : 'sales',
                voucher_no: i.invoice_no, date: tallyDate(i.invoice_date),
                party, amount: total, items: its, ledgers,
            };
        });

        // ── Vouchers: payments + receipts ──
        const pays = await db('payments as pm')
            .whereIn('pm.company_id', companyIds).whereNull('pm.deleted_at')
            .where('pm.status', 'pending_tally')
            .leftJoin('customers as c', 'c.id', 'pm.customer_id')
            .leftJoin('suppliers as s', 'pm.supplier_id', 's.id')
            .limit(50)
            .select('pm.id', 'pm.company_id', 'pm.type', 'pm.voucher_no', 'pm.payment_date',
                    'pm.amount', 'pm.mode', 'c.name as customer', 's.name as supplier');
        const payVouchers = pays.map((p) => ({
            record_type: p.type === 'payment' ? 'payment' : 'receipt',
            id: p.id, company_id: p.company_id, voucher_kind: p.type, // 'payment' | 'receipt'
            voucher_no: p.voucher_no, date: tallyDate(p.payment_date),
            party: p.type === 'payment' ? p.supplier : p.customer,
            amount: Number(p.amount) || 0, mode: p.mode || 'Cash',
        }));

        // ── Vouchers: journals ──
        const journals = await db('journals')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('status', 'pending_tally')
            .limit(50)
            .select('id', 'company_id', 'voucher_no', 'vch_type', 'journal_date', 'dr_ledger', 'cr_ledger', 'amount', 'narration');
        const journalVouchers = journals.map((j) => ({
            // Contra rides the journals table like every other journal-shaped
            // voucher — voucher_kind stays 'journal' (that is what tells the
            // agent which Tally voucher builder to use), but record_type flips
            // to 'contra' for vch_type==='Contra' so the operator's Contra
            // push-toggle (REC2MOD below) actually applies to it.
            record_type: j.vch_type === 'Contra' ? 'contra' : 'journal',
            id: j.id, company_id: j.company_id, voucher_kind: 'journal',
            voucher_no: j.voucher_no, vch_type: j.vch_type || 'Journal', date: tallyDate(j.journal_date),
            dr_ledger: j.dr_ledger, cr_ledger: j.cr_ledger,
            amount: Number(j.amount) || 0, narration: j.narration || '',
        }));

        // ── Vouchers: stock journals (goods voucher — no ledger, no GST) ──
        const stockJournalRows = await db('stock_journals')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('status', 'pending_tally')
            .limit(50)
            .select('id', 'company_id', 'voucher_no', 'journal_date', 'narration');
        const sjIds = stockJournalRows.map((j) => j.id);
        let itemsByStockJournal = {};
        if (sjIds.length) {
            const sjItems = await db('stock_journal_items as it')
                .whereIn('it.stock_journal_id', sjIds)
                .leftJoin('products as p', 'p.id', 'it.product_id')
                .select('it.stock_journal_id', 'it.direction', 'it.godown', 'it.quantity',
                        'p.name as product_name');
            itemsByStockJournal = sjItems.reduce((acc, it) => {
                (acc[it.stock_journal_id] = acc[it.stock_journal_id] || []).push(it);
                return acc;
            }, {});
        }
        const stockJournalVouchers = stockJournalRows.map((j) => {
            const its = itemsByStockJournal[j.id] || [];
            const toLine = (it) => ({ item: it.product_name || 'Item', godown: it.godown || '', qty: Number(it.quantity) || 0 });
            return {
                record_type: 'stock_journal', id: j.id, company_id: j.company_id,
                voucher_kind: 'stock_journal',
                voucher_no: j.voucher_no, date: tallyDate(j.journal_date),
                source_items: its.filter((it) => it.direction === 'source').map(toLine),
                destination_items: its.filter((it) => it.direction === 'destination').map(toLine),
                narration: j.narration || '',
            };
        });

        // ── Vouchers: physical stock (goods voucher — a "sheet" is just the
        // set of stock_adjustments rows sharing one voucher_no; see
        // PhysicalStockController's header comment) ──
        const physicalStockRows = await db('stock_adjustments')
            .whereIn('stock_adjustments.company_id', companyIds)
            .where('stock_adjustments.voucher_kind', 'physical_stock')
            .where('stock_adjustments.status', 'pending_tally')
            .leftJoin('products', 'products.id', 'stock_adjustments.product_id')
            .select('stock_adjustments.company_id', 'stock_adjustments.voucher_no',
                    'stock_adjustments.adjustment_date', 'stock_adjustments.after_qty',
                    'stock_adjustments.godown', 'products.name as product_name');
        const physicalStockByVoucher = physicalStockRows.reduce((acc, r) => {
            const key = `${r.company_id}::${r.voucher_no}`;
            (acc[key] = acc[key] || { company_id: r.company_id, voucher_no: r.voucher_no,
                                       date: r.adjustment_date, items: [] })
                .items.push({ item: r.product_name || 'Item', godown: r.godown || '', qty: Number(r.after_qty) || 0 });
            return acc;
        }, {});
        const physicalStockVouchers = Object.values(physicalStockByVoucher)
            .slice(0, 50)
            .map((v) => ({
                record_type: 'physical_stock', id: v.voucher_no, company_id: v.company_id,
                voucher_kind: 'physical_stock',
                voucher_no: v.voucher_no, date: tallyDate(v.date),
                items: v.items, narration: '',
            }));

        // ── Vouchers: credit / debit notes (rows fetched earlier, ahead of
        // ledMap, so their ledger names are detected too) ──
        const returnNoteVouchers = returnNoteRows.map((i) => {
            const isCredit = i.tally_voucher_type === 'Credit Note';
            const isPurch = i.type === 'purchase';
            const party = isPurch ? i.supplier : i.customer;
            const total = r2(i.total);
            const L = ledMap[i.company_id] || {};
            const its = itemsByReturnNote[i.id] || [];
            let taxable = Number(i.taxable) || 0;
            let cgst = Number(i.cgst) || 0, sgst = Number(i.sgst) || 0, igst = Number(i.igst) || 0;
            if (!taxable && its.length) {
                taxable = its.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);
                const g = its.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0) * (Number(it.gst_rate) || 0) / 100, 0);
                cgst = sgst = g / 2;
            }
            // A note REVERSES the direction of its underlying invoice type: a
            // Credit Note (against a sales invoice) credits the party and
            // debits Sales; a Debit Note (against a purchase invoice) debits
            // the party and credits Purchase — the opposite of what
            // invoiceVouchers computes above for plain sales/purchase.
            let ledgers = null;
            if (party && taxable > 0) {
                const partyDebit = isPurch;         // credit note(sales): party Cr; debit note(purchase): party Dr
                const acctDebit  = !partyDebit;
                ledgers = [
                    { name: party, amount: total, is_debit: partyDebit },
                    { name: isPurch ? L.purchase : L.sales, amount: r2(taxable), is_debit: acctDebit },
                ];
                if (cgst && L.cgst) ledgers.push({ name: L.cgst, amount: r2(cgst), is_debit: acctDebit });
                if (sgst && L.sgst) ledgers.push({ name: L.sgst, amount: r2(sgst), is_debit: acctDebit });
                if (igst && L.igst) ledgers.push({ name: L.igst, amount: r2(igst), is_debit: acctDebit });
                const roundoff = r2(total - taxable - cgst - sgst - igst);
                if (roundoff && L.roundoff) {
                    ledgers.push({ name: L.roundoff, amount: Math.abs(roundoff), is_debit: roundoff < 0 ? partyDebit : acctDebit });
                }
            }
            return {
                record_type: isCredit ? 'credit_note' : 'debit_note',
                id: i.id, company_id: i.company_id,
                voucher_kind: isCredit ? 'credit_note' : 'debit_note',
                voucher_no: i.invoice_no, date: tallyDate(i.invoice_date),
                party, amount: total, items: its, ledgers,
            };
        });

        // Selective AUTO-push filter: drop records whose module the operator did
        // NOT select (pushSel null = ALL → keep everything). record_type → module:
        const REC2MOD = {
            customer: 'customers', supplier: 'suppliers', product: 'products',
            location: 'locations', category: 'categories',
            sales_invoice: 'sales-invoices', purchase_invoice: 'purchase-invoices',
            payment: 'payments', receipt: 'receipts', journal: 'journals',
            // New voucher types (not yet sent by /pending — toggles exist from
            // day one so the operator's choice is already in effect when a
            // later phase starts sending them).
            quotation: 'quotations', sales_order: 'sales-orders',
            purchase_order: 'purchase-orders', delivery_note: 'delivery-notes',
            receipt_note: 'receipt-notes', credit_note: 'credit-notes',
            debit_note: 'debit-notes', contra: 'contra',
            stock_journal: 'stock-journal', physical_stock: 'physical-stock',
        };
        const keep = (r) => SM.isEnabled(pushSel, REC2MOD[r && r.record_type] || '');
        const allVouchers = [...invoiceVouchers, ...payVouchers, ...journalVouchers, ...returnNoteVouchers,
                             ...stockJournalVouchers, ...physicalStockVouchers,
                             ...quotationVouchers, ...salesOrderVouchers, ...purchaseOrderVouchers,
                             ...deliveryNoteVouchers, ...receiptNoteVouchers].filter(keep);

        return R.successResponse(res, {
            companies,
            companies_to_create: companiesToCreate,
            ledgers:     ledgers.filter(keep),
            stock_items: stock_items.filter(keep),
            locations:   locations.filter(keep),
            categories:  categories.filter(keep),
            vouchers:    allVouchers,
        });
    } catch (err) {
        console.error('AgentController.pending error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/result   (authenticateAgent → req.license)
 * Body: { results: [{ record_type, record_id, company_id, status:'synced'|'failed',
 *                     tally_guid?, tally_voucher_no?, message? }] }
 * Applies each result to the source record (so it stops appearing in /pending)
 * and writes a tally_sync_logs audit row.
 */
async function result(req, res) {
    try {
        const results = Array.isArray(req.body && req.body.results) ? req.body.results : [];
        // Only accept results for the FIRST max_companies (syncing) companies —
        // a company over the sync limit must not be pushed/stamped.
        const licRow = await masterDb('licenses').where('id', req.license.id).first('max_companies');
        const maxCompanies = licRow ? licRow.max_companies : null;
        const syncing = await syncingCompanies(req.license.id, maxCompanies, ['id']);
        const allowed = new Set(syncing.map((c) => Number(c.id)));

        let processed = 0;
        let unknown = 0;
        for (const r of results) {
            const cid = Number(r.company_id);
            if (!allowed.has(cid)) continue;          // never touch another license's data
            const now = new Date();
            const synced = r.status === 'synced';
            // A Tally master-import response does NOT return the new master's
            // GUID, so agents historically sent the literal strings 'synced' /
            // 'tally' here just to mark the row as pushed. tally_guid is now a
            // real identity column with a unique index — a placeholder would
            // collide on the second record. Accept ONLY a genuine GUID; the real
            // one arrives on the next PULL, which fetches GUID for every master.
            const guid = (typeof r.tally_guid === 'string'
                && !['synced', 'tally', ''].includes(r.tally_guid.trim().toLowerCase()))
                ? r.tally_guid.trim() : null;
            // Push-state stamp shared by every master branch.
            const pushed = { tally_synced_at: now, tally_dirty: false, updated_at: now };
            if (guid) pushed.tally_guid = guid;

            if (r.record_type === 'customer' || r.record_type === 'supplier') {
                if (synced) {
                    const table = r.record_type === 'customer' ? 'customers' : 'suppliers';
                    await db(table).where({ id: r.record_id, company_id: cid }).update(pushed);
                }
            } else if (r.record_type === 'product') {
                if (synced) {
                    await db('products').where({ id: r.record_id, company_id: cid }).update(pushed);
                }
            } else if (r.record_type === 'sales_invoice' || r.record_type === 'purchase_invoice') {
                // invoices track sync via status + tally_voucher_no (no synced_at column).
                await db('invoices').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'payment' || r.record_type === 'receipt') {
                // Stamp tally_guid too (it was previously omitted, leaving every
                // pushed payment guid-less and so eligible for the importer's
                // content-dedupe path on the next pull).
                await db('payments').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'journal' || r.record_type === 'contra') {
                // Contra rides the journals table (voucher_kind:'journal'); only
                // record_type differs, so both share this branch.
                await db('journals').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'credit_note' || r.record_type === 'debit_note') {
                // Credit/Debit notes live in `invoices` — same update shape as
                // sales_invoice/purchase_invoice above.
                await db('invoices').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'quotation') {
                await db('quotations').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'sales_order') {
                await db('sales_orders').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'purchase_order') {
                await db('purchase_orders').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'delivery_note') {
                await db('delivery_notes').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'receipt_note') {
                await db('receipt_notes').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'stock_journal') {
                await db('stock_journals').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: guid, updated_at: now,
                });
            } else if (r.record_type === 'physical_stock') {
                // No header row — a Physical Stock "sheet" IS the set of
                // stock_adjustments rows sharing this voucher_no (record_id
                // carries the voucher_no here, not a numeric id — see pending()).
                await db('stock_adjustments')
                    .where({ voucher_no: r.record_id, voucher_kind: 'physical_stock', company_id: cid })
                    .update({
                        status: synced ? 'created' : 'failed',
                        tally_voucher_no: r.tally_voucher_no || null,
                        tally_guid: guid, updated_at: now,
                    });
            } else if (r.record_type === 'company') {
                if (synced) {
                    await db('companies').where({ id: r.record_id, license_id: req.license.id })
                        .whereNull('deleted_at').update(pushed);
                }
            } else if (r.record_type === 'location') {
                if (synced) {
                    await db('locations').where({ id: r.record_id, company_id: cid })
                        .whereNull('deleted_at').update(pushed);
                }
            } else if (r.record_type === 'category') {
                // Categories now carry tally_synced_at/tally_dirty (migration 002),
                // so a stock-group push is stamped once and stops re-appearing in
                // /pending — which also makes the audit row below safe to write
                // (previously it would have grown without bound, one row per
                // category per cycle, forever).
                if (synced) {
                    await db('categories').where({ id: r.record_id, company_id: cid })
                        .whereNull('deleted_at').update(pushed);
                }
            } else {
                // An unrecognised record_type must not vanish silently — that
                // would leave rows stuck in /pending forever with nothing to
                // show why. Count it, log it, and move on to the next result.
                console.error(`AgentController.result: unknown record_type '${r.record_type}' (record_id=${r.record_id}, company_id=${cid})`);
                unknown += 1;
                continue;
            }

            // record_id is a bigint column; physical_stock has no numeric id
            // (its record_id carries the voucher_no string instead, since a
            // "sheet" has no header row — see the physical_stock branch
            // above), so a non-numeric id logs as NULL rather than erroring.
            const logRecordId = /^\d+$/.test(String(r.record_id)) ? r.record_id : null;
            await db('tally_sync_logs').insert({
                company_id: cid, module: r.record_type, record_type: r.record_type,
                record_id: logRecordId, direction: 'push',
                status: synced ? 'synced' : 'failed',
                message: r.message || null, retry_count: 0,
                synced_at: synced ? now : null,
            });
            processed += 1;
        }

        return R.successResponse(res, { processed, unknown_record_types: unknown }, 'Results recorded.');
    } catch (err) {
        console.error('AgentController.result error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/import   (authenticateAgent → req.license)
 *
 * Tally → Cloud PULL: the agent reads masters + vouchers from the open Tally
 * company and sends them here to be upserted into the cloud. Body:
 *   { company_id, ledgers:[{name,parent}], stock_items:[{name,closing}],
 *     godowns:[{name}], vouchers:[{vtype,vno,party,amount,date}] }
 * Ledgers are classified by their Tally parent group — "Sundry Debtors" →
 * customers, "Sundry Creditors" → suppliers (system ledgers like Cash / P&L are
 * skipped). Matching is by name (company-scoped, case-insensitive): an existing
 * record is just LINKED (tally_guid set); a new name is INSERTED. Stock items →
 * products; godowns → locations. Vouchers (Day Book) map to payments / invoices
 * / journals: receipt+payment → payments (NULL party FK when Cash/unmatched, so
 * cash is not lost), sales/purchase → invoices, Journal → journals, Credit Note
 * → sales invoice + Debit Note → purchase invoice (returns). Idempotent via
 * tally_voucher_no (vouchers) / lower(name) (godowns). Every import writes a
 * direction:'pull' tally_sync_logs row.
 */
async function importFromTally(req, res) {
    try {
        const licenseId = req.license.id;

        // Selective AUTO-pull: only the operator-selected modules are imported
        // from Tally (null column = ALL). Parsed once; each entity loop below is
        // gated by it. Best-effort read (a hiccup → ALL, never blocks the import).
        const SM = require('../../Helpers/syncModules');
        let pullSel = null;
        try {
            const _lp = await masterDb('licenses').where('id', licenseId).first('sync_pull_modules');
            pullSel = SM.parseModules(_lp && _lp.sync_pull_modules);
        } catch (_) { pullSel = null; }

        // Resolve the target cloud company. Prefer an explicit, valid company_id;
        // otherwise FIND-OR-CREATE by the Tally company NAME under this license —
        // so a Tally company AUTO-CREATES its cloud company on first pull
        // (respecting the license's max_companies cap). 422 if neither is usable.
        const rawId = Number(req.body && req.body.company_id);
        const companyName = String((req.body && req.body.company_name) || '').trim();
        // Tally's STABLE per-company GUID (sent in company_master.guid). The cloud
        // dedups companies on THIS — name is mutable (can go blank or change), so
        // matching on it spawned a duplicate company. Our own placeholders
        // ('tally'/'synced') are NOT real guids, so ignore them here.
        const _cm0    = req.body && req.body.company_master;
        const _rawGuid = String((_cm0 && _cm0.guid) || '').trim();
        const cmGuid  = (_rawGuid && !/^(tally|synced)$/i.test(_rawGuid)) ? _rawGuid : '';
        let cid = null;
        let companyCreated = false;

        // 1) Explicit, owned company_id wins.
        if (rawId) {
            const owned = await db('companies').where({ id: rawId, license_id: licenseId })
                .whereNull('deleted_at').first('id');
            if (owned) cid = owned.id;
        }
        // 2) Match by the STABLE Tally GUID (name-independent — the real dedup key).
        if (!cid && cmGuid) {
            const byGuid = await db('companies').where({ license_id: licenseId, tally_guid: cmGuid })
                .whereNull('deleted_at').first('id', 'name');
            if (byGuid) {
                cid = byGuid.id;
                // Heal a blank-named placeholder by restoring its Tally name.
                if (companyName && !String(byGuid.name || '').trim()) {
                    await db('companies').where('id', cid).update({ name: companyName, updated_at: new Date() });
                }
            }
        }
        // 3) Fall back to a case-insensitive NAME match — then MIGRATE that row onto
        //    the GUID so every later pull matches by guid (step 2) and never twins.
        if (!cid && companyName) {
            const byName = await db('companies').where('license_id', licenseId).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [companyName.toLowerCase()]).first('id', 'tally_guid');
            if (byName) {
                cid = byName.id;
                if (cmGuid && byName.tally_guid !== cmGuid) {
                    await db('companies').where('id', cid).update({ tally_guid: cmGuid, updated_at: new Date() });
                }
            }
        }
        // 4) Nothing matched → CREATE. NEVER create a blank-named company (that is
        //    exactly what produced the duplicate) — require a real company name.
        if (!cid) {
            if (!companyName) {
                return R.errorResponse(res, 'No target company — send company_name (the Tally company) or a valid company_id.', 422);
            }
            const lic = await masterDb('licenses').where('id', licenseId).first('max_companies');
            const [{ c }] = await db('companies').where('license_id', licenseId)
                .whereNull('deleted_at').count({ c: '*' });
            if (lic && lic.max_companies != null && Number(c) >= Number(lic.max_companies)) {
                return R.errorResponse(res,
                    `Company limit reached for this license (max ${lic.max_companies}). Could not add '${companyName}'.`, 422);
            }
            // Unique URL slug derived from the Tally company name.
            const base = (companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '').slice(0, 40)) || 'company';
            let slug = base;
            while (await db('companies').where('slug', slug).first('id')) {
                slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
            }
            const [row] = await db('companies').insert({
                name: companyName, slug, license_id: licenseId, status: 'Active',
                // Stamp the STABLE Tally guid when known — and ONLY when known.
                // The old 'tally' placeholder made every company in a licence share
                // one "guid", so the next pull's guid-dedup matched the wrong
                // company. tally_synced_at (not the guid) is what tells the push
                // side this company already exists in Tally.
                tally_guid: cmGuid || null,
                tally_synced_at: new Date(),
                created_at: new Date(), updated_at: new Date(),
            }).returning('id');
            cid = row.id || row;
            companyCreated = true;
        }

        // SYNC GATE: refuse a pull into a company that is OVER the license sync
        // limit (only the first max_companies, created_at asc, may sync). A
        // just-created company passed the cap check above, so it is in the set.
        const licGate = await masterDb('licenses').where('id', licenseId).first('max_companies');
        const syncSet = await syncingCompanies(licenseId, licGate ? licGate.max_companies : null, ['id']);
        const syncIds = new Set(syncSet.map((c) => Number(c.id)));
        if (!syncIds.has(Number(cid))) {
            return R.errorResponse(res,
                'This company is over the license sync limit (max_companies) and does not sync. Raise the limit to sync it.', 403);
        }

        const ledgers    = Array.isArray(req.body.ledgers) ? req.body.ledgers : [];
        const stockItems = Array.isArray(req.body.stock_items) ? req.body.stock_items : [];
        const vouchers   = Array.isArray(req.body.vouchers) ? req.body.vouchers : [];
        const godowns    = Array.isArray(req.body.godowns) ? req.body.godowns : [];
        const groups     = Array.isArray(req.body.groups) ? req.body.groups : [];
        adbg(`/agent/import RECEIVED  license=${licenseId} company="${companyName}" cid=${cid} -> ` +
             `ledgers=${ledgers.length} stock=${stockItems.length} vouchers=${vouchers.length} godowns=${godowns.length}` +
             (ledgers.length ? `  sampleLedger="${(ledgers[0] && (ledgers[0].name || ledgers[0].Name)) || '?'}"` :
                               `  (0 ledgers — the agent's open Tally company is empty / wrong)`));
        const now = new Date();

        // ── FULL MIRROR: sync the Tally COMPANY MASTER onto the cloud company
        //    record. Only FILL EMPTY fields so a company-admin's manual edits are
        //    NOT clobbered on every pull (page stays editable + both-side). ──
        const cm = req.body.company_master;
        if (cm && typeof cm === 'object' && cid) {
            try {
                const comp = await db('companies').where('id', cid)
                    .first('email', 'mobile', 'phone', 'gst_number', 'pan_number', 'address',
                           'mailing_name', 'state', 'country', 'pincode', 'books_from', 'financial_year');
                const patch = {};
                // Mirror Tally EXACTLY — each field in its own column (no combining),
                // fill-empty only so manual edits + both-side sync are preserved.
                if (cm.email && !comp.email)               patch.email = String(cm.email);
                if (cm.mobile && !comp.mobile)             patch.mobile = String(cm.mobile);
                if (cm.phone && !comp.phone)               patch.phone = String(cm.phone);
                if (cm.gstin && !comp.gst_number)          patch.gst_number = String(cm.gstin);
                if (cm.pan && !comp.pan_number)            patch.pan_number = String(cm.pan);
                if (cm.mailing_name && !comp.mailing_name) patch.mailing_name = String(cm.mailing_name);
                if (cm.state && !comp.state)               patch.state = String(cm.state);
                if (cm.country && !comp.country)           patch.country = String(cm.country);
                if (cm.pincode && !comp.pincode)           patch.pincode = String(cm.pincode);
                if (cm.address && !comp.address)           patch.address = String(cm.address);
                if (cm.books_from && !comp.books_from)     patch.books_from = String(cm.books_from);
                // Derive the "YYYY-YYYY" FY label from the books-from date (Apr–Mar).
                if (cm.books_from && !comp.financial_year) {
                    const m = String(cm.books_from).match(/^(\d{4})-(\d{2})/);
                    if (m) {
                        const y = Number(m[1]), mo = Number(m[2]);
                        const start = mo >= 4 ? y : y - 1;
                        patch.financial_year = `${start}-${start + 1}`;
                    }
                }
                // Registration numbers Tally holds that the cloud had no column
                // for until tenant migration 004.
                for (const [col, val] of [['formal_name', cm.formal_name], ['tan_number', cm.tan],
                                          ['cin_number', cm.cin], ['currency', cm.currency]]) {
                    if (val && await db.schema.hasColumn('companies', col)) patch[col] = String(val);
                }
                // F11 feature flags, stored verbatim. Unlike everything above this
                // is NOT fill-empty: the flags describe what Tally is doing right
                // now, so switching cost centres on must be reflected — it decides
                // which collections the next sync even asks for.
                if (cm.features && typeof cm.features === 'object'
                    && await db.schema.hasColumn('companies', 'tally_features')) {
                    patch.tally_features = JSON.stringify(cm.features);
                }
                // The company's own GUID, once Tally reports it (the row may have
                // been created before GUID capture, or by a web "Add Company").
                if (cm.guid) patch.tally_guid = String(cm.guid);
                if (cm.master_id) patch.tally_master_id = Number(cm.master_id);

                if (Object.keys(patch).length) {
                    patch.updated_at = now;
                    await db('companies').where('id', cid).update(patch);
                }
            } catch (e) { /* best-effort: company master never blocks the import */ }
        }

        // ── Tally's OWN financial reports (Balance Sheet / P&L / Trial Balance),
        //    pulled VERBATIM by the agent — store each as the cloud's EXACT mirror
        //    so /reports shows Tally's figures, not a reconstruction. Upsert per
        //    (company, report_type). Best-effort: never blocks the import. ──
        //    `fy` is '' for this undated pull — the "current period" bucket the
        //    existing screens read. Per-year copies land under their FY label
        //    below, so the two never overwrite each other.
        const storeReports = async (reports, fy) => {
            if (!reports || typeof reports !== 'object' || !cid) return;
            for (const rtype of Object.keys(reports)) {
                const payload = reports[rtype];
                if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) continue;
                try {
                    const rrow = {
                        company_id: cid, report_type: rtype, fy: String(fy || ''),
                        payload: JSON.stringify(payload), synced_at: now,
                    };
                    await db('tally_reports').insert(rrow)
                        .onConflict(['company_id', 'report_type', 'fy']).merge(rrow);
                } catch (e) { /* best-effort: a report store never blocks the import */ }
            }
        };
        await storeReports(req.body.financial_reports, '');

        // ── The same reports per FINANCIAL YEAR ({'2026-27': {...}}), so a
        //    comparative statement has last year to put beside this one. Each is
        //    keyed by its label; an unparseable key is skipped rather than
        //    stored under a wrong year. ──
        const byYear = req.body.financial_reports_by_year;
        if (byYear && typeof byYear === 'object' && cid
            && (await db.schema.hasColumn('tally_reports', 'fy'))) {
            for (const fy of Object.keys(byYear)) {
                if (!/^\d{4}-\d{2}$/.test(fy)) continue;
                await storeReports(byYear[fy], fy);
            }
        }

        // ── SERVER-PUBLISHED reports the agent has no parser for, as RAW Tally
        //    XML keyed by slug ({cash_flow: {raw, label}}). This is the half of
        //    "add a report without shipping an exe" that lands here: the
        //    envelope in config/tallyEnvelopes.json makes the agent ASK, and
        //    storing the answer unparsed means the parser is a change to this
        //    repo, not to every customer's machine.
        //
        //    Stored through the same storeReports path (report_type = slug, so
        //    they never collide with the parsed ones) under the CURRENT period,
        //    matching the undated financial_reports pull above. ──
        const extra = req.body.extra_reports;
        if (extra && typeof extra === 'object' && cid) {
            // Guard the size here rather than trusting the agent: raw XML is
            // unbounded, and one enormous report must not blow up the row or the
            // request log. A truncated report is visible and fixable; an OOM is
            // neither.
            const MAX_RAW = 4 * 1024 * 1024;   // 4 MB of XML per report
            const safe = {};
            for (const slug of Object.keys(extra)) {
                if (!/^[a-z0-9_]{1,64}$/.test(slug)) continue;   // slug, not a path
                const v = extra[slug];
                if (!v || typeof v !== 'object' || typeof v.raw !== 'string') continue;
                if (!v.raw.trim()) continue;
                safe[slug] = {
                    label: typeof v.label === 'string' ? v.label.slice(0, 120) : slug,
                    truncated: v.raw.length > MAX_RAW,
                    raw: v.raw.slice(0, MAX_RAW),
                };
            }
            if (Object.keys(safe).length) await storeReports(safe, '');
        }

        // ── Tally's OWN bill-wise outstanding. Replace-per-side: Tally emits the
        //    complete live list each time, so a bill that has since been settled
        //    must DISAPPEAR — merging would leave paid bills outstanding forever.
        //    Scoped to the side being replaced so a failed Payable read cannot
        //    wipe Receivable. ──
        const outs = req.body.outstandings;
        if (outs && typeof outs === 'object' && cid
            && (await db.schema.hasTable('tally_outstanding_bills'))) {
            // The agent sends ONE flat list; each row carries its own side
            // (derived from Tally's sign). Split here so a side that was read
            // can be replaced without touching a side that was not.
            const allRows = Array.isArray(outs.rows) ? outs.rows : [];
            const bySide = { receivable: [], payable: [] };
            for (const r of allRows) {
                const s = r && r.side === 'payable' ? 'payable' : 'receivable';
                bySide[s].push(r);
            }
            for (const side of ['receivable', 'payable']) {
                const block = { rows: bySide[side], total: null };
                // Nothing pulled at all this cycle → leave BOTH sides untouched
                // rather than deleting the last good snapshot.
                if (!allRows.length) continue;
                // The agent already normalises these to YYYY-MM-DD, but older
                // builds send Tally's raw YYYYMMDD — accept both, and store NULL
                // rather than an invalid date for anything else.
                const day = (v) => {
                    const s = String(v || '').trim();
                    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
                    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
                    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
                };
                try {
                    const rows = block.rows
                        .filter((r) => r && (r.party || r.bill))
                        .map((r) => ({
                            company_id: cid, side, fy: String(r.fy || ''),
                            party: String(r.party || '').slice(0, 255),
                            bill: String(r.bill || '').slice(0, 255),
                            bill_date: day(r.bill_date), due_date: day(r.due_date),
                            amount: Number(r.amount) || 0,
                            overdue_days: Number(r.overdue_days) || 0,
                            synced_at: now,
                        }));
                    await db.transaction(async (trx) => {
                        await trx('tally_outstanding_bills')
                            .where({ company_id: cid, side }).del();
                        for (let i = 0; i < rows.length; i += 500) {
                            await trx('tally_outstanding_bills')
                                .insert(rows.slice(i, i + 500))
                                // Tally can list the same (party, bill, date) twice
                                // across periods; keep one rather than abort the batch.
                                .onConflict(['company_id', 'side', 'fy', 'party', 'bill', 'bill_date'])
                                .ignore();
                        }
                    });
                    adbg(`OUTSTANDING ${side}: stored=${rows.length} total=${block.rows.length}`);
                } catch (e) {
                    adbg(`OUTSTANDING ${side} store failed: ${e.message}`);
                }
            }
        }

        const counts = { customers_new: 0, customers_linked: 0, suppliers_new: 0,
            suppliers_linked: 0, products_new: 0, products_linked: 0,
            masters_updated: 0, vouchers_new: 0, journals_new: 0, locations_new: 0,
            skipped: 0, failed: 0,
            // ── Diagnostic tallies (why a record didn't create a party) so a
            //    "Tally had N but only M synced" case is obvious in the log. ──
            ledgers_recv: 0, stock_recv: 0, groups_recv: 0,
            cust_total: 0, supp_total: 0,   // classified customers/suppliers (new+updated+unchanged)
            unclassified: 0,                // ledger is neither debtor nor creditor (Cash/Bank/P&L/expense — expected)
            unchanged: 0,                   // alterid <= watermark (already synced — expected)
            module_off: 0 };                // pull selection excluded this module
        // Per-record outcomes so the agent can show the pull ONE BY ONE
        // (created / linked / updated). Unchanged records are NOT listed here.
        const details = [];

        // What Tally sent this pull (for the received→stored diagnostic log).
        counts.stock_recv  = stockItems.length;
        counts.groups_recv = groups.length;

        // ── Per-company watermark (the cloud OWNS it). Load or create the
        //    tally_sync_state row; master_alter_id is the largest Tally ALTERID
        //    we've already processed. A master is SKIPPED when its alterid is
        //    present AND <= the watermark (genuinely unchanged). We advance the
        //    watermark to the max alterid seen this pass at the end. ──
        let state = await db('tally_sync_state').where('company_id', cid).first();
        if (!state) {
            await db('tally_sync_state').insert({
                company_id: cid, master_alter_id: 0, voucher_alter_id: 0,
                created_at: now, updated_at: now,
            });
            state = { master_alter_id: 0 };
        }
        const watermark = Number(state.master_alter_id) || 0;
        let maxAlterId = watermark;
        const aid = (v) => {
            const n = Number(v && v.alterid);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };
        // Normalise a numeric-ish value (opening/gst), tolerating Tally junk.
        const num = (v) => {
            const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
            return Number.isFinite(n) ? n : 0;
        };

        // Tally YYYYMMDD → YYYY-MM-DD (best-effort).
        const tdate = (s) => {
            const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})$/);
            return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
        };

        async function logPull(module, recordId, name) {
            await db('tally_sync_logs').insert({
                company_id: cid, module, record_type: module, record_id: recordId || null,
                direction: 'pull', status: 'synced', message: `Imported from Tally: ${name}`,
                retry_count: 0, synced_at: now,
            });
        }

        // Resilience helper: ONE bad record must NEVER abort the whole import.
        // Every record loop below is wrapped so a failure is LOGGED (a 'failed'
        // sync log row the Dashboard shows + console + AGENT_DEBUG) and the import
        // continues with the next record. Never throws (logging can't break sync).
        async function logPullError(module, name, err) {
            const detail = (err && (err.detail || err.message))
                ? String(err.detail || err.message).slice(0, 480) : 'Import error';
            try {
                await db('tally_sync_logs').insert({
                    company_id: cid, module, record_type: module, record_id: null,
                    direction: 'pull', status: 'failed', message: `${name}: ${detail}`,
                    retry_count: 0, synced_at: now,
                });
            } catch (_) { /* logging must never break the import */ }
            try { console.error(`[import] ${module} "${name}" FAILED: ${detail}`); } catch (_) { /* noop */ }
            adbg(`IMPORT FAILED  module=${module} name="${name}" -> ${detail}`);
        }

        /**
         * Upsert one Tally master, keyed on its GUID when we have one.
         *
         * The GUID is rename-stable, the name is not. Keying on name alone (what
         * this did before) meant renaming a ledger in Tally produced a SECOND
         * cloud row and orphaned the first — the old row then lived forever,
         * since nothing ever deletes. Order of attempts:
         *
         *   1. UPDATE ... WHERE tally_guid = guid  → catches renames in place.
         *   2. INSERT ... ON CONFLICT (company_id, name) MERGE → first sight of
         *      this master, or an existing guid-less row adopting its real GUID.
         *
         * Falls back to name-only when Tally returned no GUID (older builds, or a
         * collection where the tag simply isn't populated).
         */
        const upsertMaster = async (table, { guid, masterId, name, row }) => {
            const payload = { ...row };
            if (guid) payload.tally_guid = guid;
            if (masterId) payload.tally_master_id = masterId;

            if (guid) {
                const updated = await db(table)
                    .where({ company_id: cid, tally_guid: guid })
                    .update(payload);
                if (updated) return 'updated';
            }
            await db(table).insert({ ...payload, created_at: now })
                .onConflict(['company_id', 'name']).merge(payload);
            return 'upserted';
        };

        // ── FULL MIRROR: account GROUPS -> tally_groups (Balance Sheet / P&L
        //    hierarchy). Incremental on ALTERID; idempotent via GUID, then name. ──
        for (const g of groups) {
            try {
                const gname = String(g.name || '').trim();
                if (!gname) continue;
                const galter = aid(g);
                if (galter && galter <= watermark) continue;
                if (galter > maxAlterId) maxAlterId = galter;
                const grow = {
                    company_id: cid, name: gname, parent: String(g.parent || ''),
                    // Tally's top-of-tree primary group, for Balance Sheet / P&L
                    // grouping. NOT what classifies cash/bank/debtors/creditors —
                    // that walks `parent` (see Helpers/ledgerGroups.js).
                    primary_group: String(g.primary_group || '') || null,
                    is_revenue: !!g.is_revenue, is_deemed_positive: g.is_deemed_positive !== false,
                    tally_alter_id: galter, updated_at: now,
                };
                await upsertMaster('tally_groups', {
                    guid: g.guid || null, masterId: Number(g.master_id) || null,
                    name: gname, row: grow,
                });
            } catch (e) { /* best-effort */ }
        }

        // ── REGISTRY-DRIVEN MASTERS: units, stock groups/categories, cost
        //    categories/centres, currencies, voucher types, the full StockItem
        //    mirror, budgets, GST/TDS/TCS classifications and payroll. Each is
        //    upserted guid-first exactly like ledgers, so the reconcile pass
        //    (delete-sync) works on all of them with no extra code. ──
        const masters = (req.body && typeof req.body.masters === 'object' && req.body.masters) || {};
        for (const [kind, rows] of Object.entries(masters)) {
            const spec = MASTER_TABLES[kind];
            if (!spec || !Array.isArray(rows) || !rows.length) continue;
            if (!(await db.schema.hasTable(spec.table))) continue;   // migration not applied yet
            let wrote = 0;
            for (const m of rows) {
                try {
                    const mname = String(m.name || '').trim();
                    if (!mname) continue;
                    const malter = aid(m);
                    if (malter && malter <= watermark) continue;     // unchanged
                    if (malter > maxAlterId) maxAlterId = malter;

                    const row = { company_id: cid, name: mname, tally_alter_id: malter, updated_at: now };
                    for (const col of spec.columns) {
                        if (m[col] === undefined) continue;
                        // Tally dates arrive as YYYYMMDD; everything else passes through.
                        row[col] = (spec.dates || []).includes(col) ? tdate(m[col]) : m[col];
                    }
                    await upsertMaster(spec.table, {
                        guid: m.guid || null, masterId: Number(m.master_id) || null,
                        name: mname, row,
                    });
                    wrote += 1;
                } catch (e) {
                    counts.failed = (counts.failed || 0) + 1;
                    await logPullError(kind, String((m && m.name) || '?'), e);
                }
            }
            counts.masters_updated += wrote;
            adbg(`MASTERS ${kind}: received=${rows.length} written=${wrote}`);
        }

        // ── FULL MIRROR: upsert EVERY ledger (all groups, not just debtors/
        //    creditors) into tally_ledgers with its opening balance + GSTIN. This
        //    is the account-level data the Trial Balance / Balance Sheet / Ledger
        //    statement are derived from. Incremental on ALTERID; idempotent via
        //    (company_id, name). Best-effort per ledger. ──
        for (const l of ledgers) {
            try {
                const lname = String(l.name || '').trim();
                if (!lname) continue;
                const lalter = aid(l);
                if (lalter && lalter <= watermark) continue;   // unchanged -> skip
                if (lalter > maxAlterId) maxAlterId = lalter;
                const opening = parseFloat(String(l.opening || '0').replace(/[^0-9.\-]/g, '')) || 0;
                // Tally's AUTHORITATIVE current balance (opening + all postings +
                // inventory valuation). Reports use this for an EXACT match instead
                // of reconstructing opening + Σ(postings), which drifts when an
                // opening balance is incomplete or stock is involved.
                const closing = parseFloat(String(l.closing || '0').replace(/[^0-9.\-]/g, '')) || 0;
                const row = {
                    company_id: cid, name: lname, parent: String(l.parent || ''),
                    opening_balance: opening, closing_balance: closing, gstin: l.gstin || null,
                    tally_alter_id: lalter, updated_at: now,
                };
                await upsertMaster('tally_ledgers', {
                    guid: l.guid || null, masterId: Number(l.master_id) || null,
                    name: lname, row,
                });

                // Nested ledger lists. A flat FETCH cannot carry a repeating
                // list, which is why the bank columns on tally_ledgers were
                // always empty and opening balances were a single lump.
                // Replace-by-ledger keeps a re-pull idempotent.
                if (Array.isArray(l.bank_details)) {
                    await db('tally_ledger_bank_details')
                        .where({ company_id: cid, ledger_name: lname }).del();
                    const brows = l.bank_details.map((b, i) => ({
                        company_id: cid, ledger_name: lname, line_no: i,
                        account_no: b.account_no || null, ifsc: b.ifsc || null,
                        bank_name: b.bank_name || null, branch: b.branch || null,
                        account_holder: b.account_holder || null, created_at: now,
                    }));
                    if (brows.length) await db('tally_ledger_bank_details').insert(brows);
                }
                if (Array.isArray(l.opening_bills)) {
                    await db('tally_ledger_opening_bills')
                        .where({ company_id: cid, ledger_name: lname }).del();
                    const obrows = l.opening_bills.map((b, i) => {
                        const bdate = tdate(b.bill_date);
                        return {
                            company_id: cid, ledger_name: lname, line_no: i,
                            bill_name: b.bill_name || null,
                            bill_date: bdate,
                            amount: Number(b.amount) || 0,
                            credit_period_days: b.credit_period_days != null ? Number(b.credit_period_days) : null,
                            // Derive the due date so ageing an OPENING bill is the
                            // same date comparison as ageing a transacted one.
                            due_date: (bdate && b.credit_period_days != null)
                                ? new Date(new Date(bdate).getTime()
                                    + Number(b.credit_period_days) * 86400000)
                                    .toISOString().slice(0, 10)
                                : null,
                            created_at: now,
                        };
                    });
                    if (obrows.length) await db('tally_ledger_opening_bills').insert(obrows);
                }
            } catch (e) { /* best-effort: one bad ledger never aborts the import */ }
        }

        // Resolve the company's primary location ONCE so every customer pulled
        // from Tally gets assigned to it (Tally ledgers carry no location/godown,
        // but the cloud needs one for location-wise filtering). Prefer the Tally
        // godown, else the oldest location.
        const _mainLoc = await db('locations').where('company_id', cid).whereNull('deleted_at')
            .orderByRaw('is_tally_godown desc, id asc').first('id');
        const mainLocationId = _mainLoc ? _mainLoc.id : null;

        // Classify a ledger as customer/supplier by walking its GROUP ANCESTRY,
        // not just its direct parent's NAME. In Tally, customers commonly sit
        // under SUB-groups of "Sundry Debtors" (e.g. "Local Sales", "Retail",
        // "Debtors North") whose own name has no "debtor" — matching only the
        // direct parent name silently dropped them (the "500 customers but only
        // 127 synced" bug). Build a group name→parent map from the synced groups
        // and follow the chain up until a Sundry Debtors/Creditors ancestor is
        // hit. Falls back to a direct-name check when groups aren't available
        // (older agent), so there is no regression.
        const _groupParent = new Map();
        for (const g of groups) {
            const gn = String(g.name || '').trim().toLowerCase();
            if (gn) _groupParent.set(gn, String(g.parent || '').trim().toLowerCase());
        }
        const _classify = (directParent) => {
            let cur = String(directParent || '').trim().toLowerCase();
            const seen = new Set();
            let hops = 0;
            while (cur && !seen.has(cur) && hops < 60) {
                if (cur.includes('debtor')) return 'customers';
                if (cur.includes('creditor')) return 'suppliers';
                seen.add(cur);
                cur = _groupParent.get(cur) || '';
                hops += 1;
            }
            return null;
        };

        counts.ledgers_recv = ledgers.length;
        for (const l of ledgers) {
          try {
            const name = String(l.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }
            const table = _classify(l.parent);
            if (!table) { counts.skipped += 1; counts.unclassified += 1; continue; }   // Cash/Bank/P&L/expense — expected
            if (table === 'customers') counts.cust_total += 1; else counts.supp_total += 1;
            // Selective AUTO-pull: skip this party if its module wasn't selected.
            if (!SM.isEnabled(pullSel, table)) { counts.skipped += 1; counts.module_off += 1; continue; }

            const alterId = aid(l);
            // Incremental: an unchanged master (alterid present AND <= watermark)
            // is skipped without a DB hit. New/changed masters fall through.
            if (alterId && alterId <= watermark) { counts.skipped += 1; counts.unchanged += 1; continue; }
            if (alterId > maxAlterId) maxAlterId = alterId;

            const gstin = l.gstin ? String(l.gstin).trim() : null;
            const opening = num(l.opening);

            const lguid = l.guid ? String(l.guid).trim() : null;
            const _selCols = ['id', 'name', 'tally_guid', 'tally_synced_at', 'gst_number',
                              'opening_balance', 'mobile', 'email', 'pan_number'];
            if (table === 'customers') _selCols.push('billing_address', 'credit_limit', 'location_id');
            else if (table === 'suppliers') _selCols.push('address', 'location_id');
            // GUID first, name second. The GUID survives a rename in Tally, so
            // matching on it updates the party in place; matching only on name
            // (the old behaviour) created a duplicate and left the original
            // stranded forever, since nothing in the pull ever deletes.
            let existing = null;
            if (lguid) {
                existing = await db(table).where({ company_id: cid, tally_guid: lguid })
                    .whereNull('deleted_at').first(..._selCols);
            }
            if (!existing) {
                existing = await db(table).where('company_id', cid).whereNull('deleted_at')
                    .whereRaw('lower(name) = ?', [name.toLowerCase()])
                    .first(..._selCols);
            }
            if (existing) {
                // UPDATE the synced fields when Tally's value actually differs
                // (so a GST/opening change in Tally reaches the cloud). Always
                // ensure the link is set. Log only on a real change.
                const upd = {};
                if (gstin && gstin !== (existing.gst_number || '')) upd.gst_number = gstin;
                if (Number(existing.opening_balance) !== opening) upd.opening_balance = opening;
                // Adopt the real GUID/MASTERID (the row may predate GUID capture),
                // and follow a rename in Tally through to the cloud name.
                if (lguid && existing.tally_guid !== lguid) upd.tally_guid = lguid;
                if (l.master_id) upd.tally_master_id = Number(l.master_id);
                if (lguid && existing.name !== name) upd.name = name;
                // A party that came back from Tally is by definition in Tally —
                // stamp it so /pending never queues it for a redundant push.
                // Only when unset: an unconditional write here would make `upd`
                // non-empty for EVERY ledger, defeating the "already in sync →
                // no write, no log spam" branch below.
                if (!existing.tally_synced_at) upd.tally_synced_at = now;
                // Fill-empty the party fields Tally now sends (mobile/email/PAN +
                // customer billing address / credit limit / location).
                if (l.mobile && !existing.mobile) upd.mobile = String(l.mobile);
                if (l.email && !existing.email)   upd.email = String(l.email);
                if (l.pan && !existing.pan_number) upd.pan_number = String(l.pan);
                if (table === 'customers') {
                    if (l.address && !existing.billing_address) upd.billing_address = String(l.address);
                    if (l.credit_limit && !existing.credit_limit) upd.credit_limit = num(l.credit_limit);
                    if (mainLocationId && !existing.location_id) upd.location_id = mainLocationId;
                } else if (table === 'suppliers') {
                    if (l.address && !existing.address) upd.address = String(l.address);
                    if (mainLocationId && !existing.location_id) upd.location_id = mainLocationId;
                }

                const ttype = table === 'customers' ? 'customer' : 'supplier';
                if (Object.keys(upd).length) {
                    upd.updated_at = now;
                    await db(table).where('id', existing.id).update(upd);
                    // HISTORY (best-effort): Tally changed this master. before =
                    // the snapshot we read; after = before + the applied changes.
                    await recordHistory(db, {
                        company_id: cid, module: table, record_type: ttype,
                        record_id: existing.id, action: 'updated', source: 'tally',
                        before: existing, after: { ...existing, ...upd },
                        changed_by: null, note: 'Tally sync',
                    });
                    if (!existing.tally_guid) {
                        counts[table === 'customers' ? 'customers_linked' : 'suppliers_linked'] += 1;
                        details.push({ type: ttype, name, action: 'linked' });
                    } else {
                        counts.masters_updated += 1;
                        details.push({ type: ttype, name, action: 'updated' });
                    }
                    await logPull(ttype, existing.id, name);
                } else {
                    counts.skipped += 1;   // already in sync → no write, no log spam
                }
            } else {
                const insertRow = {
                    company_id: cid, name, status: 'Active', is_tally_ledger: true,
                    tally_guid: lguid, tally_master_id: Number(l.master_id) || null,
                    tally_synced_at: now,
                    gst_number: gstin, opening_balance: opening,
                    created_at: now, updated_at: now,
                };
                // Common party fields Tally now sends.
                if (l.mobile) insertRow.mobile = String(l.mobile);
                if (l.email)  insertRow.email = String(l.email);
                if (l.pan)    insertRow.pan_number = String(l.pan);
                // Location (Tally ledgers carry none) + address into the right column.
                if (table === 'customers') {
                    if (mainLocationId)  insertRow.location_id = mainLocationId;
                    if (l.address)       insertRow.billing_address = String(l.address);
                    if (l.credit_limit)  insertRow.credit_limit = num(l.credit_limit);
                } else if (table === 'suppliers') {
                    if (mainLocationId)  insertRow.location_id = mainLocationId;
                    if (l.address)       insertRow.address = String(l.address);
                }
                const [row] = await db(table).insert(insertRow).returning('id');
                const newId = row.id || row;
                const ttype = table === 'customers' ? 'customer' : 'supplier';
                // HISTORY (best-effort): a new master pulled from Tally.
                await recordHistory(db, {
                    company_id: cid, module: table, record_type: ttype,
                    record_id: newId, action: 'created', source: 'tally',
                    before: null, after: { id: newId, ...insertRow },
                    changed_by: null, note: 'Tally sync',
                });
                counts[table === 'customers' ? 'customers_new' : 'suppliers_new'] += 1;
                details.push({ type: ttype, name, action: 'created' });
                await logPull(ttype, newId, name);
            }
          } catch (err) {
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('customer/supplier', String((l && l.name) || '?'), err);
          }
        }

        // Resolve a Tally stock group (PARENT) → cloud category, find-or-create,
        // cached per pass. Skip Tally's default top group "Primary".
        const _catCache = new Map();
        const resolveCategoryId = async (parentName) => {
            const nm = String(parentName || '').trim();
            if (!nm || nm.toLowerCase() === 'primary') return null;
            const key = nm.toLowerCase();
            if (_catCache.has(key)) return _catCache.get(key);
            let cat = await db('categories').where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [key]).first('id');
            if (!cat) {
                // Came FROM a Tally stock group, so it already exists there —
                // stamp tally_synced_at or /pending would push it straight back.
                const [r] = await db('categories')
                    .insert({ company_id: cid, name: nm, tally_synced_at: now,
                              created_at: now, updated_at: now })
                    .returning('id');
                cat = { id: r.id || r };
            }
            _catCache.set(key, cat.id);
            return cat.id;
        };

        // Selective AUTO-pull: skip Products entirely when not selected.
        for (const s of (SM.isEnabled(pullSel, 'products') ? stockItems : [])) {
          try {
            const name = String(s.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }

            const alterId = aid(s);
            if (alterId && alterId <= watermark) { counts.skipped += 1; continue; }
            if (alterId > maxAlterId) maxAlterId = alterId;

            const closing = num(s.closing);
            const unit = s.unit ? String(s.unit).trim() : null;
            const hsn = s.hsn ? String(s.hsn).trim() : null;
            const salesPrice = num(s.sales_price);
            const purchasePrice = num(s.purchase_price);
            const gstRate = num(s.gst_rate);
            const categoryId = await resolveCategoryId(s.parent);

            // GST rate SLABS. `products.gst_rate` holds one number, which is
            // wrong for any item whose rate changed mid-year — the slab history
            // is what a period-correct return needs. Replace-by-item.
            if (Array.isArray(s.gst_slabs) && await db.schema.hasTable('tally_stock_item_gst_rates')) {
                try {
                    await db('tally_stock_item_gst_rates')
                        .where({ company_id: cid, stock_item: name }).del();
                    const grows = s.gst_slabs.map((g, i) => ({
                        company_id: cid, stock_item: name, line_no: i,
                        applicable_from: tdate(g.applicable_from),
                        hsn_code: g.hsn_code || null, taxability: g.taxability || null,
                        rate: num(g.rate), cgst: num(g.cgst), sgst: num(g.sgst),
                        igst: num(g.igst), cess: num(g.cess), created_at: now,
                    }));
                    if (grows.length) await db('tally_stock_item_gst_rates').insert(grows);
                } catch (e) { adbg(`gst slabs failed for "${name}": ${e.message}`); }
            }

            // Nested StockItem lists — opening batches, price list rates and the
            // bill of materials. Replace-by-item, so a re-pull overwrites.
            for (const [table, rows, build, key] of [
                ['tally_batches', s.batches, (b, i) => ({
                    company_id: cid, name: `${name} / ${b.batch_name}`,
                    stock_item: name, godown: b.godown || null,
                    manufactured_on: tdate(b.manufactured_on), expires_on: tdate(b.expires_on),
                    opening_qty: num(b.opening_qty), tally_alter_id: alterId,
                    updated_at: now, created_at: now, _i: i,
                }), 'stock_item'],
                ['tally_price_lists', s.price_list, (p, i) => ({
                    company_id: cid, name: `${name} / ${p.price_level || 'Default'} / ${i}`,
                    stock_item: name, price_level: p.price_level || null,
                    applicable_from: tdate(p.applicable_from),
                    from_qty: num(p.from_qty), to_qty: p.to_qty != null ? num(p.to_qty) : null,
                    rate: num(p.rate), discount: num(p.discount),
                    tally_alter_id: alterId, updated_at: now, created_at: now, _i: i,
                }), 'stock_item'],
                ['tally_bom_components', s.bom, (b, i) => ({
                    company_id: cid, name: `${name} / ${b.component_item}`,
                    parent_item: name, component_item: b.component_item,
                    qty: num(b.qty), godown: b.godown || null,
                    tally_alter_id: alterId, updated_at: now, created_at: now, _i: i,
                }), 'parent_item'],
            ]) {
                if (!Array.isArray(rows) || !rows.length) continue;
                if (!(await db.schema.hasTable(table))) continue;
                try {
                    await db(table).where({ company_id: cid, [key]: name }).del();
                    const built = rows.map(build).map(({ _i, ...r }) => r);
                    if (built.length) await db(table).insert(built);
                } catch (e) { adbg(`${table} failed for "${name}": ${e.message}`); }
            }

            // GUID first, then name — see the customer/supplier lookup above.
            const sguid = s.guid ? String(s.guid).trim() : null;
            const _pCols = ['id', 'name', 'tally_guid', 'tally_synced_at', 'unit', 'hsn_code',
                            'opening_stock', 'sales_price', 'purchase_price', 'gst_rate', 'category_id'];
            let existing = null;
            if (sguid) {
                existing = await db('products').where({ company_id: cid, tally_guid: sguid })
                    .whereNull('deleted_at').first(..._pCols);
            }
            if (!existing) {
                existing = await db('products').where('company_id', cid).whereNull('deleted_at')
                    .whereRaw('lower(name) = ?', [name.toLowerCase()]).first(..._pCols);
            }
            if (existing) {
                const upd = {};
                if (unit && unit !== (existing.unit || '')) upd.unit = unit;
                if (hsn && hsn !== (existing.hsn_code || '')) upd.hsn_code = hsn;
                if (Number(existing.opening_stock) !== closing) upd.opening_stock = closing;
                if (salesPrice && Number(existing.sales_price) !== salesPrice) upd.sales_price = salesPrice;
                if (purchasePrice && Number(existing.purchase_price) !== purchasePrice) upd.purchase_price = purchasePrice;
                if (gstRate && Number(existing.gst_rate) !== gstRate) upd.gst_rate = gstRate;
                if (categoryId && !existing.category_id) upd.category_id = categoryId;
                if (sguid && existing.tally_guid !== sguid) upd.tally_guid = sguid;
                if (s.master_id) upd.tally_master_id = Number(s.master_id);
                if (sguid && existing.name !== name) upd.name = name;   // follow a Tally rename
                if (!existing.tally_synced_at) upd.tally_synced_at = now;

                if (Object.keys(upd).length) {
                    upd.updated_at = now;
                    await db('products').where('id', existing.id).update(upd);
                    // HISTORY (best-effort): Tally changed this product.
                    await recordHistory(db, {
                        company_id: cid, module: 'products', record_type: 'product',
                        record_id: existing.id, action: 'updated', source: 'tally',
                        before: existing, after: { ...existing, ...upd },
                        changed_by: null, note: 'Tally sync',
                    });
                    if (!existing.tally_guid) {
                        counts.products_linked += 1;
                        details.push({ type: 'product', name, action: 'linked' });
                    } else {
                        counts.masters_updated += 1;
                        details.push({ type: 'product', name, action: 'updated' });
                    }
                    await logPull('product', existing.id, name);
                } else {
                    counts.skipped += 1;
                }
            } else {
                const insertRow = {
                    company_id: cid, name, status: 'Active', is_tally_item: true,
                    tally_guid: sguid, tally_master_id: Number(s.master_id) || null,
                    tally_synced_at: now,
                    unit: unit || 'Nos', hsn_code: hsn, opening_stock: closing,
                    purchase_price: purchasePrice, sales_price: salesPrice, gst_rate: gstRate,
                    category_id: categoryId || null, created_at: now, updated_at: now,
                };
                const [row] = await db('products').insert(insertRow).returning('id');
                const newId = row.id || row;
                // HISTORY (best-effort): a new product pulled from Tally.
                await recordHistory(db, {
                    company_id: cid, module: 'products', record_type: 'product',
                    record_id: newId, action: 'created', source: 'tally',
                    before: null, after: { id: newId, ...insertRow },
                    changed_by: null, note: 'Tally sync',
                });
                counts.products_new += 1;
                details.push({ type: 'product', name, action: 'created' });
                await logPull('product', newId, name);
            }
          } catch (err) {
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('product', String((s && s.name) || '?'), err);
          }
        }

        // ── Godowns → locations. Each Tally godown becomes a location row
        //    (is_tally_godown=true) carrying its real GUID/MASTERID. Idempotent
        //    by GUID, then by lower(name) per company. ──
        // Selective AUTO-pull: skip Locations (godowns) when not selected.
        for (const g of (SM.isEnabled(pullSel, 'locations') ? godowns : [])) {
          try {
            const name = String(g.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }
            const gguid = g.guid ? String(g.guid).trim() : null;

            let existing = null;
            if (gguid) {
                existing = await db('locations').where({ company_id: cid, tally_guid: gguid })
                    .whereNull('deleted_at').first('id', 'name');
            }
            if (!existing) {
                existing = await db('locations').where('company_id', cid).whereNull('deleted_at')
                    .whereRaw('lower(name) = ?', [name.toLowerCase()]).first('id', 'name');
            }
            if (existing) {
                // Adopt the identity (and any rename) rather than skipping
                // outright — a guid-less legacy location must still learn its GUID
                // or the reconcile pass could never match, and would delete it.
                const upd = { tally_synced_at: now, updated_at: now };
                if (gguid) upd.tally_guid = gguid;
                if (g.master_id) upd.tally_master_id = Number(g.master_id);
                if (gguid && existing.name !== name) upd.name = name;
                await db('locations').where('id', existing.id).update(upd);
                counts.skipped += 1;
                continue;
            }

            const insertRow = {
                company_id: cid, name, status: 'Active',
                is_tally_godown: true, tally_guid: gguid,
                tally_master_id: Number(g.master_id) || null, tally_synced_at: now,
                created_at: now, updated_at: now,
            };
            const [row] = await db('locations').insert(insertRow).returning('id');
            const newId = row.id || row;
            // HISTORY (best-effort): a new location (godown) pulled from Tally.
            await recordHistory(db, {
                company_id: cid, module: 'locations', record_type: 'location',
                record_id: newId, action: 'created', source: 'tally',
                before: null, after: { id: newId, ...insertRow },
                changed_by: null, note: 'Tally sync',
            });
            counts.locations_new += 1;
            details.push({ type: 'location', name, action: 'created' });
            await logPull('location', newId, name);
          } catch (err) {
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('location', String((g && g.name) || '?'), err);
          }
        }

        // ── Vouchers (Day Book): receipts/payments → payments, sales/purchase
        //    → invoices, Journal → journals, Credit/Debit Note → sales/purchase
        //    invoice (returns captured as the matching invoice type). Party is
        //    matched by name; an unmatched/Cash party leaves the party FK NULL
        //    (the value is still recorded — cash transactions are not dropped).
        //    Idempotent via tally_voucher_no. ──
        for (const v of vouchers) {
          // Per-voucher guard: ONE bad/duplicate voucher must never abort the whole
          // pull (a single duplicate purchase no. was 500-ing the entire import, so
          // masters synced but NO vouchers did). A unique-violation (23505) = already
          // imported -> skip; any OTHER error still propagates so real bugs surface.
          try {
            const vt = String(v.vtype || '').toLowerCase();
            const vno = String(v.vno || '').trim();
            const amount = Number(v.amount) || 0;
            const date = tdate(v.date);
            const partyName = String(v.party || '').trim();
            const guid = String((v && v.guid) || '').trim();
            // Voucher total = the SUM of the PARTY side (a sale DEBITS the customer/
            // cash, a purchase CREDITS the supplier). This equals Tally's Sales/
            // Purchase-Register value EXACTLY (verified to the rupee): a split
            // payment sums its Cash+Bank legs, a discounted bill gives the net the
            // party owes (the gross sale is a credit, excluded), and a cancelled
            // net-zero voucher correctly totals 0. The party side is chosen by
            // isSales below; compute both sums here. (Unreliable: v.amount — a
            // sub-ledger value for some vouchers; max-abs — misses split payments.)
            const _vEntries = Array.isArray(v.entries) ? v.entries : [];
            // EXCLUDE round-off: it is a separate balancing posting on the party's
            // side (a credit on purchases), so summing it would inflate the bill
            // total by the rounding. The party ledger already carries the rounded
            // net — verified to the paisa on both registers.
            const _isRound = (e) => /round/i.test(String((e && e.ledger) || ''));
            const _sumAbs = (arr) => arr.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0);
            const _debitSum  = _sumAbs(_vEntries.filter((e) => e.is_debit && !_isRound(e)));
            const _creditSum = _sumAbs(_vEntries.filter((e) => !e.is_debit && !_isRound(e)));

            // ── FULL MIRROR: the voucher HEADER + every nested allocation.
            //    This runs BEFORE the entries/inventory blocks because the child
            //    tables FK to tally_vouchers(company_id, guid) — and before any
            //    classification skip, so EVERY voucher type is mirrored (delivery
            //    note, stock journal, order, payroll …), not just the three that
            //    map onto invoices/payments/journals. ──
            if (guid) {
                try {
                    const vhead = {
                        company_id: cid, guid,
                        tally_master_id: Number(v.master_id) || null,
                        tally_alter_id: Number(v.alterid) || 0,
                        voucher_key: v.voucher_key || null,
                        voucher_date: date || null,
                        effective_date: tdate(v.effective_date) || null,
                        voucher_type: v.vtype || null,
                        voucher_no: vno || null,
                        reference: v.reference || null,
                        reference_date: tdate(v.reference_date) || null,
                        party_ledger: partyName || null,
                        party_gstin: v.party_gstin || null,
                        place_of_supply: v.place_of_supply || null,
                        state: v.state || null,
                        country: v.country || null,
                        narration: v.narration || null,
                        amount,
                        is_invoice: !!v.is_invoice,
                        is_optional: !!v.is_optional,
                        is_cancelled: !!v.is_cancelled,
                        is_post_dated: !!v.is_post_dated,
                        has_cashflow: !!v.has_cashflow,
                        entered_by: v.entered_by || null,
                        dispatch_doc_no: v.dispatch_doc_no || null,
                        dispatch_through: v.dispatch_through || null,
                        destination: v.destination || null,
                        carrier_name: v.carrier_name || null,
                        bill_of_lading: v.bill_of_lading || null,
                        vehicle_number: v.vehicle_number || null,
                        order_reference: v.order_reference || null,
                        deleted_at: null,
                        updated_at: now,
                    };
                    await db('tally_vouchers').insert({ ...vhead, created_at: now })
                        .onConflict(['company_id', 'guid']).merge(vhead);

                    // Allocations are replace-by-voucher: delete then re-insert, so
                    // re-pulling an AlterID window (which the agent does whenever a
                    // cycle is interrupted) overwrites instead of duplicating.
                    const allocRows = {
                        tally_bill_allocations: (v.bill_allocations || []).map((b, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            ledger_name: String(b.ledger || partyName || '').trim() || null,
                            bill_name: b.bill_name || null,
                            bill_type: b.bill_type || null,
                            amount: Number(b.amount) || 0,
                            credit_period_days: b.credit_period_days != null ? Number(b.credit_period_days) : null,
                            bill_date: tdate(b.bill_date) || null,
                            // Tally gives a credit PERIOD, not a due date; derive it
                            // so ageing is a plain date comparison.
                            due_date: (date && b.credit_period_days != null)
                                ? new Date(new Date(date).getTime()
                                    + Number(b.credit_period_days) * 86400000)
                                    .toISOString().slice(0, 10)
                                : null,
                        })).filter((r) => r.ledger_name),
                        tally_batch_allocations: (v.batch_allocations || []).map((b, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            item_name: String(b.item || '').trim(),
                            batch_name: b.batch_name || null,
                            godown: b.godown || null,
                            destination_godown: b.destination_godown || null,
                            actual_qty: Number(b.actual_qty) || 0,
                            billed_qty: Number(b.billed_qty) || 0,
                            amount: Number(b.amount) || 0,
                            manufactured_on: tdate(b.manufactured_on) || null,
                            expires_on: tdate(b.expires_on) || null,
                            tracking_no: b.tracking_no || null,
                            order_no: b.order_no || null,
                        })).filter((r) => r.item_name),
                        tally_cost_allocations: (v.cost_allocations || []).map((c, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            ledger_name: c.ledger || null,
                            cost_category: c.cost_category || null,
                            cost_centre: String(c.cost_centre || '').trim(),
                            amount: Number(c.amount) || 0,
                        })).filter((r) => r.cost_centre),
                        tally_bank_allocations: (v.bank_allocations || []).map((b, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            ledger_name: b.ledger || null,
                            instrument_no: b.instrument_no || null,
                            instrument_date: tdate(b.instrument_date) || null,
                            transaction_type: b.transaction_type || null,
                            bank_name: b.bank_name || null,
                            payment_favouring: b.payment_favouring || null,
                            unique_reference: b.unique_reference || null,
                            status: b.status || null,
                            bank_date: tdate(b.bank_date) || null,
                        })),
                        tally_eway_bills: (v.eway_bills || []).map((b, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            ewb_number: b.ewb_number || null,
                            ewb_date: tdate(b.ewb_date) || null,
                            valid_until: tdate(b.valid_until) || null,
                            status: b.status || null,
                            transporter_name: b.transporter_name || null,
                            transporter_id: b.transporter_id || null,
                            vehicle_number: b.vehicle_number || null,
                            vehicle_type: b.vehicle_type || null,
                            transport_mode: b.transport_mode || null,
                            doc_number: b.doc_number || null,
                            doc_date: tdate(b.doc_date) || null,
                            distance_km: Number(b.distance_km) || null,
                            from_place: b.from_place || null, from_state: b.from_state || null,
                            to_place: b.to_place || null, to_state: b.to_state || null,
                        })).filter((r) => r.ewb_number),
                        tally_einvoice_details: (v.einvoice || []).map((e, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            irn: e.irn || null,
                            ack_number: e.ack_number || null,
                            ack_date: tdate(e.ack_date) || null,
                            signed_qr_code: e.signed_qr_code || null,
                            status: e.status || null,
                            cancelled_date: tdate(e.cancelled_date) || null,
                            cancel_reason: e.cancel_reason || null,
                        })).filter((r) => r.irn),
                        tally_inventory_accounting_allocations: (v.inventory_accounting || []).map((a, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            item_name: a.item || null,
                            ledger_name: String(a.ledger || '').trim(),
                            amount: Number(a.amount) || 0,
                            is_debit: !!a.is_debit,
                        })).filter((r) => r.ledger_name),
                        tally_voucher_gst_details: (v.gst_details || []).map((g, i) => ({
                            company_id: cid, voucher_guid: guid, line_no: i,
                            item_name: g.item || null,
                            ledger_name: g.ledger || null,
                            hsn_code: g.hsn_code || null,
                            taxable_value: Number(g.taxable_value) || 0,
                            rate: Number(g.rate) || 0,
                            cgst: Number(g.cgst) || 0, sgst: Number(g.sgst) || 0,
                            igst: Number(g.igst) || 0, cess: Number(g.cess) || 0,
                        })),
                    };
                    for (const [table, rows] of Object.entries(allocRows)) {
                        await db(table).where({ company_id: cid, voucher_guid: guid }).del();
                        if (rows.length) await db(table).insert(rows);
                    }
                } catch (e) {
                    // Best-effort, like every other mirror block: a malformed
                    // allocation must never cost us the voucher itself.
                    adbg(`voucher mirror failed guid=${guid}: ${e.message}`);
                }
            }

            // ── FULL MIRROR: store this voucher's COMPLETE double-entry (every
            //    ledger debit/credit) into tally_voucher_entries BEFORE any skip,
            //    so even Contra / zero-party vouchers feed the Trial Balance /
            //    Balance Sheet / P&L / Ledger statement. Replace-by-GUID = idempotent
            //    (re-pull overwrites, never duplicates). ──
            if (guid && Array.isArray(v.entries) && v.entries.length) {
                try {
                    await db('tally_voucher_entries').where({ company_id: cid, voucher_guid: guid }).del();
                    const erows = v.entries.map((e, i) => ({
                        company_id: cid, voucher_guid: guid, voucher_type: v.vtype || null,
                        voucher_no: vno || null, voucher_date: date || null,
                        // line_no preserves Tally's entry ORDER and, with
                        // (company_id, voucher_guid), forms the unique key that
                        // makes a concurrent re-import impossible to duplicate.
                        line_no: i,
                        ledger_name: String(e.ledger || '').trim(),
                        amount: Number(e.amount) || 0, is_debit: !!e.is_debit,
                        // Which LEG this is, stated by Tally rather than guessed
                        // from the ledger's name (the totals code regex-matches
                        // /round/i on the name to exclude round-off).
                        is_party_ledger: !!e.is_party_ledger,
                        ledger_from_item: !!e.ledger_from_item,
                        amount_rate: e.amount_rate || null,
                        tally_alter_id: Number(v.alterid) || 0, created_at: now,
                    })).filter((r) => r.ledger_name);
                    if (erows.length) await db('tally_voucher_entries').insert(erows);
                } catch (e) { /* best-effort: entries never block the import */ }
            }
            // FULL MIRROR: inventory movement -> tally_inventory_entries (Stock value).
            if (guid && Array.isArray(v.inventory) && v.inventory.length) {
                try {
                    await db('tally_inventory_entries').where({ company_id: cid, voucher_guid: guid }).del();
                    const irows = v.inventory.map((it, i) => ({
                        company_id: cid, voucher_guid: guid, voucher_date: date || null,
                        line_no: i,
                        item_name: String(it.item || '').trim(),
                        qty: Number(it.qty) || 0, rate: Number(it.rate) || 0,
                        amount: Number(it.amount) || 0,
                        // ACTUAL drives stock valuation, BILLED drives invoice
                        // value; they differ on shortages and free issues.
                        billed_qty: Number(it.billed_qty != null ? it.billed_qty : it.qty) || 0,
                        actual_qty: Number(it.actual_qty != null ? it.actual_qty : it.qty) || 0,
                        discount: Number(it.discount) || 0,
                        unit: it.unit || null,
                        tracking_no: it.tracking_no || null,
                        order_no: it.order_no || null,
                        order_due_date: tdate(it.order_due_date) || null,
                        is_deemed_positive: !!it.is_deemed_positive,
                        // The godown column has existed since the table was created
                        // but was never populated — so every godown-wise stock
                        // report had nothing to group by.
                        godown: it.godown ? String(it.godown).trim() : null,
                        created_at: now,
                    })).filter((r) => r.item_name);
                    if (irows.length) await db('tally_inventory_entries').insert(irows);
                } catch (e) { /* best-effort */ }
            }

            if (!amount || !vno) { counts.skipped += 1; continue; }

            // GUID idempotency: the Tally voucher GUID is the STABLE unique key
            // (voucher NUMBERS repeat - purchases reuse the supplier bill no). If
            // this exact voucher was already imported (invoices/journals carry the
            // guid), skip it - so re-pulling an AlterID window is harmless.
            if (guid) {
                const already = await db('invoices').where({ company_id: cid, tally_guid: guid }).first('id')
                             || await db('journals').where({ company_id: cid, tally_guid: guid }).first('id');
                if (already) { counts.skipped += 1; continue; }
            }

            // Per-iteration history capture state (set by the payment/invoice
            // insert branches below; read by the shared recordHistory call).
            let newVoucherId = null;
            let voucherAfter = null;

            const isReceipt = vt.indexOf('receipt') > -1;
            const isPayment = vt.indexOf('payment') > -1;
            // A Credit Note is a sales return; a Debit Note a purchase return.
            // The cloud has no return type, so capture each as the matching
            // invoice type (Credit Note → sales, Debit Note → purchase).
            const isCreditNote = vt.indexOf('credit') > -1;
            const isDebitNote = vt.indexOf('debit') > -1;
            const isJournal = vt.indexOf('journal') > -1;
            // Plain sales/purchase vouchers. Exclude credit/debit notes which
            // also contain neither 'sales' nor 'purchase' but are handled above.
            const isSales = vt.indexOf('sales') > -1 || isCreditNote;
            const isPurchase = vt.indexOf('purchase') > -1 || isDebitNote;

            // Selective AUTO-pull: skip creating the BUSINESS record (journal /
            // payment / receipt / invoice) when that voucher's module wasn't
            // selected. The full double-entry mirror (tally_voucher_entries above)
            // was already stored so Reports still match Tally exactly.
            const _vMod = isJournal ? 'journals'
                : isReceipt ? 'receipts' : isPayment ? 'payments'
                : isSales ? 'sales-invoices' : isPurchase ? 'purchase-invoices' : null;
            if (_vMod && !SM.isEnabled(pullSel, _vMod)) { counts.skipped += 1; continue; }

            if (isJournal) {
                // Journal voucher → journals table. DEDUP BY GUID (Tally reuses
                // numbers). dr_ledger / cr_ledger = the largest debit / credit
                // posting; amount = party-side debit sum (excl round-off).
                const dup = guid
                    ? await db('journals').where({ company_id: cid, tally_guid: guid }).whereNull('deleted_at').first('id')
                    : await db('journals').where({ company_id: cid, tally_voucher_no: vno }).whereNull('deleted_at').first('id');
                if (dup) { counts.skipped += 1; continue; }
                // journal_date is NOT NULL; tdate() returns null for an unparseable
                // Tally date, so fall back to today rather than aborting the import.
                const journalDate = date || now.toISOString().slice(0, 10);
                const journalNo = (vno && vno.trim()) ? vno : (guid ? `JV/${guid.slice(-8)}` : vno);
                const _topLedger = (wantDebit) => {
                    const arr = _vEntries.filter((e) => !!e.is_debit === wantDebit && !_isRound(e))
                        .sort((a, b) => Math.abs(Number(b.amount) || 0) - Math.abs(Number(a.amount) || 0));
                    return arr.length ? arr[0].ledger : '';
                };
                const journalAmount = _vEntries.length ? _debitSum : Math.abs(amount);
                // CONTENT dedupe — cloud-PUSHED journals only (no guid): link a
                // pushed journal to its re-pulled Tally twin instead of duplicating.
                const contentDup = await db('journals')
                    .where({ company_id: cid, journal_date: journalDate, amount: journalAmount })
                    .whereNull('deleted_at').whereNull('tally_guid').first('id');
                if (contentDup) { counts.skipped += 1; continue; }
                const insertRow = {
                    company_id: cid, voucher_no: journalNo, vch_type: 'Journal',
                    journal_date: journalDate,
                    dr_ledger: _topLedger(true) || partyName || '(unknown)',
                    cr_ledger: _topLedger(false) || '',
                    amount: journalAmount,
                    narration: null, status: 'created',
                    tally_voucher_no: vno, tally_guid: guid || null,
                    created_at: now, updated_at: now,
                };
                const [row] = await db('journals').insert(insertRow).returning('id');
                const newId = row.id || row;
                // HISTORY (best-effort): a journal voucher created from Tally.
                await recordHistory(db, {
                    company_id: cid, module: 'journals', record_type: 'journal',
                    record_id: newId, action: 'created', source: 'tally',
                    before: null, after: { id: newId, ...insertRow },
                    changed_by: null, note: 'Tally sync',
                });
                counts.journals_new += 1;
                details.push({ type: 'journal', name: `Journal ${vno}`, action: 'created' });
                await logPull('journal', newId, `Journal ${vno}`);
                continue;
            }

            if (!isReceipt && !isPayment && !isSales && !isPurchase) { counts.skipped += 1; continue; }

            // Resolve the party to a customer (receipt/sales/credit note) or
            // supplier (payment/purchase/debit note). Unmatched (e.g. Cash/Bank,
            // or a party that isn't a cloud customer/supplier) → NULL FK, but
            // the voucher is STILL recorded so the value is not lost.
            const partyTable = (isReceipt || isSales) ? 'customers' : 'suppliers';
            let partyId = null;
            if (partyName) {
                const party = await db(partyTable).where('company_id', cid).whereNull('deleted_at')
                    .whereRaw('lower(name) = ?', [partyName.toLowerCase()]).first('id');
                if (party) partyId = party.id;
            }

            if (isReceipt || isPayment) {
                const type = isReceipt ? 'receipt' : 'payment';
                // amount = the money moved = party-side debit sum (excl round-off),
                // matching the register total. DEDUP BY GUID (Tally reuses receipt/
                // payment voucher numbers); empty vno → a GUID-derived number.
                const payAmount = _vEntries.length ? _debitSum : Math.abs(amount);
                const payVoucherNo = (vno && vno.trim()) ? vno : (guid ? `PV/${guid.slice(-8)}` : vno);
                const dup = guid
                    ? await db('payments').where({ company_id: cid, type, tally_guid: guid }).whereNull('deleted_at').first('id')
                    : await db('payments').where({ company_id: cid, type, tally_voucher_no: vno }).whereNull('deleted_at').first('id');
                if (dup) { counts.skipped += 1; continue; }
                // CONTENT dedupe: a payment/receipt already pushed cloud→Tally is
                // already a cloud row; Tally auto-numbers so its vno never matches
                // our voucher_no. Skip if a non-deleted same (company_id, type,
                // party id-or-null, date, amount) payment already exists so it is
                // not re-imported as a duplicate.
                const payPartyCol = isReceipt ? 'customer_id' : 'supplier_id';
                // Guard on tally_guid IS NULL: only dedupe against a cloud-PUSHED
                // payment (which has a cloud voucher_no + tally_voucher_no but NO
                // guid). NEVER against another imported Tally voucher, so distinct
                // cash receipts sharing (date, amount, party) all import. This
                // links a pushed payment back to its Tally twin on re-pull (no dup).
                const contentDup = await db('payments')
                    .where({ company_id: cid, type, payment_date: date, amount: payAmount,
                             [payPartyCol]: partyId })
                    .whereNull('deleted_at').whereNull('tally_guid').first('id');
                if (contentDup) { counts.skipped += 1; continue; }
                const payRow = {
                    company_id: cid, type, voucher_no: payVoucherNo, payment_date: date,
                    amount: payAmount, mode: 'Cash', status: 'created', tally_voucher_no: vno,
                    tally_guid: guid || null,
                    party_type: partyId ? (isReceipt ? 'customer' : 'supplier') : null,
                    [isReceipt ? 'customer_id' : 'supplier_id']: partyId,
                    created_at: now, updated_at: now,
                };
                const [pr] = await db('payments').insert(payRow).returning('id');
                newVoucherId = pr ? (pr.id || pr) : null;
                voucherAfter = newVoucherId != null ? { id: newVoucherId, ...payRow } : payRow;
            } else {
                const type = isSales ? 'sales' : 'purchase';
                // PARTY-side total: sales → sum of debits (customer/cash), purchase
                // → sum of credits (supplier). A net-zero (cancelled) voucher totals
                // 0 — keep it. Fall back to |v.amount| only when the voucher carries
                // NO postings at all.
                const voucherTotal = _vEntries.length ? (isSales ? _debitSum : _creditSum) : Math.abs(amount);
                // DEDUP BY GUID — the real voucher identity. Tally REUSES bill
                // numbers (purchase bills especially), so invoice_no is NOT unique
                // for synced rows (migration 0053). Re-import of the same voucher
                // (same GUID) = skip; a different voucher that happens to share the
                // bill no still imports. Empty vno → a GUID-derived number so the
                // cloud-side unique index never collides.
                const invoiceNo = (vno && vno.trim())
                    ? vno
                    : (guid ? `${isSales ? 'SAL' : 'PUR'}/${guid.slice(-8)}` : vno);
                const dup = guid
                    ? await db('invoices').where({ company_id: cid, type, tally_guid: guid }).first('id')
                    : await db('invoices').where({ company_id: cid, type, invoice_no: invoiceNo }).first('id');
                if (dup) { counts.skipped += 1; continue; }
                // CONTENT dedupe: an invoice already pushed cloud→Tally is already
                // a cloud row; Tally auto-numbers so its vno never matches our
                // invoice_no. Skip if a non-deleted same (company_id, type, party
                // id-or-null, date, total) invoice already exists so it is not
                // re-imported as a duplicate.
                const invPartyCol = isSales ? 'customer_id' : 'supplier_id';
                // CONTENT dedupe applies ONLY to a cloud-PUSHED invoice (no
                // tally_guid yet) — that is the one case where Tally auto-numbers
                // so the vno never matches our invoice_no. It must NOT fire against
                // another already-imported TALLY voucher: distinct retail cash
                // sales legitimately share (date, total, party=Cash), and matching
                // them would silently drop every duplicate-looking bill (this lost
                // ~471 RETAIL CASH SALES). Guarding on tally_guid IS NULL keeps the
                // push-dedupe but lets every distinct Tally voucher import.
                const contentDup = await db('invoices')
                    .where({ company_id: cid, type, invoice_date: date, total: voucherTotal,
                             [invPartyCol]: partyId })
                    .whereNull('deleted_at').whereNull('tally_guid').first('id');
                if (contentDup) { counts.skipped += 1; continue; }
                const invRow = {
                    company_id: cid, type, invoice_no: invoiceNo, invoice_date: date,
                    [isSales ? 'customer_id' : 'supplier_id']: partyId,
                    taxable: voucherTotal, cgst: 0, sgst: 0, igst: 0, tax_amount: 0, total: voucherTotal,
                    status: 'created', tally_voucher_no: vno, tally_guid: guid || null,
                    tally_voucher_type: v.vtype || null,
                    // OPTIONAL drafts / CANCELLED vouchers are excluded from Tally's
                    // registers — flag them so the cloud register matches exactly.
                    tally_optional: !!(v.is_optional || v.is_cancelled),
                    created_at: now, updated_at: now,
                };
                const [ir] = await db('invoices').insert(invRow).returning('id');
                newVoucherId = ir ? (ir.id || ir) : null;
                voucherAfter = newVoucherId != null ? { id: newVoucherId, ...invRow } : invRow;
            }
            const label = isReceipt ? 'receipt' : isPayment ? 'payment'
                : isCreditNote ? 'sales invoice (credit note)'
                : isDebitNote ? 'purchase invoice (debit note)'
                : isSales ? 'sales invoice' : 'purchase invoice';
            const logModule = isReceipt ? 'receipt' : isPayment ? 'payment'
                : isSales ? 'sales_invoice' : 'purchase_invoice';
            // History module slug (route-style) for this voucher kind.
            const histModule = isReceipt ? 'receipts' : isPayment ? 'payments'
                : isSales ? 'sales-invoices' : 'purchase-invoices';
            const histType = isReceipt ? 'receipt' : isPayment ? 'payment'
                : isSales ? 'sales-invoice' : 'purchase-invoice';
            // HISTORY (best-effort): a voucher created from Tally.
            await recordHistory(db, {
                company_id: cid, module: histModule, record_type: histType,
                record_id: newVoucherId, action: 'created', source: 'tally',
                before: null, after: voucherAfter,
                changed_by: null, note: 'Tally sync',
            });
            counts.vouchers_new += 1;
            details.push({ type: label, name: `${v.vtype} ${vno}`, action: 'created' });
            await logPull(logModule, newVoucherId, `${v.vtype} ${vno}`);
          } catch (vErr) {
            // A duplicate (already-imported) voucher → silent skip. ANY other error
            // is LOGGED and the pull keeps going (one bad voucher must not abort the rest).
            if (vErr && vErr.code === '23505') { counts.skipped += 1; continue; }
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('voucher', String((v && (String(v.vtype || '') + ' ' + (v.vno || ''))) || '?'), vErr);
            continue;
          }
        }

        // Advance the per-company watermark to the largest ALTERID seen this
        // pass (so unchanged masters are skipped next cycle) + stamp last_pull_at.
        const stateUpd = { last_pull_at: now, updated_at: now };
        if (maxAlterId > watermark) stateUpd.master_alter_id = maxAlterId;
        await db('tally_sync_state').where('company_id', cid).update(stateUpd);

        counts.company_id = cid;
        counts.company_created = companyCreated;
        counts.master_alter_id = Math.max(maxAlterId, watermark);
        counts.details = details;          // per-record outcomes for one-by-one display
        adbg(`/agent/import RESULT    company="${companyName}" cid=${cid} created=${companyCreated} -> ` +
             `cust_new=${counts.customers_new} supp_new=${counts.suppliers_new} prod_new=${counts.products_new} ` +
             `updated=${counts.masters_updated} vouchers_new=${counts.vouchers_new} journals_new=${counts.journals_new} ` +
             `locations_new=${counts.locations_new} skipped=${counts.skipped}`);

        // ── ALWAYS-ON per-module diagnostic (daily file api/logs/) so a
        //    "Tally had N but only M synced" gap is obvious per module: how many
        //    records Tally SENT vs how many the cloud STORED vs WHY the rest were
        //    skipped (unclassified = correctly-ignored Cash/Bank/P&L; unchanged =
        //    already synced; module_off = pull toggle off). ──
        logger.sync(
            `[import] "${companyName}" cid=${cid}${companyCreated ? ' (created)' : ''} | ` +
            `LEDGERS recv=${counts.ledgers_recv} -> customers=${counts.cust_total} ` +
            `(new ${counts.customers_new}, linked ${counts.customers_linked}), ` +
            `suppliers=${counts.supp_total} (new ${counts.suppliers_new}, linked ${counts.suppliers_linked}), ` +
            `unclassified=${counts.unclassified}, unchanged=${counts.unchanged}, module_off=${counts.module_off} | ` +
            `STOCK recv=${counts.stock_recv} -> products new=${counts.products_new} | ` +
            `GROUPS recv=${counts.groups_recv} | ` +
            `VOUCHERS new=${counts.vouchers_new}, JOURNALS new=${counts.journals_new}, ` +
            `LOCATIONS new=${counts.locations_new} | updated=${counts.masters_updated}, failed=${counts.failed}`,
        );
        return R.successResponse(res, counts, 'Imported from Tally.');
    } catch (err) {
        console.error('AgentController.importFromTally error:', err);
        // Surface the REAL cause to the agent log (it used to return a generic
        // "Oops" that hid the actual DB / constraint error), so a failed pull is
        // diagnosable in the field instead of guessing.
        const detail = (err && (err.detail || err.message))
            ? String(err.detail || err.message).slice(0, 300) : 'unknown error';
        // Also record the failure in the dedicated sync log (with company context).
        try { logger.syncError(`[import] FAILED company="${req.body && req.body.company_name}" -> ${detail}`, err); } catch (_) {}
        return R.errorResponse(res, `Import failed: ${detail}`, 500);
    }
}

/**
 * GET /api/v1/agent/commands   (authenticateAgent → req.license)
 *
 * The agent polls this each cycle to drain its command queue. In ONE
 * transaction we claim up to 10 'pending' rows for THIS agent's license:
 * select … FOR UPDATE (orderBy id), then flip them to 'running' + picked_at=now,
 * so two concurrent agents / a re-poll never run the same command twice.
 *
 * Each returned command flattens company_name / company_number out of the JSON
 * payload (null-safe) so the agent never has to parse payload itself.
 */
async function getCommands(req, res) {
    try {
        const now = new Date();
        // SYNC GATE: a command that targets a specific company is only served
        // when that company is within the license's first max_companies (the
        // syncing set). Company-less commands (company_id NULL, e.g. self_update)
        // always pass. Computed on-the-fly from max_companies.
        const licRow = await masterDb('licenses').where('id', req.license.id).first('max_companies');
        const maxCompanies = licRow ? licRow.max_companies : null;
        const syncing = await syncingCompanies(req.license.id, maxCompanies, ['id']);
        const allowedCompanyIds = syncing.map((c) => Number(c.id));

        const claimed = await db.transaction(async (trx) => {
            const rows = await trx('agent_commands')
                .where({ license_id: req.license.id, status: 'pending' })
                .where((b) => {
                    b.whereNull('company_id');
                    if (allowedCompanyIds.length) b.orWhereIn('company_id', allowedCompanyIds);
                })
                .orderBy('id', 'asc')
                .limit(10)
                .forUpdate()
                .select('id', 'type', 'company_id', 'payload');

            if (rows.length) {
                const ids = rows.map((r) => r.id);
                await trx('agent_commands')
                    .whereIn('id', ids)
                    .update({ status: 'running', picked_at: now, updated_at: now });
            }
            return rows;
        });

        const commands = claimed.map((r) => {
            let name = null;
            let number = null;
            if (r.payload) {
                try {
                    const p = JSON.parse(r.payload);
                    if (p && typeof p === 'object') {
                        name = p.company_name != null ? p.company_name : null;
                        number = p.company_number != null ? p.company_number : null;
                    }
                } catch {
                    // Malformed payload → leave name/number null; the command id
                    // + type still reach the agent so it can fail-report it.
                }
            }
            return {
                id: r.id,
                type: r.type,
                company_id: r.company_id,
                company_name: name,
                company_number: number,
            };
        });

        return R.successResponse(res, { commands });
    } catch (err) {
        console.error('AgentController.getCommands error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/commands/:id/result   (authenticateAgent → req.license)
 * Body: { status:'done'|'failed', result?, error? }
 *
 * The agent reports a command's outcome. Scoped to a row owned by THIS agent's
 * license (so an agent can never close another license's command). Unknown
 * status values are coerced to 'failed' so a row never gets stuck in 'running'.
 */
async function commandResult(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return R.errorResponse(res, 'Invalid command id.', 422);
        }
        const status = (req.body && req.body.status) === 'done' ? 'done' : 'failed';
        const result = req.body && req.body.result != null ? String(req.body.result) : null;
        const error  = req.body && req.body.error  != null ? String(req.body.error)  : null;

        const updated = await db('agent_commands')
            .where({ id, license_id: req.license.id })
            .update({ status, result, error, updated_at: new Date() });

        if (!updated) {
            return R.errorResponse(res, 'Command not found.', 404);
        }
        return R.successResponse(res, undefined, 'ok');
    } catch (err) {
        console.error('AgentController.commandResult error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * GET /api/v1/agent/version   (authenticateAgent → req.license)
 *
 * Tells the agent what the published-latest exe is so it can decide whether to
 * self-update. Source of truth = the single agent_releases row with
 * is_current=true (a super-admin publishes it). Falls back to the env
 * AGENT_LATEST_VERSION (or null) when nothing is published yet.
 *
 * Response data:
 *   { latest_version, current, download_url, sha256, mandatory, notes,
 *     auto_update }
 *   • latest_version — the published version string (or null = nothing to do)
 *   • current        — true when the agent's reported version already matches
 *                      latest (so it need not download)
 *   • download_url   — relative path the agent GETs the exe from
 *   • mandatory      — a security release the agent applies even if auto_update is OFF
 *   • auto_update    — the per-LICENSE cloud toggle (Requirement 3). The agent
 *                      treats this as the authoritative on/off when present.
 *
 * Never throws to the client — any error returns a safe "nothing to update"
 * shape so a release-table hiccup can NEVER brick a working agent.
 */
async function getVersion(req, res) {
    try {
        // The agent reports its installed version via ?agent_version= (or header);
        // used only to compute the convenience `current` flag.
        const installed = String((req.query && req.query.agent_version) || '').trim();

        let rel = null;
        try {
            rel = await agentRelease.currentRelease(masterDb);
        } catch (e) {
            rel = null;   // table missing / DB hiccup → behave as "no release".
        }

        const latestVersion = rel ? rel.version
            : (String(process.env.AGENT_LATEST_VERSION || '').trim() || null);

        // Per-license cloud toggle (default ON when the column/row is unreadable).
        let autoUpdate = true;
        try {
            const lic = await masterDb('licenses').where('id', req.license.id).first('auto_update');
            if (lic && lic.auto_update != null) autoUpdate = !!lic.auto_update;
        } catch (e) {
            autoUpdate = true;
        }

        return R.successResponse(res, {
            latest_version: latestVersion,
            current: !!(latestVersion && installed && installed === latestVersion),
            download_url: '/api/v1/agent/download',
            sha256: rel ? (rel.sha256 || null) : null,
            mandatory: rel ? !!rel.mandatory : false,
            notes: rel ? (rel.notes || null) : null,
            auto_update: autoUpdate,
        }, 'ok');
    } catch (err) {
        console.error('AgentController.getVersion error:', err);
        // Safe fallback — never let this crash the agent's update check.
        return R.successResponse(res, {
            latest_version: null, current: true, download_url: '/api/v1/agent/download',
            sha256: null, mandatory: false, notes: null, auto_update: true,
        }, 'ok');
    }
}

/**
 * GET /api/v1/agent/download   (authenticateAgent → req.license)
 *
 * Streams the CURRENT release exe from AGENT_RELEASE_DIR/<filename>. 404 (in the
 * envelope) when there is no current release or the file is missing on disk.
 * The path is built from path.basename(stored filename) only (see
 * agentRelease.resolveFile), so a crafted filename can never path-traverse.
 */
async function download(req, res) {
    try {
        const rel = await agentRelease.currentRelease(masterDb);
        if (!rel || !rel.filename) {
            return R.errorResponse(res, 'No agent release is currently published.', 404);
        }
        const filePath = agentRelease.resolveFile(rel.filename);
        if (!filePath) {
            return R.errorResponse(res, 'Release file name is invalid.', 404);
        }

        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (e) {
            return R.errorResponse(res, 'Release file not found on the server.', 404);
        }
        if (!stat.isFile()) {
            return R.errorResponse(res, 'Release file not found on the server.', 404);
        }

        const downloadName = path.basename(rel.filename);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        if (rel.sha256) res.setHeader('X-Agent-Sha256', String(rel.sha256));
        res.setHeader('X-Agent-Version', String(rel.version || ''));

        const stream = fs.createReadStream(filePath);
        stream.on('error', (e) => {
            console.error('AgentController.download stream error:', e);
            // Headers may already be sent (binary streaming); just tear down.
            if (!res.headersSent) {
                return R.errorResponse(res, 'Could not read the release file.', 500);
            }
            res.destroy(e);
        });
        return stream.pipe(res);
    } catch (err) {
        console.error('AgentController.download error:', err);
        if (!res.headersSent) {
            return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
        }
        return res.end();
    }
}

// ── Generic master ingestion ─────────────────────────────────
/**
 * kind → { table, columns } for every registry-driven master the agent sends
 * under `masters` (see agent/tally_schema.py). This mirrors that registry: a new
 * master needs an entry HERE and a table in a tenant migration, and no new
 * handler code — which is exactly why only five masters ever existed before.
 *
 * `columns` is an allow-list. The agent is trusted (licence-authenticated) but
 * the payload still reaches a raw knex insert, so writing only known columns
 * keeps a stale/rogue agent from probing the schema — and means an agent that
 * is NEWER than the server degrades by dropping unknown fields instead of 500ing
 * every sync until the server catches up.
 */
const MASTER_TABLES = {
    unit:               { table: 'tally_units',               columns: ['original_name', 'is_simple', 'base_units', 'additional_units', 'conversion', 'decimal_places'] },
    stock_group:        { table: 'tally_stock_groups',        columns: ['parent', 'is_addable'] },
    stock_category:     { table: 'tally_stock_categories',    columns: ['parent'] },
    cost_category:      { table: 'tally_cost_categories',     columns: ['allocate_revenue', 'allocate_non_revenue'] },
    cost_centre:        { table: 'tally_cost_centres',        columns: ['parent', 'category'] },
    currency:           { table: 'tally_currencies',          columns: ['symbol', 'formal_name', 'mailing_name', 'decimal_places', 'is_suffixed', 'has_space', 'decimal_symbol'] },
    voucher_type:       { table: 'tally_voucher_types',       columns: ['parent', 'numbering_method', 'is_deemed_positive', 'affects_stock', 'use_for_pos', 'is_active'] },
    stock_item_full:    { table: 'tally_stock_items',         columns: ['parent', 'category', 'base_units', 'additional_units', 'hsn_code', 'gst_rate', 'costing_method', 'valuation_method', 'is_batchwise', 'has_mfg_date', 'is_perishable', 'is_cost_tracking', 'reorder_level', 'minimum_order_qty', 'opening_qty', 'opening_rate', 'opening_value', 'closing_qty', 'closing_rate', 'closing_value', 'standard_price', 'standard_cost'] },
    price_level:        { table: 'tally_price_levels',        columns: [] },
    budget:             { table: 'tally_budgets',             columns: ['parent', 'period_from', 'period_to'], dates: ['period_from', 'period_to'] },
    tax_unit:           { table: 'tally_tax_units',           columns: ['gstin', 'state', 'registration_type', 'applicable_from', 'is_default'], dates: ['applicable_from'] },
    gst_classification: { table: 'tally_gst_classifications', columns: ['hsn_code', 'rate', 'taxability', 'applicable_from'], dates: ['applicable_from'] },
    tds_category:       { table: 'tally_tds_categories',      columns: ['section_number', 'payment_code'] },
    tds_rate:           { table: 'tally_tds_rates',           columns: ['category', 'deductee_type', 'applicable_from', 'rate', 'surcharge', 'cess', 'zero_rate_reason', 'exemption_limit'], dates: ['applicable_from'] },
    tcs_category:       { table: 'tally_tcs_categories',      columns: ['section_number', 'rate'] },
    employee_group:     { table: 'tally_employee_groups',     columns: ['parent'] },
    employee:           { table: 'tally_employees',           columns: ['parent', 'employee_code', 'designation', 'date_of_joining', 'date_of_release', 'bank_name', 'bank_account_no', 'ifsc', 'pan_number', 'pf_account', 'esi_number'], dates: ['date_of_joining', 'date_of_release'] },
    attendance_type:    { table: 'tally_attendance_types',    columns: ['parent', 'attendance_period', 'production_type'] },
    pay_head:           { table: 'tally_pay_heads',           columns: ['parent', 'pay_head_type', 'calculation_type', 'calculation_period', 'affects_net_salary'] },
};

// ── Delete sync ──────────────────────────────────────────────
/**
 * Which cloud tables mirror each Tally master kind, and how a row is recognised
 * as "came from Tally". The reconcile pass only ever soft-deletes rows that
 * carry a Tally identity — a cloud-native customer that was never in Tally is
 * untouchable here, no matter what Tally does or does not list.
 */
const RECONCILE_TARGETS = {
    ledger:     [{ table: 'tally_ledgers' },
                 { table: 'customers', flag: 'is_tally_ledger' },
                 { table: 'suppliers', flag: 'is_tally_ledger' }],
    group:      [{ table: 'tally_groups' }],
    stock_item: [{ table: 'products', flag: 'is_tally_item' }],
    godown:     [{ table: 'locations', flag: 'is_tally_godown' }],
    // Every registry-driven master reconciles against its own table. Derived
    // from MASTER_TABLES rather than restated, so a master added there gets
    // delete-sync for free instead of quietly never being reconciled.
    ...Object.fromEntries(Object.entries(MASTER_TABLES)
        .map(([kind, spec]) => [kind, [{ table: spec.table }]])),
};

/**
 * POST /api/v1/agent/reconcile   (authenticateAgent → req.license)
 *
 * Tally → Cloud DELETE detection. Body:
 *   { company_id | company_name, kind: 'ledger'|'group'|'stock_item'|'godown',
 *     master_ids: [301, 302, …], guids: ['…'], complete: true, dry_run?: bool }
 *
 * Tally's XML API emits no tombstones — a deleted master simply stops appearing
 * in its collection. So the agent periodically sends the FULL live id list for
 * one kind and we soft-delete every Tally-sourced row whose identity is absent
 * from it (a set difference).
 *
 * Two safety rails, because a wrong answer here deletes real books:
 *   • `complete` must be true. A partial/failed Tally read must never be read
 *     as "everything was deleted".
 *   • An EMPTY id list is refused outright. Tally returning nothing is far more
 *     likely to be a bad request or a closed company than a company whose every
 *     ledger was genuinely deleted.
 */
async function reconcile(req, res) {
    try {
        const licenseId = req.license.id;
        const body = req.body || {};
        const kind = String(body.kind || '').trim();
        const targets = RECONCILE_TARGETS[kind];
        if (!targets) return R.errorResponse(res, `Unknown reconcile kind "${kind}".`, 422);

        const masterIds = Array.isArray(body.master_ids)
            ? body.master_ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0) : [];
        const guids = Array.isArray(body.guids)
            ? body.guids.map((g) => String(g || '').trim()).filter(Boolean) : [];

        if (body.complete !== true) {
            return R.errorResponse(res, 'Refusing to reconcile from an incomplete Tally read.', 422);
        }
        if (!masterIds.length && !guids.length) {
            // See the doc comment: an empty list is treated as a failed read.
            return R.errorResponse(res, 'Refusing to reconcile against an empty master list.', 422);
        }

        // Resolve + gate the company exactly as the import path does.
        const licRow = await masterDb('licenses').where('id', licenseId).first('max_companies');
        const syncSet = await syncingCompanies(licenseId, licRow ? licRow.max_companies : null, ['id', 'name']);
        let cid = Number(body.company_id) || null;
        if (!cid && body.company_name) {
            const match = syncSet.find((c) => String(c.name || '').toLowerCase()
                === String(body.company_name).trim().toLowerCase());
            cid = match ? Number(match.id) : null;
        }
        if (!cid || !syncSet.some((c) => Number(c.id) === cid)) {
            return R.errorResponse(res, 'Unknown or non-syncing company.', 403);
        }

        const now = new Date();
        const dryRun = body.dry_run === true;
        const deleted = {};

        for (const { table, flag } of targets) {
            if (!(await db.schema.hasTable(table))) continue;

            const q = db(table).where('company_id', cid).whereNull('deleted_at');
            if (flag) q.where(flag, true);
            // Only rows that carry a Tally identity are candidates. A row with
            // neither guid nor master_id predates identity capture — we cannot
            // prove Tally dropped it, so we leave it alone rather than guess.
            q.where((w) => w.whereNotNull('tally_master_id').orWhereNotNull('tally_guid'));
            // Survivors: identity still present in Tally's list.
            if (masterIds.length) q.whereNotIn('tally_master_id', masterIds);
            if (guids.length) {
                q.where((w) => w.whereNull('tally_guid').orWhereNotIn('tally_guid', guids));
            }

            if (dryRun) {
                const [{ count }] = await q.clone().count('id as count');
                deleted[table] = Number(count) || 0;
                continue;
            }

            const victims = await q.clone().select('id', 'name');
            if (!victims.length) { deleted[table] = 0; continue; }

            await db(table).whereIn('id', victims.map((v) => v.id))
                .update({ deleted_at: now, updated_at: now });
            deleted[table] = victims.length;

            for (const v of victims) {
                try {
                    await recordHistory(db, {
                        company_id: cid, module: table, record_type: kind,
                        record_id: v.id, action: 'deleted', source: 'tally',
                        before: v, after: null, changed_by: null,
                        note: 'Deleted in Tally (reconcile)',
                    });
                    await db('tally_sync_logs').insert({
                        company_id: cid, module: table, record_type: kind, record_id: v.id,
                        direction: 'pull', status: 'synced', retry_count: 0, synced_at: now,
                        message: `Deleted in Tally: ${v.name}`,
                    });
                } catch (_) { /* auditing must never break the reconcile */ }
            }
        }

        adbg(`RECONCILE company=${cid} kind=${kind} live=${masterIds.length}/${guids.length}`,
             `deleted=${JSON.stringify(deleted)}${dryRun ? ' (dry run)' : ''}`);
        return R.successResponse(res, { company_id: cid, kind, dry_run: dryRun, deleted },
                                 'Reconciled.');
    } catch (err) {
        console.error('AgentController.reconcile error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

// Hard ceiling on one voucher-diff payload. A company with a large book is
// swept in pages by the agent; this bounds a single request's memory and the
// size of the NOT IN (...) the delete pass builds. It is a SAFETY limit, not a
// tuning knob — a caller that ignores it gets a 413, never a truncated compare
// (silently comparing against a truncated list would read as "everything else
// was deleted").
const VOUCHER_DIFF_MAX_IDS = 20000;

/**
 * POST /api/v1/agent/voucher-diff   (authenticateAgent → req.license)
 *
 * Tally → Cloud voucher RECONCILIATION. Body:
 *   { company_id | company_name, voucher_type, page, pages,
 *     ids: [{ guid, alterid }, …], complete: bool, dry_run?: bool }
 *
 * Returns the guids the cloud needs — new ones plus any whose AlterID moved —
 * and, when the sweep for this voucher type is COMPLETE, soft-deletes the
 * vouchers of that type the cloud holds but Tally no longer lists.
 *
 * Why a diff rather than a watermark: a watermark only moves forward, so a
 * window skipped for any reason (Tally stalls, the agent is killed mid-cycle,
 * the cursor is bumped past a gap) is never revisited — those vouchers are
 * missing forever and nothing reports it. Comparing full id lists finds such
 * holes however old they are, and finds deletions in the same pass.
 *
 * Safety rails, because a wrong answer here deletes real books:
 *   • `complete` must be true before ANY delete — a partial or failed Tally read
 *     must never be read as "the rest were deleted";
 *   • an empty id list never deletes;
 *   • deletes are scoped to the ONE voucher type that was swept;
 *   • only rows the mirror itself created (a Tally guid) are touched, never a
 *     cloud-native voucher;
 *   • the payload is capped, and an oversized one is REJECTED rather than
 *     truncated.
 */
async function voucherDiff(req, res) {
    try {
        const licenseId = req.license.id;
        const body = req.body || {};
        const vtype = String(body.voucher_type || '').trim();
        const ids = Array.isArray(body.ids) ? body.ids : [];

        if (!vtype) return R.errorResponse(res, 'voucher_type is required.', 422);
        if (ids.length > VOUCHER_DIFF_MAX_IDS) {
            return R.errorResponse(res,
                `Too many ids in one request (max ${VOUCHER_DIFF_MAX_IDS}). Sweep in pages.`, 413);
        }

        // Company resolution + sync gate, identical to the import path.
        const licRow = await masterDb('licenses').where('id', licenseId).first('max_companies');
        const syncSet = await syncingCompanies(licenseId, licRow ? licRow.max_companies : null, ['id', 'name']);
        let cid = Number(body.company_id) || null;
        if (!cid && body.company_name) {
            const m = syncSet.find((c) => String(c.name || '').toLowerCase()
                === String(body.company_name).trim().toLowerCase());
            cid = m ? Number(m.id) : null;
        }
        if (!cid || !syncSet.some((c) => Number(c.id) === cid)) {
            return R.errorResponse(res, 'Unknown or non-syncing company.', 403);
        }

        // Normalise + de-duplicate. A guid repeated in the payload must not make
        // the cloud think it is present twice.
        const live = new Map();
        for (const r of ids) {
            const g = String((r && r.guid) || '').trim();
            if (g) live.set(g, Number(r.alterid) || 0);
        }

        // What the cloud already holds for THIS type.
        const held = await db('tally_vouchers')
            .where({ company_id: cid, voucher_type: vtype }).whereNull('deleted_at')
            .select('guid', 'tally_alter_id');
        const heldMap = new Map(held.map((h) => [h.guid, Number(h.tally_alter_id) || 0]));

        // NEW = Tally has it, we do not. STALE = we have it but Tally's AlterID
        // moved (the voucher was edited), so the stored copy is out of date.
        const missing = [];
        for (const [guid, alterid] of live) {
            const have = heldMap.get(guid);
            if (have === undefined || alterid > have) missing.push(guid);
        }

        let deleted = 0;
        const canDelete = body.complete === true && live.size > 0;
        if (canDelete) {
            const gone = [...heldMap.keys()].filter((g) => !live.has(g));
            if (gone.length) {
                if (body.dry_run === true) {
                    deleted = gone.length;
                } else {
                    const now = new Date();
                    // Soft-delete in chunks: a single whereIn with tens of
                    // thousands of ids makes a query no planner enjoys.
                    for (let i = 0; i < gone.length; i += 1000) {
                        const chunk = gone.slice(i, i + 1000);
                        await db('tally_vouchers')
                            .where('company_id', cid).whereIn('guid', chunk)
                            .update({ deleted_at: now, updated_at: now });
                        // Cascade to the classified copies. Scoped to rows that
                        // carry a Tally guid, so a cloud-native invoice a user
                        // typed in the web app is never touched.
                        for (const t of ['invoices', 'payments', 'journals']) {
                            await db(t).where('company_id', cid)
                                .whereIn('tally_guid', chunk).whereNull('deleted_at')
                                .update({ deleted_at: now, updated_at: now })
                                .catch(() => { /* table may lack deleted_at */ });
                        }
                    }
                    deleted = gone.length;
                    try {
                        await db('tally_sync_logs').insert({
                            company_id: cid, module: 'vouchers', record_type: vtype,
                            direction: 'pull', status: 'synced', retry_count: 0, synced_at: now,
                            message: `Deleted in Tally: ${deleted} ${vtype} voucher(s)`,
                        });
                    } catch (_) { /* auditing must never break the diff */ }
                }
            }
        }

        adbg(`VOUCHER-DIFF company=${cid} type="${vtype}" live=${live.size} held=${heldMap.size}`
            + ` missing=${missing.length} deleted=${deleted}${body.dry_run ? ' (dry run)' : ''}`);

        return R.successResponse(res, {
            company_id: cid, voucher_type: vtype,
            live: live.size, held: heldMap.size,
            missing, missing_count: missing.length,
            deleted, delete_applied: canDelete && body.dry_run !== true,
        }, 'Diffed.');
    } catch (err) {
        console.error('AgentController.voucherDiff error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * GET /api/v1/agent/envelopes   (authenticateAgent → req.license)
 *
 * The Tally request envelopes this agent should use, signed.
 *
 * WHY THIS ENDPOINT EXISTS: queries used to be compiled into the exe, so adding
 * a report meant a release, a signature, and every customer downloading 23 MB.
 * Now a report is an entry in config/tallyEnvelopes.json.
 *
 * WHY IT IS SIGNED: the same channel could otherwise tell thousands of agents
 * what XML to send to their customers' Tally, and Tally's XML API writes as
 * well as reads. The signature is made with ENVELOPE_SIGNING_SECRET, which is
 * NOT a web-tier credential — it belongs to whoever publishes envelopes. A
 * compromised API server can therefore serve this file but cannot forge a
 * different one, and the agent refuses anything that does not verify.
 *
 * signEnvelopeSet also refuses to sign a set containing any envelope that could
 * modify Tally, so a mistake in the JSON is caught before it ships rather than
 * on a customer's machine.
 */
async function getEnvelopes(req, res) {
    try {
        const secret = process.env.ENVELOPE_SIGNING_SECRET || '';
        if (!secret) {
            // Fail LOUD and closed. Serving unsigned envelopes would be
            // rejected by every agent anyway, and silently returning nothing
            // would look like "there are no reports".
            console.error('ENVELOPE_SIGNING_SECRET is not set — cannot serve envelopes.');
            return R.errorResponse(res, 'Envelope publishing is not configured.', 503);
        }

        let set;
        try {
            // Read per request rather than at boot: publishing a new report is
            // then a file change, not a restart.
            const raw = fs.readFileSync(
                path.join(__dirname, '..', '..', 'config', 'tallyEnvelopes.json'), 'utf8');
            set = JSON.parse(raw);
        } catch (readErr) {
            console.error('Could not read tallyEnvelopes.json:', readErr.message);
            return R.errorResponse(res, 'Envelope set is unavailable.', 503);
        }

        let signed;
        try {
            signed = envelopeSigning.signEnvelopeSet(set, secret);
        } catch (signErr) {
            // signEnvelopeSet refuses the WHOLE set if any envelope can write.
            console.error('Refusing to publish envelopes:', signErr.message);
            return R.errorResponse(res, 'Envelope set failed its safety check.', 500);
        }

        adbg(`ENVELOPES served set=${set.id} count=${Object.keys(set.envelopes || {}).length}`);
        return R.successResponse(res, signed, 'Envelopes.');
    } catch (err) {
        console.error('AgentController.getEnvelopes error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

// ── Data Backup (Task 1, cloud side) ──────────────────────────────────
// The copy itself runs on the agent's own machine — it is the only side
// that can see both the Tally data folder and the chosen destination. These
// two endpoints are the agent's half of the contract: read the INTENT the
// customer set on the dashboard, and report the OUTCOME of a run. Both live
// in the MASTER db (license_backup_settings / backup_runs are license-level,
// not tenant tables) — see api/db/migrations/20260806080000_backup_settings_and_runs.js.

const BACKUP_RUN_STATUSES = ['success', 'partial', 'failed', 'running'];

/**
 * GET /api/v1/agent/backup-settings   (authenticateAgent → req.license)
 * Returns this license's backup intent. A license with no row yet gets the
 * same "disabled, nothing configured" default the cloud dashboard shows.
 */
async function getBackupSettings(req, res) {
    try {
        const row = await masterDb('license_backup_settings')
            .where('license_id', req.license.id).first();
        const data = row ? {
            enabled: !!row.enabled,
            destination_path: row.destination_path || null,
            frequency: row.frequency || 'daily',
            run_at: row.run_at,
            keep_copies: Number(row.keep_copies),
        } : {
            enabled: false, destination_path: null,
            frequency: 'daily', run_at: '02:00:00', keep_copies: 7,
        };
        return R.successResponse(res, data);
    } catch (err) {
        console.error('AgentController.getBackupSettings error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/backup-runs   (authenticateAgent → req.license)
 * Body: { started_at?, finished_at?, status, files_copied?, files_skipped?,
 *         bytes_copied?, destination?, skipped_list?, error? }
 *
 * Records ONE run exactly as the agent reports it — the cloud never upgrades
 * or invents a status. `status` must be one of success|partial|failed|running;
 * anything else is refused rather than silently stored as a success.
 */
async function recordBackupRun(req, res) {
    try {
        const body = req.body || {};
        const status = String(body.status || '').trim().toLowerCase();
        if (!BACKUP_RUN_STATUSES.includes(status)) {
            return R.errorResponse(res, `status must be one of: ${BACKUP_RUN_STATUSES.join(', ')}.`, 422);
        }

        const toInt = (v) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) && n >= 0 ? n : 0;
        };
        const row = {
            license_id: req.license.id,
            started_at: body.started_at ? new Date(body.started_at) : new Date(),
            finished_at: body.finished_at ? new Date(body.finished_at) : (status === 'running' ? null : new Date()),
            status,
            files_copied: toInt(body.files_copied),
            files_skipped: toInt(body.files_skipped),
            bytes_copied: toInt(body.bytes_copied),
            destination: body.destination != null ? String(body.destination) : null,
            skipped_list: Array.isArray(body.skipped_list) ? JSON.stringify(body.skipped_list) : null,
            error: body.error != null ? String(body.error) : null,
        };

        const [inserted] = await masterDb('backup_runs').insert(row).returning('id');
        const id = inserted && inserted.id != null ? inserted.id : inserted;
        return R.successResponse(res, { id }, 'Backup run recorded.', { status: 201 });
    } catch (err) {
        console.error('AgentController.recordBackupRun error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { login, verify, resendOtp, getEnvelopes, heartbeat, offline, pending, result, importFromTally, reconcile, voucherDiff, getCommands, commandResult, getVersion, download, getBackupSettings, recordBackupRun, isPushableReturnNote, isPushableVoucherRow };
