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
            row.querySelector('.li-product').selectedIndex = 0;
            row.querySelector('.li-hsn').value  = '';
            row.querySelector('.li-unit').value = '';
            row.querySelector('.li-qty').value  = '1';
            row.querySelector('.li-rate').value = '0';
            row.querySelector('.li-disc').value = '0';
            row.querySelector('.li-gst').value  = '0';
            recalcRow(row);
        }

        function wireRow(row) {
            var prod = row.querySelector('.li-product');
            prod.addEventListener('change', function () {
                var opt = prod.options[prod.selectedIndex];
                row.querySelector('.li-hsn').value  = opt.getAttribute('data-hsn')  || '';
                row.querySelector('.li-unit').value = opt.getAttribute('data-unit') || '';
                if (opt.getAttribute('data-rate')) row.querySelector('.li-rate').value = opt.getAttribute('data-rate');
                if (opt.getAttribute('data-gst'))  row.querySelector('.li-gst').value  = opt.getAttribute('data-gst');
                recalcRow(row); recalcTotals();
            });
            row.querySelectorAll('.li-qty, .li-rate, .li-disc, .li-gst').forEach(function (inp) {
                inp.addEventListener('input', function () { recalcRow(row); recalcTotals(); });
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

        // Seed the table with one empty row.
        addRow();
    }
})();
