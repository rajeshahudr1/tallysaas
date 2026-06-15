# Phase 3 — Licensing, Subscription & Secure Agent Activation

Confirmed model (2026-06-15):

- **License** = one Tally license / customer install. Has ONE secret **license key**.
- One license → **many companies**. **Users are common to the license** (a user can log in to any company under their license).
- **Single active session per user** — a second login is **blocked** while a live session exists ("already logged in elsewhere"). A session is "live" if seen within `ACTIVE_WINDOW` (10 min) and not expired.
- **Per-user subscription** (cloud web/app access): plan + validity; login is rejected if expired.
- **Secure agent key:** key is a *credential only*. All entitlement/limits live in the cloud and are checked **server-side on every call** (tamper-proof, instant suspend). The key is stored **hashed** at rest. On first activation it is **bound to one machine** (fingerprint); a different machine is rejected.

## Schema (new migrations 0021+)

**licenses** — `id`, `license_key_hash` (sha256 of key), `key_prefix` (unique, lookup/display e.g. `TCS-AB12C`), `tally_serial`, `holder_name`, `plan` (default 'standard'), `max_companies` (default 5), `max_users` (default 10), `valid_until` (date), `status` (active|suspended|expired, default active), `machine_id` (bound fingerprint, nullable), `machine_bound_at`, `last_seen_at` (agent heartbeat), `agent_version`, `created_by`, timestamps, `deleted_at`.

**subscriptions** — `id`, `user_id` FK, `plan`, `valid_from` (date), `valid_until` (date), `status` (active|expired|cancelled, default active), timestamps.

**companies** — add `license_id` FK→licenses (nullable; many companies per license).

**users** — add `license_id` FK→licenses (nullable), `current_company_id` (nullable, last-selected), `active_session_jti` (text), `session_last_seen` (timestamptz), `session_expires_at` (timestamptz). Keep existing `company_id` (= primary/current company, backward compat).

## Key generation (Helpers/licenseKey.js)
- `generate()` → `{ key, prefix, hash }`. Format `TCS-XXXXX-XXXXX-XXXXX-XXXXX` (Crockford base32, no ambiguous chars). `prefix` = `TCS-` + first group. `hash` = sha256(key). Key shown ONCE on creation.
- `parse(key)` → `{ prefix, hash }` for lookup + verify.

## Auth changes
- **login** (Controllers/Auth/AuthController.login): after password OK + status Active →
  1. **Subscription gate**: require an active subscription (`subscriptions` valid_until ≥ today, status active). Super Admin bypasses. Else 403 "Your subscription has expired."
  2. **Single-session gate**: if `active_session_jti` set AND `session_last_seen` within ACTIVE_WINDOW AND `session_expires_at` > now → reject 403 "You are already logged in on another device. Please log out there first." Else continue.
  3. Generate `jti` (uuid); set `active_session_jti=jti, session_last_seen=now, session_expires_at=now+JWT_EXPIRES`. Sign JWT with `jti` in the payload.
- **authenticate** (Middlewares/auth): verify JWT → look up the user → require `payload.jti === user.active_session_jti` (else 401 "Session ended — logged in elsewhere.") → update `session_last_seen=now`. (One indexed lookup per request.)
- **logout**: clear `active_session_jti` for the user.

## Licensing endpoints (Super Admin)
- `POST /api/v1/super-admin/licenses` — create a license (generate key, return key ONCE), optionally with companies/users count. (Auth: super-admin only.)
- `GET  /api/v1/super-admin/licenses` — list licenses (no key, just prefix + status + machine binding + last_seen).
- `POST /api/v1/super-admin/licenses/:id/reset-machine` — unbind machine (so the customer can re-install on a new PC).
- `POST /api/v1/super-admin/licenses/:id/suspend` / `/activate`.

## Agent endpoints (used by the Python agent)
- `POST /api/v1/agent/activate` `{ license_key, machine_id, agent_version }` → validate key (prefix+hash), status active + not expired, bind/verify machine_id → return `{ agent_token (JWT kind:'agent', 7d), license: { id, holder, plan, valid_until }, companies: [{id,name,slug}] }`. Errors: 404 invalid key, 403 suspended/expired/wrong-machine.
- `POST /api/v1/agent/heartbeat` (agent_token) → update `last_seen_at` + `agent_version`; return `{ status }` so the agent halts if suspended.
- `GET  /api/v1/agent/pending` (agent_token) → records queued for Tally (later, for sync).

## Seed backfill (existing data)
Create a default license `Demo License` (key printed), link company `abc` + super-admin user to it (`license_id`), set `current_company_id`, and give the super-admin an active subscription (valid 1 year).
