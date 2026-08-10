'use strict';

/* ─────────────────────────────────────────────────────────────
 * sales-order.js — line-item engine + keyboard-first auto-advance flow
 * for the Create Sales Order page.
 *
 * Loaded only on /sales-orders/create (via the layout `pageScript` slot).
 * Own copy of quotation.js's flow (not shared) — does NOT import from
 * invoice.js/quotation.js, though the row-clone / delete / recompute-totals /
 * items_json-on-submit pattern mirrors both.
 *
 * DOM contract (shipped by Task 4, views/sales-orders/create.ejs):
 *   Form: #sales-order-form, hidden #items_json
 *   Header: #so-party, #so-ledger, #so-no (+ #so-no-edit), #so-date, #so-due-on
 *   Table: <tbody id="so-body">, <template id="so-row-tpl">, #so-add-row
 *   Row: .so-item (hidden input) / .so-item-search (visible text box) / .so-qty /
 *        .so-rate / .so-unit / .so-disc / .so-hsn / .so-godown / .so-desc /
 *        .so-amount / .so-taxincl / .so-del
 *   Totals: #so-subtotal, #so-taxes, #so-grand
 *   Submit: #so-submit
 *   Products: window.SALES_ORDER_PRODUCTS [{id,name,hsn,unit,rate,gst,stock}]
 *
 * Money math mirrors SalesOrderController.computeTotals exactly (discount
 * first, then GST; a tax-inclusive line's rate already contains GST) — see
 * lineAmount/formTotals below. window.SalesOrderCalc exposes both so they can
 * be unit-tested without a DOM (web/tests/salesOrderFlow.test.js).
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

window.SalesOrderCalc = { lineAmount, formTotals, buildVoucherNo };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form  = document.getElementById('sales-order-form');
        var tbody = document.getElementById('so-body');
        var tpl   = document.getElementById('so-row-tpl');
        var addBtn = document.getElementById('so-add-row');
        if (!form || !tbody || !tpl) return;

        // Price level, party balance, the Buyer/Consignee/Dispatch/Order block
        // and the richer item option are identical on all six voucher forms —
        // they live in voucher-extras.js, driven by this form's id prefix.
        var VX = window.VoucherExtras;

        var PRODUCTS = Array.isArray(window.SALES_ORDER_PRODUCTS) ? window.SALES_ORDER_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        var PARTIES = Array.isArray(window.SALES_ORDER_PARTIES) ? window.SALES_ORDER_PARTIES : [];
        var LEDGERS = Array.isArray(window.SALES_ORDER_LEDGERS) ? window.SALES_ORDER_LEDGERS : [];

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
        // Native <select> elements (Country/State/City) open their own OS
        // popup — we cannot control that popup directly, but opening one
        // must still close any custom li-prod-* menu left open elsewhere.
        function closeOthersOnNativeOpen(el) {
            el.addEventListener('mousedown', function () { closeAllPopups(); });
            el.addEventListener('focus', function () { closeAllPopups(); });
        }

        function inr(n) {
            return '₹' + (Number(n) || 0).toLocaleString('en-IN', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
            });
        }

        function rowToLine(row) {
            return {
                qty:     parseFloat(row.querySelector('.so-qty').value) || 0,
                rate:    parseFloat(row.querySelector('.so-rate').value) || 0,
                disc:    parseFloat(row.querySelector('.so-disc').value) || 0,
                gst:     row.querySelector('.so-item').dataset.gst ? parseFloat(row.querySelector('.so-item').dataset.gst) : 0,
                taxIncl: !!row.querySelector('.so-taxincl').checked,
            };
        }

        function recalcRow(row) {
            var amt = lineAmount(rowToLine(row));
            row.querySelector('.so-amount').textContent = inr(amt);
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.so-row').forEach(function (row) { lines.push(rowToLine(row)); });
            var t = formTotals(lines);
            var subEl = document.getElementById('so-subtotal');
            var taxEl = document.getElementById('so-taxes');
            var grandEl = document.getElementById('so-grand');
            if (subEl) subEl.textContent = inr(t.subtotal);
            if (taxEl) taxEl.textContent = inr(t.taxes);
            if (grandEl) grandEl.textContent = inr(t.grand);
            // Gross + Discount only appear once there IS a discount, so a
            // plain bill stays three clean rows.
            var hasDisc = t.discount > 0;
            var grossEl = document.getElementById('so-gross');
            var grossRow = document.getElementById('so-gross-row');
            var discEl = document.getElementById('so-discount');
            var discRow = document.getElementById('so-discount-row');
            if (grossEl) grossEl.textContent = inr(t.gross);
            if (grossRow) grossRow.hidden = !hasDisc;
            if (discEl) discEl.textContent = '− ' + inr(t.discount);
            if (discRow) discRow.hidden = !hasDisc;
        }

        function resetRow(row) {
            var search = row.querySelector('.so-item-search');
            var hidden = row.querySelector('.so-item');
            if (search) search.value = '';
            if (hidden) { hidden.value = ''; delete hidden.dataset.gst; }
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.so-hsn').value  = '';
            row.querySelector('.so-unit').value = '';
            row.querySelector('.so-qty').value  = '1';
            row.querySelector('.so-rate').value = '0';
            row.querySelector('.so-disc').value = '0';
            row.querySelector('.so-taxincl').checked = false;
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .so-item, plus
        // data-gst so rowToLine can read the GST%) + fill HSN/Unit/Rate.
        function applyProduct(row, p) {
            var search = row.querySelector('.so-item-search');
            var hidden = row.querySelector('.so-item');
            hidden.value = p ? String(p.id) : '';
            hidden.dataset.gst = p && p.gst != null ? p.gst : 0;
            if (search) search.value = p ? p.name : '';
            row.querySelector('.so-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.so-unit').value = p ? (p.unit || '') : '';
            // Rate: the chosen PRICE LEVEL wins where it covers this item —
            // that is the whole point of picking a level — otherwise the item's
            // own standard price.
            if (p && !VX.applyLevelToRow(row, p.name) && p.rate != null) {
                row.querySelector('.so-rate').value = p.rate;
            }
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.so-qty').disabled = false;
            var qty = row.querySelector('.so-qty');
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
            var qty = row.querySelector('.so-qty');
            if (!qty || qty.max === '' || qty.max == null) return;
            var maxV = parseFloat(qty.max);
            if (!isNaN(maxV) && (parseFloat(qty.value) || 0) > maxV) qty.value = maxV;
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.so-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget/markup as invoice.js's, but
        // wired here so choosing a product also drives the auto-advance flow
        // (jump to Qty on selection).
        function wireProductPicker(row) {
            var search = row.querySelector('.so-item-search');
            var hidden = row.querySelector('.so-item');
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
                openField(row.querySelector('.so-qty'));
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
            row.querySelectorAll('.so-qty, .so-rate, .so-disc, .so-taxincl').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    if (inp.classList.contains('so-qty')) { clampQty(row); VX.applySlabRate(row); }
                    recalcRow(row); recalcTotals();
                });
                inp.addEventListener('change', function () { recalcRow(row); recalcTotals(); });
            });

            // Tally-style auto-advance: Qty → Enter → Rate; Rate → Enter →
            // next row's item picker (or a brand-new row if this was last).
            // Only Enter is intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.so-qty').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var rate = row.querySelector('.so-rate');
                    rate.disabled = false; // Qty done → Rate step unlocks
                    openField(rate);
                }
            });
            row.querySelector('.so-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    newRow.querySelector('.so-item-search').disabled = false;
                    openField(newRow.querySelector('.so-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) {
                        next.querySelector('.so-item-search').disabled = false;
                        openField(next.querySelector('.so-item-search'));
                    }
                }
            });

            row.querySelector('.so-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.so-row').length > 1) {
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
            newRow.querySelector('.so-item-search').disabled = false;
            openField(newRow.querySelector('.so-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        form.addEventListener('submit', function () {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            tbody.querySelectorAll('.so-row').forEach(function (row) {
                var prod = row.querySelector('.so-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.so-qty').value) || 0;
                if (!pid && qty <= 0) return;
                items.push({
                    product_id:    pid ? Number(pid) : null,
                    description:   row.querySelector('.so-desc').value || '',
                    hsn:           row.querySelector('.so-hsn').value || '',
                    quantity:      qty,
                    unit:          row.querySelector('.so-unit').value || '',
                    rate:          parseFloat(row.querySelector('.so-rate').value) || 0,
                    discount_pct:  parseFloat(row.querySelector('.so-disc').value) || 0,
                    gst_rate:      prod && prod.dataset.gst ? parseFloat(prod.dataset.gst) : 0,
                    godown:        row.querySelector('.so-godown').value || '',
                    tax_inclusive: !!row.querySelector('.so-taxincl').checked,
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

        // Country → State → City cascade shared by the Add Customer modal.
        // countryEl/stateEl/cityEl are native <select>s; option value is the
        // NAME (what gets submitted — customers.country/state/city are plain
        // text columns), option.dataset.id is the numeric id used to fetch
        // the next level. `initial` (optional) lets a caller pre-select saved
        // names on edit even if a fetch hasn't populated the list yet — see
        // customers/form.ejs's equivalent inline cascade for the edit case.
        function fetchGeo(url) {
            return fetch(url).then(function (r) { return r.json(); })
                .then(function (j) { return (j && Array.isArray(j.data)) ? j.data : []; })
                .catch(function () { return []; });
        }
        function fillSelect(el, items, placeholder, selectedName) {
            var html = '<option value="">' + placeholder + '</option>';
            var found = false;
            items.forEach(function (it) {
                var sel = selectedName && String(it.name) === String(selectedName);
                if (sel) found = true;
                html += '<option value="' + it.name.replace(/"/g, '&quot;') + '" data-id="' + it.id + '"' + (sel ? ' selected' : '') + '>' + it.name + '</option>';
            });
            // Saved value not in the fetched list (stale/edited data) — keep it
            // visible and selected instead of silently discarding it.
            if (selectedName && !found) {
                html += '<option value="' + String(selectedName).replace(/"/g, '&quot;') + '" selected data-custom="1">' + selectedName + '</option>';
            }
            el.innerHTML = html;
        }
        function makeGeoCascade(opts) {
            var countryEl = opts.countryEl, stateEl = opts.stateEl, cityEl = opts.cityEl;
            if (!countryEl || !stateEl || !cityEl) return { reset: function () {}, setSaved: function () {} };

            function loadCountries(selectedName) {
                return fetchGeo('/geo/countries').then(function (list) {
                    fillSelect(countryEl, list, 'Select country', selectedName || 'India');
                    return list;
                });
            }
            function loadStates(countryId, selectedName) {
                stateEl.disabled = true;
                if (!countryId) { fillSelect(stateEl, [], 'Select country first', selectedName); return Promise.resolve([]); }
                return fetchGeo('/geo/states?country_id=' + encodeURIComponent(countryId)).then(function (list) {
                    fillSelect(stateEl, list, 'Select state', selectedName);
                    stateEl.disabled = false;
                    return list;
                });
            }
            function loadCities(stateId, selectedName) {
                cityEl.disabled = true;
                if (!stateId) { fillSelect(cityEl, [], 'Select state first', selectedName); return Promise.resolve([]); }
                return fetchGeo('/geo/cities?state_id=' + encodeURIComponent(stateId)).then(function (list) {
                    fillSelect(cityEl, list, 'Select city', selectedName);
                    cityEl.disabled = false;
                    return list;
                });
            }
            function selectedId(el) {
                var opt = el.options[el.selectedIndex];
                return opt ? opt.getAttribute('data-id') : null;
            }

            countryEl.addEventListener('change', function () { loadStates(selectedId(countryEl)); fillSelect(cityEl, [], 'Select state first'); });
            stateEl.addEventListener('change', function () { loadCities(selectedId(stateEl)); });

            // reset(saved): (re)populate for a fresh "Add Customer" open, or
            // pre-select saved names (edit mode) — the state/city fetches only
            // fire once we know the country/state's numeric id.
            function reset(saved) {
                saved = saved || {};
                loadCountries(saved.country).then(function () {
                    var cid = selectedId(countryEl);
                    return loadStates(cid, saved.state);
                }).then(function () {
                    var sid = selectedId(stateEl);
                    return loadCities(sid, saved.city);
                });
            }
            return { reset: reset };
        }

        // Generic searchable combobox: input + hidden(optional) + menu div,
        // matching the li-prod-* widget already shipped for the item picker.
        // opts: { input, hidden, menu, list, getLabel, getValue, getSubLabel,
        //         onChoose, clearBtn, createLabel, onCreate }
        //
        // Behaviour (change 3): once a value is picked, the field is NOT done —
        // focusing/clicking it again reopens the FULL list (not filtered down to
        // the one already-chosen label) so a different item can be picked;
        // typing still filters as usual. clearBtn (×) wipes the selection.
        function makeCombobox(opts) {
            var active = -1, items = [];
            var CREATE_MARK = { __create: true };

            function fullList() {
                var list = opts.list.slice(0, 50);
                return opts.createLabel ? [CREATE_MARK].concat(list) : list;
            }

            function place() {
                var r = opts.input.getBoundingClientRect();
                opts.menu.style.left  = r.left + 'px';
                opts.menu.style.top   = (r.bottom + 2) + 'px';
                opts.menu.style.width = r.width + 'px';
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
                        if (it === CREATE_MARK) {
                            d.className = 'li-prod-item li-prod-create';
                            d.innerHTML = '<i class="fa-solid fa-circle-plus"></i><span>' + opts.createLabel + '</span>';
                            d.addEventListener('mousedown', function (e) { e.preventDefault(); if (opts.onCreate) opts.onCreate(); });
                            opts.menu.appendChild(d);
                            return;
                        }
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
                if (opts.createLabel) list = [CREATE_MARK].concat(list);
                render(list);
            }
            function close() { opts.menu.hidden = true; forgetPopup(close); }
            function updateClear() {
                if (!opts.clearBtn) return;
                opts.clearBtn.hidden = !(opts.hidden && opts.hidden.value);
            }
            function choose(i) {
                var it = items[i];
                if (!it || it === CREATE_MARK) return;
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

            // Insert a freshly-created item at the front of the live list, select
            // it, and continue the flow — used by the "Create New Customer" row.
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

        // ── Order No — Default/Custom popup ──
        // Pencil opens a small panel (registered through the shared
        // registerPopup()/closeAllPopups() gate above): Default leaves the
        // #so-no field empty ("Auto-generated on save" placeholder — the
        // server's own series fills it in, untouched by this feature) while
        // Custom composes buildVoucherNo({prefix, number, suffix}) into it.
        (function wireOrderNoPopup() {
            var editBtn   = document.getElementById('so-no-edit');
            var popup     = document.getElementById('so-no-popup');
            var noInput   = document.getElementById('so-no');
            var modeDefault = document.getElementById('so-no-mode-default');
            var modeCustom  = document.getElementById('so-no-mode-custom');
            var fieldsWrap  = document.getElementById('so-no-popup-fields');
            var prefixEl = document.getElementById('so-no-prefix');
            var numberEl = document.getElementById('so-no-number');
            var suffixEl = document.getElementById('so-no-suffix');
            var cancelBtn = document.getElementById('so-no-cancel');
            var saveBtn   = document.getElementById('so-no-save');
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
                // in #so-no means Custom was saved before — restore its parts
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

        var dateEl = document.getElementById('so-date');
        var ledgerEl = document.getElementById('so-ledger');

        // Ledger Type step unlocks after Party is picked — unless the tenant
        // has zero synced sales ledgers, in which case it stays honestly
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
            var firstRow = tbody.querySelector('.so-row');
            if (!firstRow) return;
            var search = firstRow.querySelector('.so-item-search');
            search.disabled = false;
            openField(search);
        }

        var partyBox = makeCombobox({
            input:  document.getElementById('so-party'),
            hidden: document.getElementById('so-party-id'),
            menu:   document.getElementById('so-party-menu'),
            clearBtn: document.getElementById('so-party-clear'),
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
            createLabel: 'Create New Customer',
            onCreate: openNewCustomerModal,
        });

        // ── "Create New Customer" modal (change 4) ──
        // On save: create via /sales-orders/create/quick-customer (proxies the
        // real customers API), insert+select the new party in-memory, and
        // continue the normal auto-advance flow — nothing already typed on
        // the voucher is touched.
        // ── Country / State / City cascade (Add Customer modal) ──
        // Country choice fills State (disabled until then); State choice
        // fills City (disabled until then). India is preselected. Values are
        // stored/submitted as plain names (the customers table has no geo id
        // columns), so each <option value> is the name and the id only lives
        // on the option for the next fetch in the chain.
        var geoCascade = makeGeoCascade({
            countryEl: document.getElementById('so-nc-country'),
            stateEl:   document.getElementById('so-nc-state'),
            cityEl:    document.getElementById('so-nc-city'),
        });
        [document.getElementById('so-nc-country'), document.getElementById('so-nc-state'), document.getElementById('so-nc-city')]
            .forEach(function (el) { if (el) closeOthersOnNativeOpen(el); });

        var ncModalEl = document.getElementById('so-new-customer-modal');
        var ncModal = (ncModalEl && window.bootstrap && window.bootstrap.Modal)
            ? new window.bootstrap.Modal(ncModalEl) : null;
        var ncErr = document.getElementById('so-nc-error');
        var ncSave = document.getElementById('so-nc-save');

        function openNewCustomerModal() {
            if (!ncModal) return;
            if (ncErr) ncErr.hidden = true;
            var nameEl = document.getElementById('so-nc-name');
            if (nameEl) nameEl.value = document.getElementById('so-party').value.trim();
            ['so-nc-mobile', 'so-nc-email', 'so-nc-gst', 'so-nc-address',
             'so-nc-ledger-group', 'so-nc-opening-balance', 'so-nc-pincode', 'so-nc-narration'].forEach(function (id) {
                var el = document.getElementById(id); if (el) el.value = '';
            });
            var obType = document.getElementById('so-nc-opening-balance-type'); if (obType) obType.value = 'Cr';
            var regType = document.getElementById('so-nc-gst-reg-type'); if (regType) regType.value = '';
            geoCascade.reset();
            // Those value resets above fire no 'change' event, so any select
            // already turned into a searchable dropdown would keep showing the
            // OLD label. Force the triggers to re-read their <select>.
            if (window.TCS && window.TCS.refreshSelects) window.TCS.refreshSelects();
            ncModal.show();
            ncModalEl.addEventListener('shown.bs.modal', function focusOnce() {
                ncModalEl.removeEventListener('shown.bs.modal', focusOnce);
                if (nameEl) nameEl.focus();
            });
        }

        if (ncSave) ncSave.addEventListener('click', function () {
            var name = (document.getElementById('so-nc-name').value || '').trim();
            if (ncErr) ncErr.hidden = true;
            if (!name) {
                if (ncErr) { ncErr.textContent = 'Customer name is required.'; ncErr.hidden = false; }
                return;
            }
            function fieldVal(id) { var el = document.getElementById(id); return el ? (el.value || '') : ''; }
            var payload = {
                name:    name,
                mobile:  fieldVal('so-nc-mobile'),
                email:   fieldVal('so-nc-email'),
                gst_number: fieldVal('so-nc-gst'),
                billing_address: fieldVal('so-nc-address'),
                ledger_group: fieldVal('so-nc-ledger-group'),
                opening_balance: fieldVal('so-nc-opening-balance'),
                opening_balance_type: fieldVal('so-nc-opening-balance-type'),
                country: fieldVal('so-nc-country'),
                state: fieldVal('so-nc-state'),
                city: fieldVal('so-nc-city'),
                pincode: fieldVal('so-nc-pincode'),
                gst_registration_type: fieldVal('so-nc-gst-reg-type'),
                notes: fieldVal('so-nc-narration'),
            };
            ncSave.disabled = true;
            // Form-urlencoded, not JSON — the web app only mounts
            // express.urlencoded() (see web/index.js), so a JSON body would
            // arrive as an empty req.body server-side.
            var form = new URLSearchParams();
            Object.keys(payload).forEach(function (k) { form.append(k, payload[k]); });
            fetch(window.SALES_ORDER_QUICK_CUSTOMER_URL || '/sales-orders/create/quick-customer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: form.toString(),
            })
                .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (res) {
                    ncSave.disabled = false;
                    if (!res.j || !res.j.ok) {
                        var msg = (res.j && res.j.error) || 'Could not create customer.';
                        if (ncErr) { ncErr.textContent = msg; ncErr.hidden = false; }
                        return;
                    }
                    if (ncModal) ncModal.hide();
                    partyBox.addAndSelect({ id: res.j.data.id, name: res.j.data.name });
                })
                .catch(function () {
                    ncSave.disabled = false;
                    if (ncErr) { ncErr.textContent = 'Could not reach the server.'; ncErr.hidden = false; }
                });
        });

        var ledgerBox = LEDGERS.length ? makeCombobox({
            input:  ledgerEl,
            hidden: null,
            menu:   document.getElementById('so-ledger-menu'),
            list:   LEDGERS,
            getLabel: function (l) { return l.name; },
            getSubLabel: function (l) { return window.VoucherExtras.ledgerSubLabel(l); },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockFirstItem);

        VX.init({
            prefix: 'so',
            form: form,
            onLevelChange: function reapplyPriceLevel() {
                tbody.querySelectorAll('.so-row').forEach(function (row) {
                    var search = row.querySelector('.so-item-search');
                    var name = search ? search.value : '';
                    if (!name) return;
                    if (!VX.applyLevelToRow(row, name)) {
                        // Level does not cover this item — back to its own price.
                        var prod = PROD_BY_ID[String(row.querySelector('.so-item').value)];
                        if (prod && prod.rate != null) row.querySelector('.so-rate').value = prod.rate;
                    }
                    recalcRow(row);
                });
                recalcTotals();
            },
        });

        // ── EDIT MODE ──────────────────────────────────────────────
        // Set by the view for /sales-orders/:id/edit. Rebuild the saved lines,
        // fill the header, and skip the guided walk-through (that is for a
        // blank voucher — here it would open a combobox over the user's data).
        var EDIT = window.SALES_ORDER_EDIT || null;
        if (EDIT) {
            var partyInput = document.getElementById('so-party');
            if (partyInput && EDIT.customer_name) partyInput.value = EDIT.customer_name;
            if (ledgerEl && EDIT.ledger_name) ledgerEl.value = EDIT.ledger_name;
            var noEl = document.getElementById('so-no');
            if (noEl && EDIT.order_no) noEl.value = EDIT.order_no;

            var lines = Array.isArray(EDIT.items) ? EDIT.items : [];
            if (!lines.length) { addRow(); }
            lines.forEach(function (it) {
                var row = addRow();
                var prod = PRODUCTS.filter(function (p) { return String(p.id) === String(it.product_id); })[0];
                if (prod) {
                    applyProduct(row, prod);
                } else {
                    var si = row.querySelector('.so-item-search');
                    if (si) si.value = it.description || it.product_name || '';
                }
                row.querySelector('.so-qty').value  = it.quantity != null ? it.quantity : 1;
                row.querySelector('.so-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.so-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                var hsn = row.querySelector('.so-hsn');   if (hsn && it.hsn) hsn.value = it.hsn;
                var unit = row.querySelector('.so-unit'); if (unit && it.unit) unit.value = it.unit;
                var tx = row.querySelector('.so-taxincl'); if (tx) tx.checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
            return;
        }

        // Seed the table with a single empty row, then open Party.
        addRow();
        partyBox.open();
    }
})();
