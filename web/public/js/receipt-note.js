'use strict';

/* ─────────────────────────────────────────────────────────────
 * receipt-note.js — line-item engine + keyboard-first auto-advance flow
 * for the Create Receipt Note page.
 *
 * Loaded only on /receipt-notes/create (via the layout `pageScript` slot).
 * Own copy of delivery-note.js's flow (not shared) — does NOT import from
 * invoice.js/quotation.js/sales-order.js/purchase-order.js/delivery-note.js,
 * though the row-clone / delete / recompute-totals / items_json-on-submit
 * pattern mirrors all of them.
 *
 * Two deliberate differences from Delivery Note:
 *   1. The party is a SUPPLIER (window.RECEIPT_NOTE_PARTIES), not a customer.
 *   2. There is NO "Create New Supplier" modal/combobox createLabel here —
 *      creating a supplier mid-voucher is out of scope for this module
 *      (same call Purchase Order made).
 *
 * DOM contract (shipped by Task 4, views/receipt-notes/create.ejs):
 *   Form: #receipt-note-form, hidden #items_json
 *   Header: #rn-party, #rn-ledger, #rn-no (+ #rn-no-edit), #rn-date, #rn-received, #rn-order
 *   Table: <tbody id="rn-body">, <template id="rn-row-tpl">, #rn-add-row
 *   Row: .rn-item (hidden input) / .rn-item-search (visible text box) / .rn-qty /
 *        .rn-rate / .rn-unit / .rn-disc / .rn-hsn / .rn-godown / .rn-desc /
 *        .rn-amount / .rn-taxincl / .rn-del
 *   Totals: #rn-subtotal, #rn-taxes, #rn-grand
 *   Submit: #rn-submit
 *   Products: window.RECEIPT_NOTE_PRODUCTS [{id,name,hsn,unit,rate,gst,stock}]
 *
 * Money math mirrors ReceiptNoteController.computeTotals exactly (discount
 * first, then GST; a tax-inclusive line's rate already contains GST) — see
 * lineAmount/formTotals below. window.ReceiptNoteCalc exposes both so they
 * can be unit-tested without a DOM (web/tests/receiptNoteFlow.test.js).
 * ─────────────────────────────────────────────────────────── */

// छूट पहले, GST बाद में। tax-inclusive line का rate GST समेत होता है।
function lineAmount(l) {
    const gross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
    const net0  = gross - gross * (Number(l.disc) || 0) / 100;
    const gst   = Number(l.gst) || 0;
    const net   = l.taxIncl ? net0 / (1 + gst / 100) : net0;
    return Math.round((net + net * gst / 100 + Number.EPSILON) * 100) / 100;
}

/**
 * Totals for the on-screen panel.
 *
 * `subtotal` is the TAXABLE value — after discount, with GST taken back out
 * of a tax-inclusive rate — so the panel always reads as arithmetic you can
 * follow: Sub Total + Taxes = Grand Total.
 *
 * It used to be the GROSS, which broke the display in two ways: a discounted
 * bill showed Sub Total + Taxes overshooting the stated Grand Total, and a
 * tax-inclusive line counted its GST twice on screen. `gross` and
 * `discount` are returned so the panel can show those rows too; the STORED
 * figures are computed server-side and are unchanged.
 */
function formTotals(lines) {
    let gross = 0, discount = 0, taxable = 0, taxes = 0;
    for (const l of lines) {
        const lineGross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
        const disc  = lineGross * (Number(l.disc) || 0) / 100;
        const net0  = lineGross - disc;
        const gst   = Number(l.gst) || 0;
        const net   = l.taxIncl ? net0 / (1 + gst / 100) : net0;
        gross += lineGross; discount += disc; taxable += net; taxes += net * gst / 100;
    }
    const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    return {
        gross: r2(gross), discount: r2(discount), subtotal: r2(taxable),
        taxes: r2(taxes), grand: r2(taxable + taxes),
    };
}

// Custom Note No popup (LiveKeeping's Default/Custom panel, our theme) —
// joins Prefix/Voucher no/Suffix exactly as typed, trimmed, skipping empty
// parts. Pure function so it's unit-testable without a DOM.
function buildVoucherNo(parts) {
    var p = parts || {};
    return [p.prefix, p.number, p.suffix]
        .map(function (v) { return (v == null ? '' : String(v)).trim(); })
        .filter(function (v) { return v !== ''; })
        .join('');
}

window.ReceiptNoteCalc = { lineAmount, formTotals, buildVoucherNo };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form  = document.getElementById('receipt-note-form');
        var tbody = document.getElementById('rn-body');
        var tpl   = document.getElementById('rn-row-tpl');
        var addBtn = document.getElementById('rn-add-row');
        if (!form || !tbody || !tpl) return;

        // Price level, party balance, the Buyer/Consignee/Dispatch/Order block
        // and the richer item option are identical on all six voucher forms —
        // they live in voucher-extras.js, driven by this form's id prefix.
        var VX = window.VoucherExtras;

        var PRODUCTS = Array.isArray(window.RECEIPT_NOTE_PRODUCTS) ? window.RECEIPT_NOTE_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        var PARTIES = Array.isArray(window.RECEIPT_NOTE_PARTIES) ? window.RECEIPT_NOTE_PARTIES : [];
        var LEDGERS = Array.isArray(window.RECEIPT_NOTE_LEDGERS) ? window.RECEIPT_NOTE_LEDGERS : [];
        var ORDERS  = Array.isArray(window.RECEIPT_NOTE_ORDERS)  ? window.RECEIPT_NOTE_ORDERS  : [];
        var ORDER_BY_ID = {};
        ORDERS.forEach(function (o) { ORDER_BY_ID[String(o.id)] = o; });

        // ── One popup/dropdown open at a time ──
        // Every custom menu (product picker, party/ledger/order combobox) and
        // every native <select> registers a close-callback here before it
        // opens. Opening any of them closes everything else first, so a menu
        // never lingers on top after a different one has already opened.
        // Outside click and Esc close whatever is currently open.
        var openPopups = []; // [{ els: Node[], close: fn }]
        function closeAllPopups() {
            var list = openPopups;
            openPopups = [];
            list.forEach(function (p) { p.close(); });
        }
        // Call right before a popup opens: closes every other registered
        // popup first, then tracks this one so a later open (or an outside
        // click/Esc) can close it in turn.
        // Re-registering the SAME popup must not close it: a single click fires
        // both mousedown and focus, and each one re-opens (and so re-registers)
        // the combobox. Closing "everything else" blindly would run this popup's
        // own close() right after it opened, so the menu flashed shut and the
        // field looked dead. Close only the OTHERS.
        function registerPopup(els, closeFn) {
            var others = openPopups.filter(function (p) { return p.close !== closeFn; });
            openPopups = [];
            others.forEach(function (p) { p.close(); });
            openPopups = [{ els: els, close: closeFn }];
        }
        function forgetPopup(closeFn) {
            openPopups = openPopups.filter(function (p) { return p.close !== closeFn; });
        }
        document.addEventListener('mousedown', function (e) {
            openPopups.slice().forEach(function (p) {
                var inside = p.els.some(function (el) { return el && el.contains(e.target); });
                if (!inside) p.close();
            });
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeAllPopups();
        });

        function inr(n) {
            return '₹' + (Number(n) || 0).toLocaleString('en-IN', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
            });
        }

        function rowToLine(row) {
            return {
                qty:     parseFloat(row.querySelector('.rn-qty').value) || 0,
                rate:    parseFloat(row.querySelector('.rn-rate').value) || 0,
                disc:    parseFloat(row.querySelector('.rn-disc').value) || 0,
                gst:     row.querySelector('.rn-item').dataset.gst ? parseFloat(row.querySelector('.rn-item').dataset.gst) : 0,
                taxIncl: !!row.querySelector('.rn-taxincl').checked,
            };
        }

        function recalcRow(row) {
            var amt = lineAmount(rowToLine(row));
            row.querySelector('.rn-amount').textContent = inr(amt);
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.rn-row').forEach(function (row) { lines.push(rowToLine(row)); });
            var t = formTotals(lines);
            var subEl = document.getElementById('rn-subtotal');
            var taxEl = document.getElementById('rn-taxes');
            var grandEl = document.getElementById('rn-grand');
            if (subEl) subEl.textContent = inr(t.subtotal);
            if (taxEl) taxEl.textContent = inr(t.taxes);
            if (grandEl) grandEl.textContent = inr(t.grand);
            // Gross + Discount only appear once there IS a discount, so a
            // plain bill stays three clean rows.
            var hasDisc = t.discount > 0;
            var grossEl = document.getElementById('rn-gross');
            var grossRow = document.getElementById('rn-gross-row');
            var discEl = document.getElementById('rn-discount');
            var discRow = document.getElementById('rn-discount-row');
            if (grossEl) grossEl.textContent = inr(t.gross);
            if (grossRow) grossRow.hidden = !hasDisc;
            if (discEl) discEl.textContent = '− ' + inr(t.discount);
            if (discRow) discRow.hidden = !hasDisc;
        }

        function resetRow(row) {
            var search = row.querySelector('.rn-item-search');
            var hidden = row.querySelector('.rn-item');
            if (search) search.value = '';
            if (hidden) { hidden.value = ''; delete hidden.dataset.gst; }
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.rn-hsn').value  = '';
            row.querySelector('.rn-unit').value = '';
            row.querySelector('.rn-qty').value  = '1';
            row.querySelector('.rn-rate').value = '0';
            row.querySelector('.rn-disc').value = '0';
            row.querySelector('.rn-taxincl').checked = false;
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .rn-item, plus
        // data-gst so rowToLine can read the GST%) + fill HSN/Unit/Rate.
        function applyProduct(row, p) {
            var search = row.querySelector('.rn-item-search');
            var hidden = row.querySelector('.rn-item');
            hidden.value = p ? String(p.id) : '';
            hidden.dataset.gst = p && p.gst != null ? p.gst : 0;
            if (search) search.value = p ? p.name : '';
            row.querySelector('.rn-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.rn-unit').value = p ? (p.unit || '') : '';
            // Rate: the chosen PRICE LEVEL wins where it covers this item —
            // that is the whole point of picking a level — otherwise the item's
            // own standard price.
            if (p && !VX.applyLevelToRow(row, p.name) && p.rate != null) {
                row.querySelector('.rn-rate').value = p.rate;
            }
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.rn-qty').disabled = false;
            var qty = row.querySelector('.rn-qty');
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

        function clampQty(row) {
            var qty = row.querySelector('.rn-qty');
            if (!qty || qty.max === '' || qty.max == null) return;
            var maxV = parseFloat(qty.max);
            if (!isNaN(maxV) && (parseFloat(qty.value) || 0) > maxV) qty.value = maxV;
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.rn-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget/markup as invoice.js's, but
        // wired here so choosing a product also drives the auto-advance flow
        // (jump to Qty on selection).
        function wireProductPicker(row) {
            var search = row.querySelector('.rn-item-search');
            var hidden = row.querySelector('.rn-item');
            var menu   = row.querySelector('.li-prod-menu');
            if (!search || !menu) return;
            var active = -1, items = [];

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
                        VX.decorateProductOption(d, p);
                        d.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
                        menu.appendChild(d);
                    });
                }
                menu.hidden = false;
                registerPopup([search, menu], closePicker);
                place();
            }
            function closePicker() {
                menu.hidden = true;
                forgetPopup(closePicker);
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
                closePicker();
                // auto-advance: item picked → jump to this row's Qty
                openField(row.querySelector('.rn-qty'));
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
                if (e.key === 'Escape') { closePicker(); return; } // close, keep focus — no blur()
                if (menu.hidden) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
                else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
            });
            search.addEventListener('blur', function () { setTimeout(closePicker, 150); });
        }

        function wireRow(row) {
            wireProductPicker(row);
            row.querySelectorAll('.rn-qty, .rn-rate, .rn-disc, .rn-taxincl').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    if (inp.classList.contains('rn-qty')) { clampQty(row); VX.applySlabRate(row); }
                    recalcRow(row); recalcTotals();
                });
                inp.addEventListener('change', function () { recalcRow(row); recalcTotals(); });
            });

            // Tally-style auto-advance: Qty → Enter → Rate; Rate → Enter →
            // next row's item picker (or a brand-new row if this was last).
            // Only Enter is intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.rn-qty').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var rate = row.querySelector('.rn-rate');
                    rate.disabled = false; // Qty done → Rate step unlocks
                    openField(rate);
                }
            });
            row.querySelector('.rn-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    newRow.querySelector('.rn-item-search').disabled = false;
                    openField(newRow.querySelector('.rn-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) {
                        next.querySelector('.rn-item-search').disabled = false;
                        openField(next.querySelector('.rn-item-search'));
                    }
                }
            });

            row.querySelector('.rn-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.rn-row').length > 1) {
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
            newRow.querySelector('.rn-item-search').disabled = false;
            openField(newRow.querySelector('.rn-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        form.addEventListener('submit', function () {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            tbody.querySelectorAll('.rn-row').forEach(function (row) {
                var prod = row.querySelector('.rn-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.rn-qty').value) || 0;
                if (!pid && qty <= 0) return;
                items.push({
                    product_id:    pid ? Number(pid) : null,
                    description:   row.querySelector('.rn-desc').value || '',
                    hsn:           row.querySelector('.rn-hsn').value || '',
                    quantity:      qty,
                    unit:          row.querySelector('.rn-unit').value || '',
                    rate:          parseFloat(row.querySelector('.rn-rate').value) || 0,
                    discount_pct:  parseFloat(row.querySelector('.rn-disc').value) || 0,
                    gst_rate:      prod && prod.dataset.gst ? parseFloat(prod.dataset.gst) : 0,
                    godown:        row.querySelector('.rn-godown').value || '',
                    tax_inclusive: !!row.querySelector('.rn-taxincl').checked,
                });
            });
            hidden.value = JSON.stringify(items);
        });

        // ══════════════════════════════════════════════════════════════
        // Auto-advance flow — Tally जैसा keyboard-first क्रम: एक field पूरा
        // होते ही अगला अपने आप खुलता है, ताकि पूरा voucher बिना माउस छुए
        // बन जाए। Party और Ledger Type custom searchable comboboxes हैं
        // (native <select> पर showPicker() भरोसेमंद नहीं है) — नीचे
        // makeCombobox() दोनों के लिए एक ही generic widget देता है, ठीक
        // उसी li-prod-* markup/CSS का इस्तेमाल करके जो item picker पहले से
        // इस्तेमाल करता है।
        // ══════════════════════════════════════════════════════════════

        function openField(el) {
            if (!el || el.disabled) return;
            el.focus();
            if (el.tagName === 'SELECT' && typeof el.showPicker === 'function') { try { el.showPicker(); } catch (_) {} }
            if (el.select) el.select();       // text field → पुराना मान चुना हुआ, सीधे टाइप करो
        }

        // Generic searchable combobox: input + hidden(optional) + menu div,
        // matching the li-prod-* widget already shipped for the item picker.
        // opts: { input, hidden, menu, list, getLabel, getValue, getSubLabel,
        //         onChoose, clearBtn }
        //
        // Behaviour: once a value is picked, the field is NOT done — focusing/
        // clicking it again reopens the FULL list (not filtered down to the
        // one already-chosen label) so a different item can be picked; typing
        // still filters as usual. clearBtn (×) wipes the selection.
        function makeCombobox(opts) {
            var active = -1, items = [];

            function fullList() {
                return opts.list.slice(0, 50);
            }

            function place() {
                var r = opts.input.getBoundingClientRect();
                opts.menu.style.left  = r.left + 'px';
                opts.menu.style.top   = (r.bottom + 2) + 'px';
                opts.menu.style.width = r.width + 'px';
                // A line-item cell is ~200px wide; the option under it carries an HSN and a
                // stock figure as well as the name. Let the menu outgrow its field rather
                // than clip what it was opened to show — clamped so it never leaves the
                // viewport on a narrow screen.
                opts.menu.style.minWidth = Math.min(320, window.innerWidth - r.left - 16) + 'px';
            }
            function render(list) {
                opts.menu.innerHTML = '';
                items = list;
                active = -1;
                if (!list.length) {
                    opts.menu.innerHTML = '<div class="li-prod-empty">No matches</div>';
                } else {
                    list.forEach(function (it, i) {
                        var d = document.createElement('div');
                        d.setAttribute('data-i', i);
                        d.className = 'li-prod-item';
                        var sub = opts.getSubLabel ? opts.getSubLabel(it) : '';
                        if (sub) {
                            d.textContent = '';
                            var main = document.createElement('span');
                            main.textContent = opts.getLabel(it);
                            var subEl = document.createElement('span');
                            subEl.className = 'li-prod-sub';
                            subEl.textContent = sub;
                            d.appendChild(main);
                            d.appendChild(subEl);
                        } else {
                            d.textContent = opts.getLabel(it);
                        }
                        d.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
                        opts.menu.appendChild(d);
                    });
                }
                opts.menu.hidden = false;
                registerPopup([opts.input, opts.menu], close);
                place();
            }
            function filter() {
                var q = opts.input.value.trim().toLowerCase();
                var list = !q ? opts.list.slice(0, 50)
                    : opts.list.filter(function (it) { return opts.getLabel(it).toLowerCase().indexOf(q) > -1; }).slice(0, 50);
                render(list);
            }
            function close() { opts.menu.hidden = true; forgetPopup(close); }
            function updateClear() {
                if (!opts.clearBtn) return;
                opts.clearBtn.hidden = !(opts.hidden && opts.hidden.value);
            }
            function choose(i) {
                var it = items[i];
                if (!it) return;
                opts.input.value = opts.getLabel(it);
                if (opts.hidden) opts.hidden.value = opts.getValue(it);
                updateClear();
                close();
                if (opts.onChoose) opts.onChoose(it);
            }
            function highlight() {
                opts.menu.querySelectorAll('.li-prod-item').forEach(function (el, i) {
                    el.classList.toggle('is-active', i === active);
                });
                var el = opts.menu.querySelector('.is-active');
                if (el) el.scrollIntoView({ block: 'nearest' });
            }

            window.addEventListener('scroll', function () { if (!opts.menu.hidden) place(); }, true);
            window.addEventListener('resize', function () { if (!opts.menu.hidden) place(); });

            opts.input.addEventListener('input', function () { if (opts.hidden) opts.hidden.value = ''; updateClear(); filter(); });
            // Focusing/clicking an already-filled field reopens the FULL list
            // (LiveKeeping behaviour), not a filter of the current label.
            opts.input.addEventListener('focus', function () { if (!opts.input.disabled) render(fullList()); });
            opts.input.addEventListener('mousedown', function () { if (!opts.input.disabled && opts.menu.hidden) render(fullList()); });
            opts.input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { close(); return; } // close, keep focus — no blur()
                if (opts.menu.hidden) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
                else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
            });
            opts.input.addEventListener('blur', function () { setTimeout(close, 150); });

            if (opts.clearBtn) {
                opts.clearBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
                opts.clearBtn.addEventListener('click', function () {
                    opts.input.value = '';
                    if (opts.hidden) opts.hidden.value = '';
                    updateClear();
                    openField(opts.input);
                    render(fullList());
                });
                updateClear();
            }

            // Insert an item at the front of the live list, select it, and
            // continue the flow — used by the order-prefill supplier fill.
            function addAndSelect(it) {
                opts.list.unshift(it);
                opts.input.value = opts.getLabel(it);
                if (opts.hidden) opts.hidden.value = opts.getValue(it);
                updateClear();
                close();
                if (opts.onChoose) opts.onChoose(it);
            }

            return { open: function () { openField(opts.input); filter(); }, addAndSelect: addAndSelect };
        }

        // ── Note No — Default/Custom popup ──
        // Pencil opens a small panel (registered through the shared
        // registerPopup()/closeAllPopups() gate above): Default leaves the
        // #rn-no field empty ("Auto-generated on save" placeholder — the
        // server's own series fills it in, untouched by this feature) while
        // Custom composes buildVoucherNo({prefix, number, suffix}) into it.
        (function wireNoteNoPopup() {
            var editBtn   = document.getElementById('rn-no-edit');
            var popup     = document.getElementById('rn-no-popup');
            var noInput   = document.getElementById('rn-no');
            var modeDefault = document.getElementById('rn-no-mode-default');
            var modeCustom  = document.getElementById('rn-no-mode-custom');
            var fieldsWrap  = document.getElementById('rn-no-popup-fields');
            var prefixEl = document.getElementById('rn-no-prefix');
            var numberEl = document.getElementById('rn-no-number');
            var suffixEl = document.getElementById('rn-no-suffix');
            var cancelBtn = document.getElementById('rn-no-cancel');
            var saveBtn   = document.getElementById('rn-no-save');
            if (!editBtn || !popup || !noInput) return;

            function syncFieldsVisibility() {
                fieldsWrap.hidden = !modeCustom.checked;
            }
            modeDefault.addEventListener('change', syncFieldsVisibility);
            modeCustom.addEventListener('change', syncFieldsVisibility);

            function closePopup() {
                popup.hidden = true;
                forgetPopup(closePopup);
            }
            function openPopup() {
                // Re-open reflects the field's current mode: a value already
                // in #rn-no means Custom was saved before — restore its parts
                // roughly by leaving mode as-is (prefix/number/suffix inputs
                // keep whatever the user last typed in this session).
                registerPopup([editBtn, popup], closePopup);
                popup.hidden = false;
                syncFieldsVisibility();
                (modeCustom.checked ? prefixEl : editBtn).focus();
            }

            editBtn.addEventListener('click', function () {
                if (popup.hidden) openPopup(); else closePopup();
            });
            if (cancelBtn) cancelBtn.addEventListener('click', closePopup);
            if (saveBtn) saveBtn.addEventListener('click', function () {
                if (modeCustom.checked) {
                    var built = buildVoucherNo({ prefix: prefixEl.value, number: numberEl.value, suffix: suffixEl.value });
                    noInput.value = built;
                } else {
                    noInput.value = '';
                }
                closePopup();
            });
        })();

        var dateEl = document.getElementById('rn-date');
        var receivedEl = document.getElementById('rn-received');
        var ledgerEl = document.getElementById('rn-ledger');

        // Ledger Type step unlocks after Party is picked — unless the tenant
        // has zero synced purchase ledgers, in which case it stays honestly
        // disabled forever and Date unlocks right away instead.
        function unlockLedgerOrDate() {
            if (LEDGERS.length && ledgerBox) {
                ledgerEl.disabled = false;
                ledgerBox.open();
            } else {
                unlockDate();
            }
        }
        function unlockDate() {
            if (!dateEl) return;
            dateEl.disabled = false;
            openField(dateEl);
        }
        // Received On and Against Order are both OPTIONAL and never block
        // the flow — Date's own 'change' unlocks Received On (so the
        // keyboard can move straight through it) and, independent of whether
        // the user fills Received On or the Order field, the first item row
        // unlocks as soon as Date is set.
        function unlockReceivedAndOrder() {
            if (receivedEl) receivedEl.disabled = false;
            if (orderEl) orderEl.disabled = false;
            unlockFirstItem();
        }
        function unlockFirstItem() {
            if (addBtn) addBtn.disabled = false;
            var firstRow = tbody.querySelector('.rn-row');
            if (!firstRow) return;
            var search = firstRow.querySelector('.rn-item-search');
            if (search.disabled) { // only auto-focus the very first time
                search.disabled = false;
                openField(search);
            }
        }

        var partyBox = makeCombobox({
            input:  document.getElementById('rn-party'),
            hidden: document.getElementById('rn-party-id'),
            menu:   document.getElementById('rn-party-menu'),
            clearBtn: document.getElementById('rn-party-clear'),
            list:   PARTIES,
            getLabel: function (p) { return p.name; },
            // Where the party stands right now, beside their name. The options
            // API now carries the synced Tally closing balance, so this is the
            // real figure — and it is omitted, rather than faked as ₹0.00, for a
            // party with no synced ledger.
            getSubLabel: function (p) { return p.balance == null ? '' : VX.drCr(p.balance); },
            getValue: function (p) { return p.id; },
            onChoose: function (p) {
                VX.showPartyBalance(p);
                VX.prefillBuyerFrom(p);
                unlockLedgerOrDate(p);
            },
            // Clearing the party must clear what was shown ABOUT them, or the
            // balance of the party you just removed sits under an empty box.
            onClear: function () { VX.showPartyBalance(null); },
        });

        var ledgerBox = LEDGERS.length ? makeCombobox({
            input:  ledgerEl,
            hidden: null,
            menu:   document.getElementById('rn-ledger-menu'),
            list:   LEDGERS,
            getLabel: function (l) { return l.name; },
            getSubLabel: function (l) { return window.VoucherExtras.ledgerSubLabel(l); },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockReceivedAndOrder);

        VX.init({
            prefix: 'rn',
            form: form,
            onLevelChange: function reapplyPriceLevel() {
                tbody.querySelectorAll('.rn-row').forEach(function (row) {
                    var search = row.querySelector('.rn-item-search');
                    var name = search ? search.value : '';
                    if (!name) return;
                    if (!VX.applyLevelToRow(row, name)) {
                        // Level does not cover this item — back to its own price.
                        var prod = PROD_BY_ID[String(row.querySelector('.rn-item').value)];
                        if (prod && prod.rate != null) row.querySelector('.rn-rate').value = prod.rate;
                    }
                    recalcRow(row);
                });
                recalcTotals();
            },
        });

        // ══════════════════════════════════════════════════════════════
        // Against Purchase Order — prefill.
        //
        // Picking an order fetches its full detail (GET /receipt-notes/
        // order/:id, which proxies the api's GET /purchase-orders/:id) and
        // copies the supplier + item rows onto the form. If the user has
        // ALREADY typed something (party chosen, or any row already has an
        // item/qty), we do NOT wipe it silently: confirm() first, and if
        // they decline, only the order reference itself (#rn-order/-id)
        // stays attached — every field the user already touched is left
        // exactly as it was.
        // ══════════════════════════════════════════════════════════════
        var orderEl = document.getElementById('rn-order');

        // formHasUserData() is checked BEFORE the order is applied, so the
        // just-picked order's own id (already written into #rn-order-id by
        // the combobox's choose()) must not count as "user data" — only the
        // supplier and item rows matter here.
        function formHasUserData() {
            var partyIdEl = document.getElementById('rn-party-id');
            if (partyIdEl && partyIdEl.value) return true;
            var hasRow = false;
            tbody.querySelectorAll('.rn-row').forEach(function (row) {
                var prod = row.querySelector('.rn-item');
                var qty  = parseFloat(row.querySelector('.rn-qty').value) || 0;
                if ((prod && prod.value) || qty > 0) hasRow = true;
            });
            return hasRow;
        }

        function fillPartyFromOrder(o) {
            if (!o.supplier_id) return;
            partyBox.addAndSelect({ id: o.supplier_id, name: o.supplier || '' });
        }

        function fillItemsFromOrder(o) {
            var items = Array.isArray(o.items) ? o.items : [];
            // Clear existing rows down to a single blank one, then rebuild.
            tbody.querySelectorAll('.rn-row').forEach(function (row) { row.remove(); });
            if (!items.length) { addRow(); return; }
            items.forEach(function (it) {
                var row = addRow();
                var prodMatch = it.product_id != null ? PROD_BY_ID[String(it.product_id)] : null;
                var search = row.querySelector('.rn-item-search');
                var hidden = row.querySelector('.rn-item');
                search.disabled = false;
                hidden.value = it.product_id != null ? String(it.product_id) : '';
                hidden.dataset.gst = it.gst_rate != null ? it.gst_rate : 0;
                search.value = prodMatch ? prodMatch.name : (it.description || '');
                row.querySelector('.rn-hsn').value  = it.hsn || '';
                row.querySelector('.rn-unit').value = it.unit || '';
                row.querySelector('.rn-godown').value = it.godown || '';
                row.querySelector('.rn-desc').value = it.description || '';
                row.querySelector('.rn-qty').value  = it.quantity != null ? it.quantity : 0;
                row.querySelector('.rn-qty').disabled = false;
                row.querySelector('.rn-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.rn-rate').disabled = false;
                row.querySelector('.rn-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                row.querySelector('.rn-taxincl').checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
        }

        function applyOrderPrefill(o) {
            fillPartyFromOrder(o);
            fillItemsFromOrder(o);
        }

        function fetchOrderDetail(id) {
            return fetch('/receipt-notes/order/' + encodeURIComponent(id))
                .then(function (r) { return r.json(); })
                .then(function (j) { return (j && j.ok && j.data) ? j.data : null; })
                .catch(function () { return null; });
        }

        var orderBox = ORDERS.length ? makeCombobox({
            input:  orderEl,
            hidden: document.getElementById('rn-order-id'),
            menu:   document.getElementById('rn-order-menu'),
            clearBtn: document.getElementById('rn-order-clear'),
            list:   ORDERS,
            getLabel: function (o) { return o.order_no; },
            getSubLabel: function (o) { return o.supplier; },
            getValue: function (o) { return o.id; },
            onChoose: function (o) {
                // The hidden #rn-order-id already carries the picked order's id
                // at this point (makeCombobox.choose() writes it before firing
                // onChoose) — that's the "order stays referenced" half of the
                // "don't wipe, ask first" rule; it stands regardless of what the
                // user answers below.
                var already = formHasUserData();
                var proceed = function () {
                    fetchOrderDetail(o.id).then(function (detail) {
                        if (detail) applyOrderPrefill(detail);
                    });
                };
                if (already) {
                    var ok = window.confirm(
                        'This will replace the supplier and item rows you already entered ' +
                        'with the details from the selected purchase order. Continue?');
                    if (!ok) return; // decline → only the order reference (#rn-order-id) stays attached
                }
                proceed();
            },
        }) : null;

        // Seed the table with a single (locked) empty row, then open Party.
        // ── EDIT MODE ── set by the view for /receipt-notes/:id/edit.
        var EDIT = window.RECEIPT_NOTE_EDIT || null;
        if (EDIT) {
            var partyInput = document.getElementById('rn-party');
            if (partyInput && EDIT.supplier_name) partyInput.value = EDIT.supplier_name;
            if (ledgerEl && EDIT.ledger_name) ledgerEl.value = EDIT.ledger_name;
            var noEl = document.getElementById('rn-no');
            if (noEl && EDIT.note_no) noEl.value = EDIT.note_no;

            var lines = Array.isArray(EDIT.items) ? EDIT.items : [];
            if (!lines.length) { addRow(); }
            lines.forEach(function (it) {
                var row = addRow();
                var prod = PRODUCTS.filter(function (p) { return String(p.id) === String(it.product_id); })[0];
                if (prod) {
                    applyProduct(row, prod);
                } else {
                    var si = row.querySelector('.rn-item-search');
                    if (si) si.value = it.description || it.product_name || '';
                }
                row.querySelector('.rn-qty').value  = it.quantity != null ? it.quantity : 1;
                row.querySelector('.rn-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.rn-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                var hsn = row.querySelector('.rn-hsn');   if (hsn && it.hsn) hsn.value = it.hsn;
                var unit = row.querySelector('.rn-unit'); if (unit && it.unit) unit.value = it.unit;
                var tx = row.querySelector('.rn-taxincl'); if (tx) tx.checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
            return;
        }

        addRow();
        partyBox.open();
    }
})();
