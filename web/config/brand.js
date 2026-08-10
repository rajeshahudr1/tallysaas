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
 * This is ONE of FOUR brand files — one per runtime, because they can't share
 * code: this one, api/config/brand.js, agent/brand.py, and app/lib/core/brand.dart.
 * They must all agree. api/tests/brandConsistency.test.js pins name/tagline
 * across all four and fails loudly if one is changed without the others.
 */

module.exports = {
    // Full product name — shown in the UI and in the "<page> · <name>" titles.
    name:      'Teloora',
    // Compact form for tight spaces / the PWA short_name.
    shortName: 'Teloora',
    // One-line description (meta description + PWA description).
    tagline:   'Connected Accounting',
    // The square logo mark (favicon + sidebar chip). Replace the file to swap.
    logo:      '/img/logo.svg',
    // Same mark as a raster, for places that can't render SVG.
    logoMark:  '/img/logo-mark.png',
    // The full lock-up (wordmark + tagline) — login / forgot / PDF letterhead,
    // i.e. anywhere it renders big enough for the tagline to be readable.
    logoFull:  '/img/logo-full.png',
    // Wordmark only, no tagline. For tight chrome like the sidebar header,
    // where dropping the strapline lets the name itself run much larger.
    logoWordmark: '/img/logo-wordmark.png',
    // Fallback Font Awesome icon, used only if the logo image fails to load.
    iconClass: 'fa-solid fa-diagram-project',
    // Primary accent (chip gradient / theme). One knob for the brand colour.
    color:     '#1560E0',
    // Full brand palette — the logo's blue→green gradient and its deep navy
    // wordmark colour. Used by theme.css, the PDF/letterhead footer, and
    // anywhere else that needs more than a single accent.
    colors: {
        navy:     '#17265E',
        blue:     '#1560E0',
        green:    '#45B649',
        gradient: 'linear-gradient(135deg, #1560E0, #45B649)',
    },
    // UI theme knobs derived from the logo. These are emitted as CSS custom
    // properties by web/views/partials/brand-vars.ejs (included on every page,
    // after theme.css) so the whole UI follows the logo from this one place.
    theme: {
        primary:     '#1560E0',  // logo blue  → buttons, links, active states
        primaryDark: '#0F4CB8',  // hover/pressed shade of the blue
        secondary:   '#45B649',  // logo green → gradient end, accents
        // NOTE: the sidebar's own colours are NOT here. They are app chrome,
        // not brand identity, and live in theme.css (--sidebar-bg and friends).
    },
};
