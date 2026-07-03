'use strict';

/**
 * api/Modules/einvoice/providers/ProviderFactory.js
 *
 * Resolves the e-Invoice provider for a license: reads einvoice_settings for the
 * default provider + env, loads + DECRYPTS the matching gsp_credentials, and
 * returns a ready IEInvoiceProvider adapter wired with a logger that writes
 * einvoice_api_logs. When nothing is configured it falls back to NIC in MOCK mode
 * so the flow works end-to-end during local testing.
 *
 * Add a new GSP = register its adapter in REGISTRY; nothing else changes.
 */

const db = require('../../../config/db').db;
const { decrypt } = require('../lib/credVault');
const { NicProvider } = require('./nic/NicProvider');

const REGISTRY = {
    nic: NicProvider,
    // cleartax: ClearTaxProvider,   // (interface-ready; add adapters here)
    // mastersindia: MastersIndiaProvider,
    // vayana: VayanaProvider,
    // adequare: AdequareProvider,
    // avalara: AvalaraProvider,
};

function safeDecrypt(v) {
    try { return decrypt(v); } catch { return null; }
}

/**
 * @param {object} o
 * @param {number} o.licenseId
 * @param {number} [o.companyId]
 * @param {string} [o.gstin]   supplier GSTIN (picks the most specific creds)
 * @param {Function} [o.log]   ({action, endpoint, httpStatus, nicStatusCode, success, latencyMs, request, response, error}) => void
 * @returns {Promise<import('./IEInvoiceProvider').IEInvoiceProvider>}
 */
async function resolveProvider({ licenseId, companyId, gstin, log } = {}) {
    let providerName = 'nic';
    let env = 'sandbox';

    if (licenseId) {
        const s = await db('einvoice_settings').where({ license_id: licenseId }).first();
        if (s) {
            providerName = s.default_provider || 'nic';
            env = s.env || 'sandbox';
        }
    }

    const Provider = REGISTRY[providerName] || NicProvider;

    let creds = {};
    if (licenseId) {
        const row = await db('gsp_credentials')
            .where({ license_id: licenseId, provider: providerName, env })
            .modify((q) => {
                if (gstin) q.andWhere((b) => b.where('gstin', gstin).orWhereNull('gstin'));
            })
            .orderByRaw('(gstin is null) asc') // prefer a GSTIN-specific row over the fallback
            .first();
        if (row && row.active) {
            creds = {
                base_url: row.base_url,
                username: row.username,
                password: safeDecrypt(row.password_enc),
                client_id: safeDecrypt(row.client_id_enc),
                client_secret: safeDecrypt(row.client_secret_enc),
                api_key: safeDecrypt(row.api_key_enc),
            };
        }
    }

    return new Provider({
        creds,
        env,
        gstin: gstin || null,
        log: typeof log === 'function' ? log : () => {},
    });
}

module.exports = { resolveProvider, REGISTRY };
