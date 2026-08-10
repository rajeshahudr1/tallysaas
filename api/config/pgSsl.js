'use strict';

/**
 * api/config/pgSsl.js
 *
 * One place that decides the TLS settings for every PostgreSQL connection
 * (master, tenants, provisioning, upgrade scripts).
 *
 * The old inline setting was `ssl: { rejectUnauthorized: false }` in
 * production. That encrypts the wire but verifies NOTHING: anything that can
 * sit between the API and 5432 can present its own certificate, terminate the
 * TLS, and read/rewrite every tenant's traffic in clear — including the login
 * credentials it carries. Encryption without verification is not protection.
 *
 * Set DB_CA_CERT to the server's CA certificate (PEM path) to get real
 * verification. Behaviour:
 *
 *   DB_CA_CERT set                → verify against that CA (correct; do this)
 *   unset, APP_ENV=production     → encrypt only + a loud warn-once
 *   unset, development            → no TLS (local postgres, plain socket)
 *
 * DB_SSL=false force-disables TLS anywhere (a local docker pg that has none).
 */

const fs = require('node:fs');

let _cachedCa = null;
let _warned   = false;

function sslConfig() {
    if (String(process.env.DB_SSL || '').toLowerCase() === 'false') return undefined;

    const caPath = String(process.env.DB_CA_CERT || '').trim();
    if (caPath) {
        if (!_cachedCa) _cachedCa = fs.readFileSync(caPath, 'utf8');
        return {
            ca: _cachedCa,
            rejectUnauthorized: true,
            ...(process.env.DB_SSL_SERVERNAME ? { servername: String(process.env.DB_SSL_SERVERNAME) } : {}),
        };
    }

    const isProd = String(process.env.APP_ENV || '') === 'production';
    if (!isProd && String(process.env.DB_SSL || '').toLowerCase() !== 'true') return undefined;

    if (!_warned) {
        _warned = true;
        console.warn(
            'pgSsl: connecting with TLS but WITHOUT certificate verification (DB_CA_CERT is not set). ' +
            'The connection is encrypted but a man-in-the-middle can still impersonate the database. ' +
            'Point DB_CA_CERT at the server CA PEM.',
        );
    }
    return { rejectUnauthorized: false };
}

/** Spread into a pg/knex `connection` object: `{ ...baseConn, ...withSsl() }`. */
function withSsl() {
    const ssl = sslConfig();
    return ssl ? { ssl } : {};
}

module.exports = { sslConfig, withSsl };
