'use strict';

/**
 * api/Helpers/emailUnique.js
 *
 * An email is the global LOGIN IDENTITY, so it must be unique across BOTH the
 * `users` table AND the `sales_persons` table — one email = one person. A sales
 * person can become a login user (their email flows into the users row), so the
 * two tables share ONE email namespace.
 *
 * `emailOwner(dbx, email, opts)` returns { table, id } of the row that already
 * holds the email, or null when it is free. `emailInUse` is the boolean form.
 * Case-insensitive; soft-deleted rows are ignored (a removed email can be reused).
 *
 * The same person's own pair is excluded via opts so updating a record (or
 * linking a sales person to its OWN login) is not flagged as a clash:
 *   • exceptUserId        — skip this users.id        (the record's own login)
 *   • exceptSalesPersonId — skip this sales_persons.id (the record itself)
 */

const defaultDb = require('../config/db').db;

async function emailOwner(dbx, email, opts = {}) {
    const database = dbx || defaultDb;
    if (!email) return null;
    const e = String(email).trim().toLowerCase();
    if (!e) return null;

    const exceptUserId        = opts.exceptUserId || null;
    const exceptSalesPersonId = opts.exceptSalesPersonId || null;

    // users — the login identity.
    const uq = database('users').whereNull('deleted_at').whereRaw('lower(email) = ?', [e]);
    if (exceptUserId) uq.whereNot('id', exceptUserId);
    const u = await uq.first('id');
    if (u) return { table: 'users', id: u.id };

    // sales_persons — share the same email namespace.
    const sq = database('sales_persons').whereNull('deleted_at').whereRaw('lower(email) = ?', [e]);
    if (exceptSalesPersonId) sq.whereNot('id', exceptSalesPersonId);
    const s = await sq.first('id');
    if (s) return { table: 'sales_persons', id: s.id };

    return null;
}

async function emailInUse(dbx, email, opts = {}) {
    return (await emailOwner(dbx, email, opts)) != null;
}

const EMAIL_TAKEN_MSG = 'This email is already in use (by a user or a sales person). One email can belong to only one person.';

module.exports = { emailOwner, emailInUse, EMAIL_TAKEN_MSG };
