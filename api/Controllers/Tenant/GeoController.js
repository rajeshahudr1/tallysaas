'use strict';

/**
 * api/Controllers/Tenant/GeoController.js
 *
 * Read-only country/state/city lookups for the customer address form's
 * cascading dropdowns. Backed by Helpers/geo.js's static, in-memory dataset —
 * no db access. A missing or nonsensical id gives an empty list, never a 500.
 */

const R = require('../../Helpers/response');
const geo = require('../../Helpers/geo');

function toId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

exports.countries = (req, res) => {
    return R.successResponse(res, { data: geo.countries() });
};

exports.states = (req, res) => {
    const countryId = toId(req.query.country_id);
    const data = countryId ? geo.statesOf(countryId) : [];
    return R.successResponse(res, { data });
};

exports.cities = (req, res) => {
    const stateId = toId(req.query.state_id);
    const data = stateId ? geo.citiesOf(stateId) : [];
    return R.successResponse(res, { data });
};
