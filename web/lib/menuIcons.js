'use strict';

/**
 * web/lib/menuIcons.js
 *
 * Font Awesome class → line-icon sprite id.
 *
 * The menu ships Font Awesome SOLID glyphs, which are filled shapes. The
 * product design calls for LINE icons (Lucide style: 24×24, 2px stroke, round
 * caps), and Font Awesome Free has no light/regular weight for most of these —
 * so the sprite in views/partials/icon-sprite.ejs draws them instead.
 *
 * Only the icons listed here are swapped. Anything unmapped keeps rendering
 * its Font Awesome glyph, so adding a new menu entry can never produce a blank
 * square — it just looks like the old icon until a symbol is drawn for it.
 *
 * Several Font Awesome names map to ONE symbol on purpose: fa-chart-column and
 * fa-chart-simple are the same bar chart, and the three fa-file-circle-*
 * variants differ only in their badge, which the symbols reproduce.
 */
module.exports = {
    // Dashboard / analytics
    'fa-gauge-high':          'i-gauge',
    'fa-chart-line':          'i-trending-up',
    'fa-chart-column':        'i-bar-chart',
    'fa-chart-simple':        'i-bar-chart',
    'fa-chart-pie':           'i-pie-chart',

    // Actions
    'fa-plus':                'i-plus',
    'fa-magnifying-glass':    'i-search',
    'fa-rotate':              'i-refresh',
    'fa-repeat':              'i-repeat',
    'fa-right-left':          'i-arrow-left-right',
    'fa-sliders':             'i-sliders',
    'fa-gear':                'i-settings',
    'fa-bell':                'i-bell',
    'fa-globe':               'i-globe',
    'fa-clock-rotate-left':   'i-history',
    'fa-cloud-arrow-up':      'i-cloud-upload',
    'fa-square-check':        'i-check-square',
    'fa-list-check':          'i-list-checks',

    // Documents / vouchers
    'fa-file-lines':          'i-file-text',
    'fa-file-invoice':        'i-file-text',
    'fa-file-invoice-dollar': 'i-file-rupee',
    'fa-file-signature':      'i-file-pen',
    'fa-file-import':         'i-file-down',
    'fa-file-circle-plus':    'i-file-plus',
    'fa-file-circle-minus':   'i-file-minus',
    'fa-file-circle-check':   'i-file-check',
    'fa-receipt':             'i-receipt',
    'fa-clipboard-list':      'i-clipboard-list',
    'fa-clipboard-check':     'i-clipboard-check',
    'fa-book':                'i-book',

    // Money
    'fa-wallet':              'i-wallet',
    'fa-credit-card':         'i-credit-card',
    'fa-money-bill-1':        'i-banknote',
    'fa-money-bill-wave':     'i-banknote',
    'fa-sack-dollar':         'i-piggy-bank',
    'fa-hand-holding-dollar': 'i-hand-coins',
    'fa-scale-balanced':      'i-scale',
    'fa-building-columns':    'i-landmark',

    // Stock / logistics
    'fa-box':                 'i-package',
    'fa-boxes-stacked':       'i-boxes',
    'fa-boxes-packing':       'i-package-open',
    'fa-cubes':               'i-boxes',
    'fa-warehouse':           'i-warehouse',
    'fa-truck-fast':          'i-truck',
    'fa-truck-field':         'i-truck',
    'fa-dolly':               'i-dolly',
    'fa-cart-shopping':       'i-shopping-cart',
    'fa-cart-flatbed':        'i-shopping-cart',
    'fa-tags':                'i-tag',

    // People / places
    'fa-users':               'i-users',
    'fa-user-group':          'i-users',
    'fa-user-tie':            'i-user-tie',
    'fa-user-lock':           'i-user-lock',
    'fa-address-book':        'i-contact',
    'fa-building':            'i-building',
    'fa-location-dot':        'i-map-pin',
    'fa-location-crosshairs': 'i-crosshair',
    'fa-map-location-dot':    'i-map',

    // Injected at render time by the sidebar (Roles for a company admin, the
    // super-admin's Platform Admin group) — never present in menuTree.
    'fa-user-shield':         'i-shield-user',
    'fa-shield-halved':       'i-shield',
    'fa-key':                 'i-key',
    'fa-mobile-screen-button':'i-smartphone',
    'fa-folder':              'i-folder',
};
