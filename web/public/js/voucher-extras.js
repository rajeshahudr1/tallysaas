'use strict';

/* ─────────────────────────────────────────────────────────────
 * voucher-extras.js — the parts every voucher form needs, once.
 *
 * The six create screens (Quotation, Sales Order, Purchase Order,
 * Delivery Note, Receipt Note, Return Note) are near-identical clones that
 * differ only in a DOM id prefix: q- / so- / po- / dn- / rn- / cn-. Four
 * features that LiveKeeping has on every one of them — the Price Level rate
 * card, the party's closing balance, the Buyer/Consignee/Dispatch/Order
 * detail block, and the richer item option — were built on Quotation first.
 *
 * Copying them into five more files would mean five copies of the same
 * quantity-slab arithmetic, so they live here instead, driven entirely by
 * that prefix. Each form hands its prefix to VoucherExtras.init() and calls
 * back in from the places only it knows about: the party combobox's onChoose,
 * applyProduct(), and the ledger combobox's option label.
 *
 * Load order matters: this file must come BEFORE the form's own script, so
 * window.VoucherExtras exists when that script's init() runs.
 * ─────────────────────────────────────────────────────────── */

(function () {
    var P = null;               // id/class prefix, e.g. 'so'
    var priceCard = null;       // Map: lower(item name) → [slabs], null = no level
    var onLevelChange = null;   // form-supplied "re-rate every row" callback

    function id(suffix) { return document.getElementById(P + '-' + suffix); }
    function inr(n) {
        return '₹' + (Number(n) || 0).toLocaleString('en-IN', {
            minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
    }

    // A ledger balance printed the way Tally prints it: magnitude plus the
    // side it sits on. "₹-23,003.00" reads like a bug; "₹23,003.00 Dr" reads
    // like money the customer owes.
    function drCr(n) {
        var v = Number(n) || 0;
        if (v === 0) return inr(0);
        return inr(Math.abs(v)) + (v > 0 ? ' Dr' : ' Cr');
    }

    /**
     * Which price-level slab applies at this quantity.
     *
     * Tally lets a price level band its rate by quantity ("1–99 at 100, 100+
     * at 90"), so the rate a line gets depends on how many are being sold. A
     * null bound is open-ended on that side.
     *
     * Falls back to the FIRST slab when the quantity matches none — a level
     * with a single un-banded rate must still apply before any quantity is
     * typed, which is the common case. Returns null only when there are no
     * slabs at all, which the caller reads as "this level says nothing about
     * this item".
     */
    function slabRate(slabs, qty) {
        if (!slabs || !slabs.length) return null;
        var q = Number(qty) || 0;
        for (var i = 0; i < slabs.length; i++) {
            var from = slabs[i].from_qty == null ? 0 : Number(slabs[i].from_qty);
            var to   = slabs[i].to_qty == null ? Infinity : Number(slabs[i].to_qty);
            if (q >= from && q <= to) return slabs[i];
        }
        return slabs[0];
    }

    // The rate this row should carry: the level's rate when the level has one
    // for this item, otherwise null — which the caller reads as "no opinion",
    // and leaves the item's own standard price in place.
    function priceLevelRate(productName, qty) {
        if (!priceCard || !productName) return null;
        var slab = slabRate(priceCard.get(String(productName).toLowerCase()), qty);
        return slab && slab.rate != null ? slab : null;
    }

    // The whole card is fetched once per level rather than per item, so
    // choosing an item never waits on the network.
    function loadPriceCard(level) {
        if (!level) { priceCard = null; if (onLevelChange) onLevelChange(); return; }
        fetch('/tally/price-list?level=' + encodeURIComponent(level))
            .then(function (r) { return r.json(); })
            .then(function (j) {
                priceCard = new Map();
                (j && j.data ? j.data : []).forEach(function (row) {
                    var key = String(row.stock_item || '').toLowerCase();
                    if (!key) return;
                    if (!priceCard.has(key)) priceCard.set(key, []);
                    priceCard.get(key).push(row);
                });
                if (onLevelChange) onLevelChange();
            })
            .catch(function () {
                // A failed lookup must not silently price the voucher at the
                // standard rate as though the level had been applied.
                priceCard = null;
                if (onLevelChange) onLevelChange();
            });
    }

    // Put the level's rate (and its discount, when it carries one) onto a row.
    // Returns true when the level had something to say, so the caller knows
    // whether to fall back to the item's own price.
    function applyLevelToRow(row, productName) {
        var qtyEl = row.querySelector('.' + P + '-qty');
        var hit = priceLevelRate(productName, qtyEl ? qtyEl.value : 0);
        if (!hit) return false;
        var rateEl = row.querySelector('.' + P + '-rate');
        if (rateEl) rateEl.value = hit.rate;
        if (hit.discount != null && hit.discount !== 0) {
            var discEl = row.querySelector('.' + P + '-disc');
            if (discEl) discEl.value = hit.discount;
        }
        return true;
    }

    // Re-rate one row after its quantity changed, when the active level bands
    // its rate by quantity. No level, or no band for this item → nothing to
    // do, and whatever the user typed into Rate stands.
    function applySlabRate(row) {
        var search = row.querySelector('.' + P + '-item-search');
        if (!search || !search.value) return;
        applyLevelToRow(row, search.value);
    }

    // The chosen party's standing, under the picker.
    function showPartyBalance(p) {
        var el = id('party-balance');
        if (!el) return;
        if (!p || p.balance == null) { el.hidden = true; el.textContent = ''; return; }
        el.textContent = 'Closing Balance: ' + drCr(p.balance);
        el.hidden = false;
    }

    // Picking a party fills the buyer block — that is the point of picking one
    // — but every field stays editable, because a bill-to address does
    // genuinely differ from the master often enough to matter. Only BLANK
    // fields are filled, so re-picking never overwrites something typed.
    function prefillBuyerFrom(p) {
        if (!p) return;
        var map = {
            name: p.name, gstin: p.gst_number, country: p.country,
            state: p.state, pincode: p.pincode, address: p.billing_address,
            registration_type: p.gst_registration_type,
            // Place of supply is the buyer's state unless stated otherwise —
            // it decides CGST+SGST vs IGST, so a sensible default beats an
            // empty box the user forgets to fill.
            place_of_supply: p.state,
        };
        Object.keys(map).forEach(function (key) {
            var el = document.querySelector('.' + P + '-vd[data-vd-group="buyer"][data-vd-key="' + key + '"]');
            if (el && !el.value && map[key]) el.value = map[key];
        });
    }

    // Each field declares its own group+key, so adding a field to the view
    // needs no change here. Empty values are dropped rather than stored as ""
    // — an absent key reads as "not entered", which is what a blank box means;
    // a stored empty string would print as a real (blank) value.
    function serialiseVoucherDetails() {
        var out = id('voucher-details');
        if (!out) return;
        var details = {};
        document.querySelectorAll('.' + P + '-vd').forEach(function (el) {
            var g = el.dataset.vdGroup;
            var k = el.dataset.vdKey;
            var v = (el.value == null ? '' : String(el.value)).trim();
            if (!g || !k || v === '') return;
            if (!details[g]) details[g] = {};
            details[g][k] = v;
        });
        out.value = JSON.stringify(details);
    }

    /**
     * What a sales/purchase ledger option says about itself, under its name:
     * its Tally group, and whether booking against it attracts GST and at what
     * rate. Tally holds the first in TAXTYPE ("GST", "Others", …) and the rate
     * in TAXCLASSIFICATIONNAME ("GST @ 5%").
     *
     * "Others" is Tally's way of saying no tax applies, so it is not announced
     * — an option reading "Others Applicable" would be noise on every
     * non-taxable ledger. Prefix-independent, so it works on any form.
     */
    function ledgerSubLabel(l) {
        if (!l) return '';
        var bits = [];
        if (l.parent) bits.push(l.parent);
        if (l.tax_classification) {
            bits.push(l.tax_classification);
        } else if (l.tax_type && String(l.tax_type).trim().toLowerCase() !== 'others') {
            bits.push(String(l.tax_type).trim() + ' Applicable');
        }
        return bits.join('  ·  ');
    }

    // HSN and stock-on-hand under the item name — the two things you check
    // BEFORE committing to an item, so putting them in the option saves
    // opening the item master. Stock is omitted (not shown as 0) when unknown,
    // and a NEGATIVE figure is shown plainly: Tally allows it, and it means
    // goods went out before they came in.
    function decorateProductOption(node, p) {
        var bits = [];
        if (p.hsn) bits.push('HSN: ' + p.hsn);
        if (p.stock != null) bits.push('In stock: ' + p.stock + (p.unit ? ' ' + p.unit : ''));
        if (!bits.length) return;
        var sub = document.createElement('span');
        sub.className = 'li-prod-sub';
        sub.textContent = bits.join('  ·  ');
        if (Number(p.stock) < 0) sub.classList.add('is-negative');
        node.appendChild(sub);
    }

    // Gross + Discount only appear once there IS a discount, so a plain bill
    // stays three clean rows.
    function showGrossAndDiscount(t) {
        var has = (Number(t.discount) || 0) > 0;
        var grossEl = id('gross'), grossRow = id('gross-row');
        var discEl  = id('discount'), discRow = id('discount-row');
        if (grossEl) grossEl.textContent = inr(t.gross);
        if (grossRow) grossRow.hidden = !has;
        if (discEl) discEl.textContent = '− ' + inr(t.discount);
        if (discRow) discRow.hidden = !has;
    }

    /**
     * Wire the shared pieces for one form.
     *
     * opts.prefix   — 'so' | 'po' | 'dn' | 'rn' | 'cn' | 'q'
     * opts.form     — the <form>, so voucher details serialise on submit
     * opts.onLevelChange — called after the rate card loads/clears; the form
     *                 re-rates every row that already has an item, otherwise
     *                 the header says one thing and the lines say another.
     */
    function init(opts) {
        P = opts.prefix;
        onLevelChange = opts.onLevelChange || null;

        var levelEl = id('price-level');
        if (levelEl) {
            levelEl.addEventListener('change', function () { loadPriceCard(levelEl.value); });
            if (levelEl.value) loadPriceCard(levelEl.value);
        }

        if (opts.form) {
            opts.form.addEventListener('submit', serialiseVoucherDetails);
        }

        var copyBtn = id('consignee-copy');
        if (copyBtn) copyBtn.addEventListener('click', function () {
            document.querySelectorAll('.' + P + '-vd[data-vd-group="buyer"]').forEach(function (src) {
                var el = document.querySelector('.' + P + '-vd[data-vd-group="consignee"][data-vd-key="' + src.dataset.vdKey + '"]');
                if (el) el.value = src.value;
            });
        });

    }

    /* Advanced Settings tabs. Wired on load rather than from init(), because
       the per-voucher scripts use this file as a helper library and none of
       them call init() — the tabs must work on every screen that includes the
       partial, not just the ones that opt in.

       Panels are hidden, never removed: serialiseVoucherDetails walks
       .<P>-vd across the whole form, so a field on an unopened tab still
       posts its value. */
    function wireAdvancedTabs() {
        var tabs = [].slice.call(document.querySelectorAll('.q-adv-tab[data-vd-tab]'));
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                tabs.forEach(function (t) {
                    var on = t === tab;
                    t.classList.toggle('is-active', on);
                    t.setAttribute('aria-selected', on ? 'true' : 'false');
                    var panel = document.getElementById(t.dataset.vdTab);
                    if (panel) panel.classList.toggle('is-active', on);
                });
            });
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireAdvancedTabs);
    } else {
        wireAdvancedTabs();
    }

    window.VoucherExtras = {
        init: init,
        drCr: drCr,
        slabRate: slabRate,
        priceLevelRate: priceLevelRate,
        applyLevelToRow: applyLevelToRow,
        applySlabRate: applySlabRate,
        showPartyBalance: showPartyBalance,
        prefillBuyerFrom: prefillBuyerFrom,
        serialiseVoucherDetails: serialiseVoucherDetails,
        decorateProductOption: decorateProductOption,
        ledgerSubLabel: ledgerSubLabel,
        showGrossAndDiscount: showGrossAndDiscount,
    };
})();
