'use strict';

/* ─────────────────────────────────────────────────────────────
 * purchase-order.js — line-item engine + keyboard-first auto-advance flow
 * for the Create Purchase Order page.
 *
 * Loaded only on /purchase-orders/create (via the layout `pageScript` slot).
 * Own copy of sales-order.js's flow (not shared) — does NOT import from
 * sales-order.js/invoice.js/quotation.js, though the row-clone / delete /
 * recompute-totals / items_json-on-submit pattern mirrors all three.
 *
 * Three deliberate differences from sales-order.js:
 *   1. The party is a SUPPLIER (window.PURCHASE_ORDER_PARTIES from /suppliers,
 *      not /customers).
 *   2. The Ledger Type list is PURCHASE ledgers (window.PURCHASE_ORDER_LEDGERS
 *      from /tally/ledgers/purchase-options, not sales ledgers).
 *   3. There is NO "Create New Customer" modal — creating a supplier mid-
 *      voucher is out of scope; the party combobox has no createLabel/onCreate.
 *
 * DOM contract (shipped by Task 4, views/purchase-orders/create.ejs):
 *   Form: #purchase-order-form, hidden #items_json
 *   Header: #po-party, #po-ledger, #po-no (+ #po-no-edit), #po-date, #po-due-on
 *   Table: <tbody id="po-body">, <template id="po-row-tpl">, #po-add-row
 *   Row: .po-item (hidden input) / .po-item-search (visible text box) / .po-qty /
 *        .po-rate / .po-unit / .po-disc / .po-hsn / .po-godown / .po-desc /
 *        .po-amount / .po-taxincl / .po-del
 *   Totals: #po-subtotal, #po-taxes, #po-grand
 *   Submit: #po-submit
 *   Products: window.PURCHASE_ORDER_PRODUCTS [{id,name,hsn,unit,rate,gst,stock}]
 *
 * Money math mirrors PurchaseOrderController.computeTotals exactly (discount
 * first, then GST; a tax-inclusive line's rate already contains GST) — see
 * lineAmount/formTotals below. window.PurchaseOrderCalc exposes both so they
 * can be unit-tested without a DOM (web/tests/purchaseOrderFlow.test.js).
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

// Custom Order No popup (LiveKeeping's Default/Custom panel, our theme) —
// joins Prefix/Voucher no/Suffix exactly as typed, trimmed, skipping empty
// parts. Pure function so it's unit-testable without a DOM.
function buildVoucherNo(parts) {
    var p = parts || {};
    return [p.prefix, p.number, p.suffix]
        .map(function (v) { return (v == null ? '' : String(v)).trim(); })
        .filter(function (v) { return v !== ''; })
        .join('');
}

window.PurchaseOrderCalc = { lineAmount, formTotals, buildVoucherNo };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form  = document.getElementById('purchase-order-form');
        var tbody = document.getElementById('po-body');
        var tpl   = document.getElementById('po-row-tpl');
        var addBtn = document.getElementById('po-add-row');
        if (!form || !tbody || !tpl) return;

        // Price level, party balance, the Buyer/Consignee/Dispatch/Order block
        // and the richer item option are identical on all six voucher forms —
        // they live in voucher-extras.js, driven by this form's id prefix.
        var VX = window.VoucherExtras;

        var PRODUCTS = Array.isArray(window.PURCHASE_ORDER_PRODUCTS) ? window.PURCHASE_ORDER_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        var PARTIES = Array.isArray(window.PURCHASE_ORDER_PARTIES) ? window.PURCHASE_ORDER_PARTIES : [];
        var LEDGERS = Array.isArray(window.PURCHASE_ORDER_LEDGERS) ? window.PURCHASE_ORDER_LEDGERS : [];

        // ── One popup/dropdown open at a time ──
        // Every custom menu (product picker, party/ledger combobox) and every
        // native <select> registers a close-callback here before it opens.
        // Opening any of them closes everything else first, so a menu never
        // lingers on top after a different one has already opened. Outside
        // click and Esc close whatever is currently open.
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
                qty:     parseFloat(row.querySelector('.po-qty').value) || 0,
                rate:    parseFloat(row.querySelector('.po-rate').value) || 0,
                disc:    parseFloat(row.querySelector('.po-disc').value) || 0,
                gst:     row.querySelector('.po-item').dataset.gst ? parseFloat(row.querySelector('.po-item').dataset.gst) : 0,
                taxIncl: !!row.querySelector('.po-taxincl').checked,
            };
        }

        function recalcRow(row) {
            var amt = lineAmount(rowToLine(row));
            row.querySelector('.po-amount').textContent = inr(amt);
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.po-row').forEach(function (row) { lines.push(rowToLine(row)); });
            var t = formTotals(lines);
            var subEl = document.getElementById('po-subtotal');
            var taxEl = document.getElementById('po-taxes');
            var grandEl = document.getElementById('po-grand');
            if (subEl) subEl.textContent = inr(t.subtotal);
            if (taxEl) taxEl.textContent = inr(t.taxes);
            if (grandEl) grandEl.textContent = inr(t.grand);
            // Gross + Discount only appear once there IS a discount, so a
            // plain bill stays three clean rows.
            var hasDisc = t.discount > 0;
            var grossEl = document.getElementById('po-gross');
            var grossRow = document.getElementById('po-gross-row');
            var discEl = document.getElementById('po-discount');
            var discRow = document.getElementById('po-discount-row');
            if (grossEl) grossEl.textContent = inr(t.gross);
            if (grossRow) grossRow.hidden = !hasDisc;
            if (discEl) discEl.textContent = '− ' + inr(t.discount);
            if (discRow) discRow.hidden = !hasDisc;
        }

        function resetRow(row) {
            var search = row.querySelector('.po-item-search');
            var hidden = row.querySelector('.po-item');
            if (search) search.value = '';
            if (hidden) { hidden.value = ''; delete hidden.dataset.gst; }
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.po-hsn').value  = '';
            row.querySelector('.po-unit').value = '';
            row.querySelector('.po-qty').value  = '1';
            row.querySelector('.po-rate').value = '0';
            row.querySelector('.po-disc').value = '0';
            row.querySelector('.po-taxincl').checked = false;
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .po-item, plus
        // data-gst so rowToLine can read the GST%) + fill HSN/Unit/Rate.
        function applyProduct(row, p) {
            var search = row.querySelector('.po-item-search');
            var hidden = row.querySelector('.po-item');
            hidden.value = p ? String(p.id) : '';
            hidden.dataset.gst = p && p.gst != null ? p.gst : 0;
            if (search) search.value = p ? p.name : '';
            row.querySelector('.po-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.po-unit').value = p ? (p.unit || '') : '';
            // Rate: the chosen PRICE LEVEL wins where it covers this item —
            // that is the whole point of picking a level — otherwise the item's
            // own standard price.
            if (p && !VX.applyLevelToRow(row, p.name) && p.rate != null) {
                row.querySelector('.po-rate').value = p.rate;
            }
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.po-qty').disabled = false;
            var qty = row.querySelector('.po-qty');
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
            var qty = row.querySelector('.po-qty');
            if (!qty || qty.max === '' || qty.max == null) return;
            var maxV = parseFloat(qty.max);
            if (!isNaN(maxV) && (parseFloat(qty.value) || 0) > maxV) qty.value = maxV;
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.po-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget/markup as invoice.js's, but
        // wired here so choosing a product also drives the auto-advance flow
        // (jump to Qty on selection).
        function wireProductPicker(row) {
            var search = row.querySelector('.po-item-search');
            var hidden = row.querySelector('.po-item');
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
                openField(row.querySelector('.po-qty'));
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
            row.querySelectorAll('.po-qty, .po-rate, .po-disc, .po-taxincl').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    if (inp.classList.contains('po-qty')) { clampQty(row); VX.applySlabRate(row); }
                    recalcRow(row); recalcTotals();
                });
                inp.addEventListener('change', function () { recalcRow(row); recalcTotals(); });
            });

            // Tally-style auto-advance: Qty → Enter → Rate; Rate → Enter →
            // next row's item picker (or a brand-new row if this was last).
            // Only Enter is intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.po-qty').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var rate = row.querySelector('.po-rate');
                    rate.disabled = false; // Qty done → Rate step unlocks
                    openField(rate);
                }
            });
            row.querySelector('.po-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    newRow.querySelector('.po-item-search').disabled = false;
                    openField(newRow.querySelector('.po-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) {
                        next.querySelector('.po-item-search').disabled = false;
                        openField(next.querySelector('.po-item-search'));
                    }
                }
            });

            row.querySelector('.po-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.po-row').length > 1) {
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
            newRow.querySelector('.po-item-search').disabled = false;
            openField(newRow.querySelector('.po-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        form.addEventListener('submit', function () {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            tbody.querySelectorAll('.po-row').forEach(function (row) {
                var prod = row.querySelector('.po-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.po-qty').value) || 0;
                if (!pid && qty <= 0) return;
                items.push({
                    product_id:    pid ? Number(pid) : null,
                    description:   row.querySelector('.po-desc').value || '',
                    hsn:           row.querySelector('.po-hsn').value || '',
                    quantity:      qty,
                    unit:          row.querySelector('.po-unit').value || '',
                    rate:          parseFloat(row.querySelector('.po-rate').value) || 0,
                    discount_pct:  parseFloat(row.querySelector('.po-disc').value) || 0,
                    gst_rate:      prod && prod.dataset.gst ? parseFloat(prod.dataset.gst) : 0,
                    godown:        row.querySelector('.po-godown').value || '',
                    tax_inclusive: !!row.querySelector('.po-taxincl').checked,
                });
            });
            hidden.value = JSON.stringify(items);
        });

        // ══════════════════════════════════════════════════════════════
        // Auto-advance flow — Tally जैसा keyboard-first क्रम: एक field पूरा
        // होते ही अगला अपने आप खुलता है, ताकि पूरा voucher बिना माउस छुए
        // बन जाए। Supplier और Ledger Type custom searchable comboboxes हैं
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
        // Behaviour: once a value is picked, the field is NOT done —
        // focusing/clicking it again reopens the FULL list (not filtered down to
        // the one already-chosen label) so a different item can be picked;
        // typing still filters as usual. clearBtn (×) wipes the selection.
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

            return { open: function () { openField(opts.input); filter(); } };
        }

        // ── Order No — Default/Custom popup ──
        // Pencil opens a small panel (registered through the shared
        // registerPopup()/closeAllPopups() gate above): Default leaves the
        // #po-no field empty ("Auto-generated on save" placeholder — the
        // server's own series fills it in, untouched by this feature) while
        // Custom composes buildVoucherNo({prefix, number, suffix}) into it.
        (function wireOrderNoPopup() {
            var editBtn   = document.getElementById('po-no-edit');
            var popup     = document.getElementById('po-no-popup');
            var noInput   = document.getElementById('po-no');
            var modeDefault = document.getElementById('po-no-mode-default');
            var modeCustom  = document.getElementById('po-no-mode-custom');
            var fieldsWrap  = document.getElementById('po-no-popup-fields');
            var prefixEl = document.getElementById('po-no-prefix');
            var numberEl = document.getElementById('po-no-number');
            var suffixEl = document.getElementById('po-no-suffix');
            var cancelBtn = document.getElementById('po-no-cancel');
            var saveBtn   = document.getElementById('po-no-save');
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
                // in #po-no means Custom was saved before — restore its parts
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

        var dateEl = document.getElementById('po-date');
        var ledgerEl = document.getElementById('po-ledger');

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
        function unlockFirstItem() {
            if (addBtn) addBtn.disabled = false;
            var firstRow = tbody.querySelector('.po-row');
            if (!firstRow) return;
            var search = firstRow.querySelector('.po-item-search');
            search.disabled = false;
            openField(search);
        }

        var partyBox = makeCombobox({
            input:  document.getElementById('po-party'),
            hidden: document.getElementById('po-party-id'),
            menu:   document.getElementById('po-party-menu'),
            clearBtn: document.getElementById('po-party-clear'),
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
            menu:   document.getElementById('po-ledger-menu'),
            list:   LEDGERS,
            getLabel: function (l) { return l.name; },
            getSubLabel: function (l) { return window.VoucherExtras.ledgerSubLabel(l); },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockFirstItem);

        VX.init({
            prefix: 'po',
            form: form,
            onLevelChange: function reapplyPriceLevel() {
                tbody.querySelectorAll('.po-row').forEach(function (row) {
                    var search = row.querySelector('.po-item-search');
                    var name = search ? search.value : '';
                    if (!name) return;
                    if (!VX.applyLevelToRow(row, name)) {
                        // Level does not cover this item — back to its own price.
                        var prod = PROD_BY_ID[String(row.querySelector('.po-item').value)];
                        if (prod && prod.rate != null) row.querySelector('.po-rate').value = prod.rate;
                    }
                    recalcRow(row);
                });
                recalcTotals();
            },
        });

        // Seed the table with a single (locked) empty row, then open Party.
        // ── EDIT MODE ── set by the view for /purchase-orders/:id/edit.
        // Rebuild the saved lines and fill the header, then stop: the guided
        // walk-through is for a blank voucher, not one being corrected.
        var EDIT = window.PURCHASE_ORDER_EDIT || null;
        if (EDIT) {
            var partyInput = document.getElementById('po-party');
            if (partyInput && EDIT.supplier_name) partyInput.value = EDIT.supplier_name;
            if (ledgerEl && EDIT.ledger_name) ledgerEl.value = EDIT.ledger_name;
            var noEl = document.getElementById('po-no');
            if (noEl && EDIT.order_no) noEl.value = EDIT.order_no;

            var lines = Array.isArray(EDIT.items) ? EDIT.items : [];
            if (!lines.length) { addRow(); }
            lines.forEach(function (it) {
                var row = addRow();
                var prod = PRODUCTS.filter(function (p) { return String(p.id) === String(it.product_id); })[0];
                if (prod) {
                    applyProduct(row, prod);
                } else {
                    var si = row.querySelector('.po-item-search');
                    if (si) si.value = it.description || it.product_name || '';
                }
                row.querySelector('.po-qty').value  = it.quantity != null ? it.quantity : 1;
                row.querySelector('.po-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.po-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                var hsn = row.querySelector('.po-hsn');   if (hsn && it.hsn) hsn.value = it.hsn;
                var unit = row.querySelector('.po-unit'); if (unit && it.unit) unit.value = it.unit;
                var tx = row.querySelector('.po-taxincl'); if (tx) tx.checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
            return;
        }

        addRow();
        partyBox.open();
    }
})();
