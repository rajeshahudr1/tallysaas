'use strict';

/* ─────────────────────────────────────────────────────────────
 * quotation.js — line-item engine + keyboard-first auto-advance flow
 * for the Create Quotation page.
 *
 * Loaded only on /quotations/create (via the layout `pageScript` slot).
 * Standalone file — does NOT import from invoice.js, though the row-clone /
 * delete / recompute-totals / items_json-on-submit pattern mirrors it.
 *
 * DOM contract (shipped by Task 4, views/quotations/create.ejs):
 *   Form: #quotation-form, hidden #items_json
 *   Header: #q-party, #q-ledger, #q-no (+ #q-no-edit), #q-date, #q-valid-till
 *   Table: <tbody id="q-body">, <template id="q-row-tpl">, #q-add-row
 *   Row: .q-item (hidden input) / .q-item-search (visible text box) / .q-qty /
 *        .q-rate / .q-unit / .q-disc / .q-hsn / .q-godown / .q-desc /
 *        .q-amount / .q-taxincl / .q-del
 *   Totals: #q-subtotal, #q-taxes, #q-grand
 *   Submit: #q-submit
 *   Products: window.QUOTATION_PRODUCTS [{id,name,hsn,unit,rate,gst,stock}]
 *
 * Money math mirrors QuotationController.computeTotals exactly (discount
 * first, then GST; a tax-inclusive line's rate already contains GST) — see
 * lineAmount/formTotals below. window.QuotationCalc exposes both so they can
 * be unit-tested without a DOM (web/tests/quotationFlow.test.js).
 * ─────────────────────────────────────────────────────────── */

// छूट पहले, GST बाद में। tax-inclusive line का rate GST समेत होता है।
function lineAmount(l) {
    const gross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
    const net0  = gross - gross * (Number(l.disc) || 0) / 100;
    const gst   = Number(l.gst) || 0;
    const net   = l.taxIncl ? net0 / (1 + gst / 100) : net0;
    return Math.round((net + net * gst / 100 + Number.EPSILON) * 100) / 100;
}

function formTotals(lines) {
    let subtotal = 0, taxes = 0, grand = 0;
    for (const l of lines) {
        const gross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
        const net0  = gross - gross * (Number(l.disc) || 0) / 100;
        const gst   = Number(l.gst) || 0;
        const net   = l.taxIncl ? net0 / (1 + gst / 100) : net0;
        subtotal += gross; taxes += net * gst / 100; grand += net + net * gst / 100;
    }
    const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    return { subtotal: r2(subtotal), taxes: r2(taxes), grand: r2(grand) };
}

window.QuotationCalc = { lineAmount, formTotals };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form  = document.getElementById('quotation-form');
        var tbody = document.getElementById('q-body');
        var tpl   = document.getElementById('q-row-tpl');
        var addBtn = document.getElementById('q-add-row');
        if (!form || !tbody || !tpl) return;

        var PRODUCTS = Array.isArray(window.QUOTATION_PRODUCTS) ? window.QUOTATION_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        function inr(n) {
            return '₹' + (Number(n) || 0).toLocaleString('en-IN', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
            });
        }

        function rowToLine(row) {
            return {
                qty:     parseFloat(row.querySelector('.q-qty').value) || 0,
                rate:    parseFloat(row.querySelector('.q-rate').value) || 0,
                disc:    parseFloat(row.querySelector('.q-disc').value) || 0,
                gst:     row.querySelector('.q-item').dataset.gst ? parseFloat(row.querySelector('.q-item').dataset.gst) : 0,
                taxIncl: !!row.querySelector('.q-taxincl').checked,
            };
        }

        function recalcRow(row) {
            var amt = lineAmount(rowToLine(row));
            row.querySelector('.q-amount').textContent = inr(amt);
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.q-row').forEach(function (row) { lines.push(rowToLine(row)); });
            var t = formTotals(lines);
            var subEl = document.getElementById('q-subtotal');
            var taxEl = document.getElementById('q-taxes');
            var grandEl = document.getElementById('q-grand');
            if (subEl) subEl.textContent = inr(t.subtotal);
            if (taxEl) taxEl.textContent = inr(t.taxes);
            if (grandEl) grandEl.textContent = inr(t.grand);
        }

        function resetRow(row) {
            var search = row.querySelector('.q-item-search');
            var hidden = row.querySelector('.q-item');
            if (search) search.value = '';
            if (hidden) { hidden.value = ''; delete hidden.dataset.gst; }
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.q-hsn').value  = '';
            row.querySelector('.q-unit').value = '';
            row.querySelector('.q-qty').value  = '1';
            row.querySelector('.q-rate').value = '0';
            row.querySelector('.q-disc').value = '0';
            row.querySelector('.q-taxincl').checked = false;
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .q-item, plus
        // data-gst so rowToLine can read the GST%) + fill HSN/Unit/Rate.
        function applyProduct(row, p) {
            var search = row.querySelector('.q-item-search');
            var hidden = row.querySelector('.q-item');
            hidden.value = p ? String(p.id) : '';
            hidden.dataset.gst = p && p.gst != null ? p.gst : 0;
            if (search) search.value = p ? p.name : '';
            row.querySelector('.q-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.q-unit').value = p ? (p.unit || '') : '';
            if (p && p.rate != null) row.querySelector('.q-rate').value = p.rate;
            var qty = row.querySelector('.q-qty');
            if (qty) {
                if (p && p.stock != null) {
                    qty.max = p.stock;
                    qty.title = 'In stock: ' + p.stock;
                    if ((parseFloat(qty.value) || 0) > p.stock) qty.value = p.stock;
                } else {
                    qty.removeAttribute('max'); qty.title = '';
                }
            }
            recalcRow(row); recalcTotals();
        }

        function clampQty(row) {
            var qty = row.querySelector('.q-qty');
            if (!qty || qty.max === '' || qty.max == null) return;
            var maxV = parseFloat(qty.max);
            if (!isNaN(maxV) && (parseFloat(qty.value) || 0) > maxV) qty.value = maxV;
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.q-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget/markup as invoice.js's, but
        // wired here so choosing a product also drives the auto-advance flow
        // (jump to Qty on selection).
        function wireProductPicker(row) {
            var search = row.querySelector('.q-item-search');
            var hidden = row.querySelector('.q-item');
            var menu   = row.querySelector('.li-prod-menu');
            if (!search || !menu) return;
            var active = -1, items = [];

            function place() {
                var r = search.getBoundingClientRect();
                menu.style.left  = r.left + 'px';
                menu.style.top   = (r.bottom + 2) + 'px';
                menu.style.width = r.width + 'px';
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
                // auto-advance: item picked → jump to this row's Qty
                openField(row.querySelector('.q-qty'));
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
                if (e.key === 'Escape') { menu.hidden = true; return; } // close, keep focus — no blur()
                if (menu.hidden) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
                else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
            });
            search.addEventListener('blur', function () { setTimeout(function () { menu.hidden = true; }, 150); });
        }

        function wireRow(row) {
            wireProductPicker(row);
            row.querySelectorAll('.q-qty, .q-rate, .q-disc, .q-taxincl').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    if (inp.classList.contains('q-qty')) clampQty(row);
                    recalcRow(row); recalcTotals();
                });
                inp.addEventListener('change', function () { recalcRow(row); recalcTotals(); });
            });

            // Tally-style auto-advance: Qty → Enter → Rate; Rate → Enter →
            // next row's item picker (or a brand-new row if this was last).
            // Only Enter is intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.q-qty').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); openField(row.querySelector('.q-rate')); }
            });
            row.querySelector('.q-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    openField(newRow.querySelector('.q-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) openField(next.querySelector('.q-item-search'));
                }
            });

            row.querySelector('.q-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.q-row').length > 1) {
                    row.remove();
                } else {
                    resetRow(row); // keep at least one row
                }
                recalcTotals();
            });
        }

        function addRow() {
            var node = tpl.content.firstElementChild.cloneNode(true);
            tbody.appendChild(node);
            wireRow(node);
            recalcRow(node);
            recalcTotals();
            return node;
        }

        if (addBtn) addBtn.addEventListener('click', function () {
            var newRow = addRow();
            openField(newRow.querySelector('.q-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        form.addEventListener('submit', function () {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            tbody.querySelectorAll('.q-row').forEach(function (row) {
                var prod = row.querySelector('.q-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.q-qty').value) || 0;
                if (!pid && qty <= 0) return;
                items.push({
                    product_id:    pid ? Number(pid) : null,
                    description:   row.querySelector('.q-desc').value || '',
                    hsn:           row.querySelector('.q-hsn').value || '',
                    quantity:      qty,
                    unit:          row.querySelector('.q-unit').value || '',
                    rate:          parseFloat(row.querySelector('.q-rate').value) || 0,
                    discount_pct:  parseFloat(row.querySelector('.q-disc').value) || 0,
                    gst_rate:      prod && prod.dataset.gst ? parseFloat(prod.dataset.gst) : 0,
                    godown:        row.querySelector('.q-godown').value || '',
                    tax_inclusive: !!row.querySelector('.q-taxincl').checked,
                });
            });
            hidden.value = JSON.stringify(items);
        });

        // ══════════════════════════════════════════════════════════════
        // Auto-advance flow — Tally जैसा keyboard-first क्रम: एक field पूरा
        // होते ही अगला अपने आप खुलता है, ताकि पूरा voucher बिना माउस छुए
        // बन जाए।
        // ══════════════════════════════════════════════════════════════
        var FLOW = ['#q-party', '#q-ledger', '#q-date', '#q-valid-till'];

        function openField(el) {
            if (!el) return;
            el.focus();
            if (el.tagName === 'SELECT' && typeof el.showPicker === 'function') { try { el.showPicker(); } catch (_) {} }
            if (el.select) el.select();       // text field → पुराना मान चुना हुआ, सीधे टाइप करो
        }

        FLOW.forEach(function (sel, i) {
            var el = document.querySelector(sel);
            if (!el) return;
            el.addEventListener('change', function () {
                var nextSel = FLOW[i + 1];
                if (nextSel) {
                    openField(document.querySelector(nextSel));
                } else {
                    // last header field → first row's item picker
                    var firstRow = tbody.querySelector('.q-row');
                    if (firstRow) openField(firstRow.querySelector('.q-item-search'));
                }
            });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { e.stopPropagation(); } // close any native picker, keep focus
            });
        });

        // Seed the table with a single empty row, then open Party.
        addRow();
        openField(document.querySelector('#q-party'));
    }
})();
