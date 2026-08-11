'use strict';

/* ─────────────────────────────────────────────────────────────
 * invoice.js — line-item engine for the Create Invoice page.
 *
 * Loaded only on /sales-invoices/create (via the layout `pageScript`
 * slot). Responsibilities:
 *   • Add / remove line-item rows (cloned from <template id="li-row-tpl">).
 *   • When a product is picked, auto-fill HSN / Unit / Rate / GST% from
 *     the <option> data-* attributes.
 *   • Per row: Taxable = Qty × Rate − Discount%, GST Amt = Taxable × GST%,
 *     Amount = Taxable + GST Amt.
 *   • Totals: Subtotal (gross), Total Discount, Taxable, CGST + SGST
 *     (half of total GST each), Round Off, Grand Total.
 *
 * No backend — values are display-only (Phase 1). Markup contract lives
 * in views/sales-invoices/create.ejs.
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var tbody  = document.getElementById('li-body');
        var tpl    = document.getElementById('li-row-tpl');
        var addBtn = document.getElementById('li-add-row');
        if (!tbody || !tpl) return;

        // Product catalogue for the searchable line-item picker (from the page).
        var PRODUCTS = Array.isArray(window.INVOICE_PRODUCTS) ? window.INVOICE_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        function inr(n) {
            return '₹' + (Number(n) || 0).toLocaleString('en-IN', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
            });
        }

        function rowValues(row) {
            var qty  = parseFloat(row.querySelector('.li-qty').value)  || 0;
            var rate = parseFloat(row.querySelector('.li-rate').value) || 0;
            var disc = parseFloat(row.querySelector('.li-disc').value) || 0;
            var gst  = parseFloat(row.querySelector('.li-gst').value)  || 0;
            var gross   = qty * rate;
            var discAmt = gross * disc / 100;
            var taxable = gross - discAmt;
            var gstAmt  = taxable * gst / 100;
            return { gross: gross, discAmt: discAmt, taxable: taxable, gstAmt: gstAmt, amount: taxable + gstAmt };
        }

        function recalcRow(row) {
            var v = rowValues(row);
            row.querySelector('.li-taxable').textContent = inr(v.taxable);
            row.querySelector('.li-gstamt').textContent  = inr(v.gstAmt);
            row.querySelector('.li-amount').textContent  = inr(v.amount);
        }

        function set(id, val) {
            var el = document.getElementById(id);
            if (el) el.textContent = val;
        }

        function recalcTotals() {
            var sub = 0, disc = 0, tax = 0, gst = 0;
            tbody.querySelectorAll('.li-row').forEach(function (row) {
                var v = rowValues(row);
                sub += v.gross; disc += v.discAmt; tax += v.taxable; gst += v.gstAmt;
            });
            var grand    = tax + gst;
            var rounded  = Math.round(grand);
            var roundoff = rounded - grand;

            set('inv-subtotal', inr(sub));
            set('inv-discount', '− ' + inr(disc));
            set('inv-taxable',  inr(tax));
            set('inv-cgst',     inr(gst / 2));
            set('inv-sgst',     inr(gst / 2));
            set('inv-roundoff', (roundoff >= 0 ? '+ ' : '− ') + inr(Math.abs(roundoff)));
            set('inv-grand',    inr(rounded));
            set('inv-itemcount', tbody.querySelectorAll('.li-row').length + ' item(s)');
        }

        function renumber() {
            var i = 1;
            tbody.querySelectorAll('.li-row .li-idx').forEach(function (c) { c.textContent = i++; });
        }

        function resetRow(row) {
            var search = row.querySelector('.li-product-search');
            var hidden = row.querySelector('.li-product');
            if (search) search.value = '';
            if (hidden) hidden.value = '';
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.li-hsn').value  = '';
            row.querySelector('.li-unit').value = '';
            row.querySelector('.li-qty').value  = '1';
            row.querySelector('.li-rate').value = '0';
            row.querySelector('.li-disc').value = '0';
            row.querySelector('.li-gst').value  = '0';
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .li-product) +
        // fill HSN / Unit / Rate / GST from the catalogue, then recompute.
        function applyProduct(row, p) {
            var search = row.querySelector('.li-product-search');
            var hidden = row.querySelector('.li-product');
            hidden.value = p ? String(p.id) : '';
            if (search) search.value = p ? p.name : '';
            row.querySelector('.li-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.li-unit').value = p ? (p.unit || '') : '';
            if (p && p.rate != null) row.querySelector('.li-rate').value = p.rate;
            if (p && p.gst != null)  row.querySelector('.li-gst').value  = p.gst;
            // Stock cap — Qty can't exceed what's on hand (the api enforces the
            // same rule; this just stops it at the keyboard).
            var qty = row.querySelector('.li-qty');
            if (qty) {
                if (p && p.stock != null) {
                    // Stock on hand is a HINT, not a cap. A quotation or an
                    // order is a promise about goods you may not hold yet, and
                    // Tally itself allows a negative balance, so clamping the
                    // Qty box to it silently rewrote what the user typed —
                    // usually to 0, because most synced items report no
                    // movement. Show the figure, let the user decide.
                    qty.title = 'In stock: ' + p.stock;
                    qty.removeAttribute('max');
                } else {
                    qty.removeAttribute('max'); qty.title = '';
                }
            }
            recalcRow(row); recalcTotals();
        }

        // Clamp a row's Qty to the picked product's stock as the user types.
        function clampQty(row) {
            var qty = row.querySelector('.li-qty');
            if (!qty || qty.max === '' || qty.max == null) return;
            var maxV = parseFloat(qty.max);
            if (!isNaN(maxV) && (parseFloat(qty.value) || 0) > maxV) qty.value = maxV;
        }

        // Searchable product picker: filter the catalogue as the user types and
        // show a click/keyboard-selectable menu. Replaces the old native <select>
        // so a 200+ product list is usable.
        function wireProductPicker(row) {
            var search = row.querySelector('.li-product-search');
            var hidden = row.querySelector('.li-product');
            var menu   = row.querySelector('.li-prod-menu');
            if (!search || !menu) return;
            var active = -1, items = [];

            // The menu is position:fixed (to escape the table's overflow clip), so
            // pin it under the search input using the input's viewport rect.
            function place() {
                var r = search.getBoundingClientRect();
                menu.style.left  = r.left + 'px';
                menu.style.top   = (r.bottom + 2) + 'px';
                menu.style.width = r.width + 'px';
                // A line-item cell is ~200px wide; the option under it carries an HSN and a
                // stock figure as well as the name. Let the menu outgrow its field rather
                // than clip what it was opened to show — clamped so it never leaves the
                // viewport on a narrow screen.
                menu.style.minWidth = Math.min(320, window.innerWidth - r.left - 16) + 'px';
            }
            function render(list) {
                menu.innerHTML = '';
                items = list;
                active = -1;
                if (!list.length) {
                    menu.innerHTML = '<div class="li-prod-empty">No products found</div>';
                } else {
                    list.forEach(function (p, i) {
                        var d = document.createElement('div');
                        d.className = 'li-prod-item';
                        d.setAttribute('data-i', i);
                        d.textContent = p.name;
                        d.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
                        menu.appendChild(d);
                    });
                }
                menu.hidden = false;
                place();
            }
            // Keep the fixed menu pinned to the input while it's open (page/table scroll).
            window.addEventListener('scroll', function () { if (!menu.hidden) place(); }, true);
            window.addEventListener('resize', function () { if (!menu.hidden) place(); });
            function filter() {
                var q = search.value.trim().toLowerCase();
                var list = !q ? PRODUCTS.slice(0, 50)
                    : PRODUCTS.filter(function (p) { return p.name.toLowerCase().indexOf(q) > -1; }).slice(0, 50);
                render(list);
            }
            function choose(i) {
                var p = items[i];
                if (!p) return;
                applyProduct(row, p);
                menu.hidden = true;
            }
            function highlight() {
                menu.querySelectorAll('.li-prod-item').forEach(function (el, i) {
                    el.classList.toggle('is-active', i === active);
                });
                var el = menu.querySelector('.is-active');
                if (el) el.scrollIntoView({ block: 'nearest' });
            }

            search.addEventListener('input', function () { hidden.value = ''; filter(); });
            search.addEventListener('focus', function () { if (search.value.trim() === '') filter(); });
            search.addEventListener('keydown', function (e) {
                if (menu.hidden) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
                else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
                else if (e.key === 'Escape') { menu.hidden = true; }
            });
            search.addEventListener('blur', function () { setTimeout(function () { menu.hidden = true; }, 150); });
        }

        function wireRow(row) {
            wireProductPicker(row);
            row.querySelectorAll('.li-qty, .li-rate, .li-disc, .li-gst').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    if (inp.classList.contains('li-qty')) clampQty(row);
                    recalcRow(row); recalcTotals();
                });
            });
            row.querySelector('.li-remove').addEventListener('click', function () {
                if (tbody.querySelectorAll('.li-row').length > 1) {
                    row.remove();
                } else {
                    resetRow(row);   // keep at least one row
                }
                renumber(); recalcTotals();
            });
        }

        function addRow() {
            var node = tpl.content.firstElementChild.cloneNode(true);
            tbody.appendChild(node);
            wireRow(node);
            recalcRow(node);
            renumber();
            recalcTotals();
            return node;
        }

        if (addBtn) addBtn.addEventListener('click', function () { addRow(); });

        // ── Serialise line items into the hidden #items-json on submit ──
        // The api computes the authoritative totals from these items; the
        // header fields (customer_id, dates, …) submit as normal form
        // fields. Empty rows (no product AND no qty) are dropped.
        var form = tbody.closest('form');
        var hidden = document.getElementById('items-json');
        if (form && hidden) {
            form.addEventListener('submit', function () {
                var items = [];
                tbody.querySelectorAll('.li-row').forEach(function (row) {
                    var prod = row.querySelector('.li-product');
                    var pid  = prod ? prod.value : '';
                    var qty  = parseFloat(row.querySelector('.li-qty').value) || 0;
                    if (!pid && qty <= 0) return;
                    items.push({
                        product_id:   pid ? Number(pid) : null,
                        hsn:          row.querySelector('.li-hsn').value || '',
                        quantity:     qty,
                        unit:         row.querySelector('.li-unit').value || '',
                        rate:         parseFloat(row.querySelector('.li-rate').value) || 0,
                        discount_pct: parseFloat(row.querySelector('.li-disc').value) || 0,
                        gst_rate:     parseFloat(row.querySelector('.li-gst').value) || 0,
                    });
                });
                hidden.value = JSON.stringify(items);
            });
        }

        // Seed the table. EDIT mode → one pre-filled row per existing line item
        // (window.INVOICE_EDIT_ITEMS); otherwise a single empty row.
        var seed = Array.isArray(window.INVOICE_EDIT_ITEMS) ? window.INVOICE_EDIT_ITEMS : [];
        if (seed.length) {
            seed.forEach(function (it) {
                var row = addRow();
                var pid = it.product_id != null ? String(it.product_id) : '';
                var p = pid && PROD_BY_ID[pid] ? PROD_BY_ID[pid] : null;
                if (p) applyProduct(row, p);        // sets the search label + product id
                // The stored line values win over the product defaults (they may
                // have been edited when the invoice was first created).
                if (it.hsn)  row.querySelector('.li-hsn').value  = it.hsn;
                if (it.unit) row.querySelector('.li-unit').value = it.unit;
                row.querySelector('.li-qty').value  = it.quantity != null ? it.quantity : 1;
                row.querySelector('.li-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.li-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                row.querySelector('.li-gst').value  = it.gst_rate != null ? it.gst_rate : 0;
                recalcRow(row);
            });
            recalcTotals();
        } else {
            addRow();
        }
    }
})();
