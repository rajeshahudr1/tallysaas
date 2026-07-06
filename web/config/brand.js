'use strict';

/**
 * web/config/brand.js
 *
 * SINGLE SOURCE OF TRUTH for the product brand (name + logo) across the WHOLE web
 * UI. Change it HERE and it updates everywhere: page <title>s, the sidebar badge,
 * the login / forgot screens, invoice print footer, the PWA manifest, and JS
 * toasts (via window.BRAND, injected in _layout.ejs).
 *
 * To rebrand:
 *   • name / shortName / tagline / color  → edit the values below.
 *   • the logo image                       → replace web/public/img/logo.svg
 *                                            (keep the same path).
 *   • the brand chip icon                  → change iconClass (any Font Awesome).
 *
 * The Flutter app mirrors this at app/lib/core/brand.dart — keep the two in sync.
 */

module.exports = {
    // Full product name — shown in the UI and in the "<page> · <name>" titles.
    name:      'Tally Cloud Sync',
    // Compact form for tight spaces / the PWA short_name.
    shortName: 'Tally Cloud',
    // One-line description (meta description + PWA description).
    tagline:   'Cloud accounting that syncs with Tally.',
    // The single logo image (favicon + any <img> logo). Replace the file to swap.
    logo:      '/img/logo.svg',
    // The brand chip's Font Awesome icon class (login + sidebar badge).
    iconClass: 'fa-solid fa-cloud',
    // Primary accent (chip gradient / theme). One knob for the brand colour.
    color:     '#2563EB',
};
