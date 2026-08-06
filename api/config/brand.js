'use strict';

/**
 * api/config/brand.js
 *
 * SINGLE SOURCE OF TRUTH for the product brand (name + colours) on the API
 * side. Used anywhere the API renders text or documents itself: emails,
 * PDF/letterhead footers, OTP messages, and any server-rendered strings.
 *
 * To rebrand:
 *   • name / shortName / tagline / color  → edit the values below.
 *   • the logo used in PDFs                → web/public/img/logo-full.png.
 *
 * This is ONE of FOUR brand files — one per runtime, because they can't share
 * code: this one, web/config/brand.js, agent/brand.py, and app/lib/core/brand.dart.
 * They must all agree. api/tests/brandConsistency.test.js pins name/tagline
 * across all four and fails loudly if one is changed without the others.
 */

module.exports = {
    // Full product name — shown in emails, PDFs and server-rendered strings.
    name:      'Teloora',
    // Compact form for tight spaces.
    shortName: 'Teloora',
    // One-line description.
    tagline:   'Connected Accounting',
    // Primary accent (matches web/config/brand.js color). One knob for the brand colour.
    color:     '#1560E0',
    // Full brand palette — the logo's blue→green gradient and its deep navy
    // wordmark colour. Used by PDF/letterhead footers and email templates.
    colors: {
        navy:     '#17265E',
        blue:     '#1560E0',
        green:    '#45B649',
        gradient: 'linear-gradient(135deg, #1560E0, #45B649)',
    },
};
