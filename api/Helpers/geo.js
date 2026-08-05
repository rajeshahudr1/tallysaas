'use strict';

/**
 * api/Helpers/geo.js
 *
 * Country / State / City lists for the customer address form's cascading
 * dropdowns.
 *
 * The data is static JSON (copied from a sibling project), not a db table —
 * it never changes and is identical for every tenant, so duplicating it in
 * every tenant db would be pointless.
 *
 * Cities are ~4.6 MB across five files, so they are not read at boot — the
 * first request for a given state reads and indexes all five files by
 * state_id once, and every call after that is served from memory.
 *
 * GST codes are not part of this data — they come from gstStates.js, matched
 * by state name, so GST_STATES stays the single source of truth for GST math.
 */

const path = require('node:path');
const { GST_STATES } = require('../config/gstStates');

const DIR = path.join(__dirname, '..', 'config', 'geo');
const INDIA_COUNTRY_ID = 101;

const CITY_FILES = ['cities0.json', 'cities1.json', 'cities2.json', 'cities3.json', 'cities4.json'];

let _countries = null;
let _statesByCountry = null;
let _citiesByState = null;

function gstCodeFor(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    const match = GST_STATES.find((s) => s.name.trim().toLowerCase() === key);
    return match ? match.code : null;
}

function loadCountries() {
    if (_countries) return _countries;
    const raw = require(path.join(DIR, 'countries.json'));
    _countries = (raw.countries || []).map((c) => ({
        id: Number(c.id),
        name: c.name,
        code: c.sort_name,
    }));
    return _countries;
}

function loadStates() {
    if (_statesByCountry) return _statesByCountry;
    const raw = require(path.join(DIR, 'states.json'));
    const byCountry = new Map();
    for (const s of raw.states || []) {
        const countryId = Number(s.country_id);
        const entry = {
            id: Number(s.state_id),
            name: s.name,
            gst_code: countryId === INDIA_COUNTRY_ID ? gstCodeFor(s.name) : null,
        };
        if (!byCountry.has(countryId)) byCountry.set(countryId, []);
        byCountry.get(countryId).push(entry);
    }
    _statesByCountry = byCountry;
    return _statesByCountry;
}

function loadCities() {
    if (_citiesByState) return _citiesByState;
    const byState = new Map();
    for (const file of CITY_FILES) {
        const raw = require(path.join(DIR, file));
        for (const c of raw.cities || []) {
            const stateId = Number(c.state_id);
            const entry = { id: Number(c.city_id), name: c.name };
            if (!byState.has(stateId)) byState.set(stateId, []);
            byState.get(stateId).push(entry);
        }
    }
    _citiesByState = byState;
    return _citiesByState;
}

function countries() {
    return loadCountries();
}

function statesOf(countryId) {
    const byCountry = loadStates();
    return byCountry.get(Number(countryId)) || [];
}

function citiesOf(stateId) {
    const byState = loadCities();
    return byState.get(Number(stateId)) || [];
}

module.exports = { countries, statesOf, citiesOf, INDIA_COUNTRY_ID };
