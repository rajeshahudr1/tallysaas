'use strict';

/* ─────────────────────────────────────────────────────────────
 * delivery-note.js — line-item engine + keyboard-first auto-advance flow
 * for the Create Delivery Note page.
 *
 * Loaded only on /delivery-notes/create (via the layout `pageScript` slot).
 * Own copy of sales-order.js's flow (not shared) — does NOT import from
 * invoice.js/quotation.js/sales-order.js, though the row-clone / delete /
 * recompute-totals / items_json-on-submit pattern mirrors all three.
 *
 * DOM contract (shipped by Task 4, views/delivery-notes/create.ejs):
 *   Form: #delivery-note-form, hidden #items_json
 *   Header: #dn-party, #dn-ledger, #dn-no (+ #dn-no-edit), #dn-date, #dn-dispatch, #dn-order
 *   Table: <tbody id="dn-body">, <template id="dn-row-tpl">, #dn-add-row
 *   Row: .dn-item (hidden input) / .dn-item-search (visible text box) / .dn-qty /
 *        .dn-rate / .dn-unit / .dn-disc / .dn-hsn / .dn-godown / .dn-desc /
 *        .dn-amount / .dn-taxincl / .dn-del
 *   Totals: #dn-subtotal, #dn-taxes, #dn-grand
 *   Submit: #dn-submit
 *   Products: window.DELIVERY_NOTE_PRODUCTS [{id,name,hsn,unit,rate,gst,stock}]
 *
 * Money math mirrors DeliveryNoteController.computeTotals exactly (discount
 * first, then GST; a tax-inclusive line's rate already contains GST) — see
 * lineAmount/formTotals below. window.DeliveryNoteCalc exposes both so they
 * can be unit-tested without a DOM (web/tests/deliveryNoteFlow.test.js).
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

window.DeliveryNoteCalc = { lineAmount, formTotals, buildVoucherNo };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form  = document.getElementById('delivery-note-form');
        var tbody = document.getElementById('dn-body');
        var tpl   = document.getElementById('dn-row-tpl');
        var addBtn = document.getElementById('dn-add-row');
        if (!form || !tbody || !tpl) return;

        var PRODUCTS = Array.isArray(window.DELIVERY_NOTE_PRODUCTS) ? window.DELIVERY_NOTE_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        var PARTIES = Array.isArray(window.DELIVERY_NOTE_PARTIES) ? window.DELIVERY_NOTE_PARTIES : [];
        var LEDGERS = Array.isArray(window.DELIVERY_NOTE_LEDGERS) ? window.DELIVERY_NOTE_LEDGERS : [];
        var ORDERS  = Array.isArray(window.DELIVERY_NOTE_ORDERS)  ? window.DELIVERY_NOTE_ORDERS  : [];
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
                qty:     parseFloat(row.querySelector('.dn-qty').value) || 0,
                rate:    parseFloat(row.querySelector('.dn-rate').value) || 0,
                disc:    parseFloat(row.querySelector('.dn-disc').value) || 0,
                gst:     row.querySelector('.dn-item').dataset.gst ? parseFloat(row.querySelector('.dn-item').dataset.gst) : 0,
                taxIncl: !!row.querySelector('.dn-taxincl').checked,
            };
        }

        function recalcRow(row) {
            var amt = lineAmount(rowToLine(row));
            row.querySelector('.dn-amount').textContent = inr(amt);
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.dn-row').forEach(function (row) { lines.push(rowToLine(row)); });
            var t = formTotals(lines);
            var subEl = document.getElementById('dn-subtotal');
            var taxEl = document.getElementById('dn-taxes');
            var grandEl = document.getElementById('dn-grand');
            if (subEl) subEl.textContent = inr(t.subtotal);
            if (taxEl) taxEl.textContent = inr(t.taxes);
            if (grandEl) grandEl.textContent = inr(t.grand);
        }

        function resetRow(row) {
            var search = row.querySelector('.dn-item-search');
            var hidden = row.querySelector('.dn-item');
            if (search) search.value = '';
            if (hidden) { hidden.value = ''; delete hidden.dataset.gst; }
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.dn-hsn').value  = '';
            row.querySelector('.dn-unit').value = '';
            row.querySelector('.dn-qty').value  = '1';
            row.querySelector('.dn-rate').value = '0';
            row.querySelector('.dn-disc').value = '0';
            row.querySelector('.dn-taxincl').checked = false;
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .dn-item, plus
        // data-gst so rowToLine can read the GST%) + fill HSN/Unit/Rate.
        function applyProduct(row, p) {
            var search = row.querySelector('.dn-item-search');
            var hidden = row.querySelector('.dn-item');
            hidden.value = p ? String(p.id) : '';
            hidden.dataset.gst = p && p.gst != null ? p.gst : 0;
            if (search) search.value = p ? p.name : '';
            row.querySelector('.dn-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.dn-unit').value = p ? (p.unit || '') : '';
            if (p && p.rate != null) row.querySelector('.dn-rate').value = p.rate;
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.dn-qty').disabled = false;
            var qty = row.querySelector('.dn-qty');
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
            var qty = row.querySelector('.dn-qty');
            if (!qty || qty.max === '' || qty.max == null) return;
            var maxV = parseFloat(qty.max);
            if (!isNaN(maxV) && (parseFloat(qty.value) || 0) > maxV) qty.value = maxV;
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.dn-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget/markup as invoice.js's, but
        // wired here so choosing a product also drives the auto-advance flow
        // (jump to Qty on selection).
        function wireProductPicker(row) {
            var search = row.querySelector('.dn-item-search');
            var hidden = row.querySelector('.dn-item');
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
                openField(row.querySelector('.dn-qty'));
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
            row.querySelectorAll('.dn-qty, .dn-rate, .dn-disc, .dn-taxincl').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    if (inp.classList.contains('dn-qty')) clampQty(row);
                    recalcRow(row); recalcTotals();
                });
                inp.addEventListener('change', function () { recalcRow(row); recalcTotals(); });
            });

            // Tally-style auto-advance: Qty → Enter → Rate; Rate → Enter →
            // next row's item picker (or a brand-new row if this was last).
            // Only Enter is intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.dn-qty').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var rate = row.querySelector('.dn-rate');
                    rate.disabled = false; // Qty done → Rate step unlocks
                    openField(rate);
                }
            });
            row.querySelector('.dn-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    newRow.querySelector('.dn-item-search').disabled = false;
                    openField(newRow.querySelector('.dn-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) {
                        next.querySelector('.dn-item-search').disabled = false;
                        openField(next.querySelector('.dn-item-search'));
                    }
                }
            });

            row.querySelector('.dn-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.dn-row').length > 1) {
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
            newRow.querySelector('.dn-item-search').disabled = false;
            openField(newRow.querySelector('.dn-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        form.addEventListener('submit', function () {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            tbody.querySelectorAll('.dn-row').forEach(function (row) {
                var prod = row.querySelector('.dn-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.dn-qty').value) || 0;
                if (!pid && qty <= 0) return;
                items.push({
                    product_id:    pid ? Number(pid) : null,
                    description:   row.querySelector('.dn-desc').value || '',
                    hsn:           row.querySelector('.dn-hsn').value || '',
                    quantity:      qty,
                    unit:          row.querySelector('.dn-unit').value || '',
                    rate:          parseFloat(row.querySelector('.dn-rate').value) || 0,
                    discount_pct:  parseFloat(row.querySelector('.dn-disc').value) || 0,
                    gst_rate:      prod && prod.dataset.gst ? parseFloat(prod.dataset.gst) : 0,
                    godown:        row.querySelector('.dn-godown').value || '',
                    tax_inclusive: !!row.querySelector('.dn-taxincl').checked,
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
        // names on edit even if a fetch hasn't populated the list yet.
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
        // Behaviour: once a value is picked, the field is NOT done — focusing/
        // clicking it again reopens the FULL list (not filtered down to the
        // one already-chosen label) so a different item can be picked; typing
        // still filters as usual. clearBtn (×) wipes the selection.
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

        // ── Note No — Default/Custom popup ──
        // Pencil opens a small panel (registered through the shared
        // registerPopup()/closeAllPopups() gate above): Default leaves the
        // #dn-no field empty ("Auto-generated on save" placeholder — the
        // server's own series fills it in, untouched by this feature) while
        // Custom composes buildVoucherNo({prefix, number, suffix}) into it.
        (function wireNoteNoPopup() {
            var editBtn   = document.getElementById('dn-no-edit');
            var popup     = document.getElementById('dn-no-popup');
            var noInput   = document.getElementById('dn-no');
            var modeDefault = document.getElementById('dn-no-mode-default');
            var modeCustom  = document.getElementById('dn-no-mode-custom');
            var fieldsWrap  = document.getElementById('dn-no-popup-fields');
            var prefixEl = document.getElementById('dn-no-prefix');
            var numberEl = document.getElementById('dn-no-number');
            var suffixEl = document.getElementById('dn-no-suffix');
            var cancelBtn = document.getElementById('dn-no-cancel');
            var saveBtn   = document.getElementById('dn-no-save');
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
                // in #dn-no means Custom was saved before — restore its parts
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

        var dateEl = document.getElementById('dn-date');
        var dispatchEl = document.getElementById('dn-dispatch');
        var ledgerEl = document.getElementById('dn-ledger');

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
        // Dispatch Date and Against Order are both OPTIONAL and never block
        // the flow — Date's own 'change' unlocks Dispatch Date (so the
        // keyboard can move straight through it) and, independent of whether
        // the user fills Dispatch Date or the Order field, the first item row
        // unlocks as soon as Date is set.
        function unlockDispatchAndOrder() {
            if (dispatchEl) dispatchEl.disabled = false;
            if (orderEl) orderEl.disabled = false;
            unlockFirstItem();
        }
        function unlockFirstItem() {
            if (addBtn) addBtn.disabled = false;
            var firstRow = tbody.querySelector('.dn-row');
            if (!firstRow) return;
            var search = firstRow.querySelector('.dn-item-search');
            if (search.disabled) { // only auto-focus the very first time
                search.disabled = false;
                openField(search);
            }
        }

        var partyBox = makeCombobox({
            input:  document.getElementById('dn-party'),
            hidden: document.getElementById('dn-party-id'),
            menu:   document.getElementById('dn-party-menu'),
            clearBtn: document.getElementById('dn-party-clear'),
            list:   PARTIES,
            getLabel: function (p) { return p.name; },
            getValue: function (p) { return p.id; },
            onChoose: unlockLedgerOrDate,
            createLabel: 'Create New Customer',
            onCreate: openNewCustomerModal,
        });

        // ── "Create New Customer" modal ──
        // On save: create via /delivery-notes/create/quick-customer (proxies
        // the real customers API), insert+select the new party in-memory, and
        // continue the normal auto-advance flow — nothing already typed on
        // the voucher is touched.
        var geoCascade = makeGeoCascade({
            countryEl: document.getElementById('dn-nc-country'),
            stateEl:   document.getElementById('dn-nc-state'),
            cityEl:    document.getElementById('dn-nc-city'),
        });
        [document.getElementById('dn-nc-country'), document.getElementById('dn-nc-state'), document.getElementById('dn-nc-city')]
            .forEach(function (el) { if (el) closeOthersOnNativeOpen(el); });

        var ncModalEl = document.getElementById('dn-new-customer-modal');
        var ncModal = (ncModalEl && window.bootstrap && window.bootstrap.Modal)
            ? new window.bootstrap.Modal(ncModalEl) : null;
        var ncErr = document.getElementById('dn-nc-error');
        var ncSave = document.getElementById('dn-nc-save');

        function openNewCustomerModal() {
            if (!ncModal) return;
            if (ncErr) ncErr.hidden = true;
            var nameEl = document.getElementById('dn-nc-name');
            if (nameEl) nameEl.value = document.getElementById('dn-party').value.trim();
            ['dn-nc-mobile', 'dn-nc-email', 'dn-nc-gst', 'dn-nc-address',
             'dn-nc-ledger-group', 'dn-nc-opening-balance', 'dn-nc-pincode', 'dn-nc-narration'].forEach(function (id) {
                var el = document.getElementById(id); if (el) el.value = '';
            });
            var obType = document.getElementById('dn-nc-opening-balance-type'); if (obType) obType.value = 'Cr';
            var regType = document.getElementById('dn-nc-gst-reg-type'); if (regType) regType.value = '';
            geoCascade.reset();
            ncModal.show();
            ncModalEl.addEventListener('shown.bs.modal', function focusOnce() {
                ncModalEl.removeEventListener('shown.bs.modal', focusOnce);
                if (nameEl) nameEl.focus();
            });
        }

        if (ncSave) ncSave.addEventListener('click', function () {
            var name = (document.getElementById('dn-nc-name').value || '').trim();
            if (ncErr) ncErr.hidden = true;
            if (!name) {
                if (ncErr) { ncErr.textContent = 'Customer name is required.'; ncErr.hidden = false; }
                return;
            }
            function fieldVal(id) { var el = document.getElementById(id); return el ? (el.value || '') : ''; }
            var payload = {
                name:    name,
                mobile:  fieldVal('dn-nc-mobile'),
                email:   fieldVal('dn-nc-email'),
                gst_number: fieldVal('dn-nc-gst'),
                billing_address: fieldVal('dn-nc-address'),
                ledger_group: fieldVal('dn-nc-ledger-group'),
                opening_balance: fieldVal('dn-nc-opening-balance'),
                opening_balance_type: fieldVal('dn-nc-opening-balance-type'),
                country: fieldVal('dn-nc-country'),
                state: fieldVal('dn-nc-state'),
                city: fieldVal('dn-nc-city'),
                pincode: fieldVal('dn-nc-pincode'),
                gst_registration_type: fieldVal('dn-nc-gst-reg-type'),
                notes: fieldVal('dn-nc-narration'),
            };
            ncSave.disabled = true;
            // Form-urlencoded, not JSON — the web app only mounts
            // express.urlencoded() (see web/index.js), so a JSON body would
            // arrive as an empty req.body server-side.
            var form = new URLSearchParams();
            Object.keys(payload).forEach(function (k) { form.append(k, payload[k]); });
            fetch(window.DELIVERY_NOTE_QUICK_CUSTOMER_URL || '/delivery-notes/create/quick-customer', {
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
            menu:   document.getElementById('dn-ledger-menu'),
            list:   LEDGERS,
            getLabel: function (l) { return l.name; },
            getSubLabel: function (l) { return l.parent; },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockDispatchAndOrder);

        // ══════════════════════════════════════════════════════════════
        // Against Sales Order — prefill.
        //
        // Picking an order fetches its full detail (GET /delivery-notes/
        // order/:id, which proxies the api's GET /sales-orders/:id) and
        // copies the customer + item rows onto the form. If the user has
        // ALREADY typed something (party chosen, or any row already has an
        // item/qty), we do NOT wipe it silently: confirm() first, and if
        // they decline, only the order reference itself (#dn-order/-id)
        // stays attached — every field the user already touched is left
        // exactly as it was.
        // ══════════════════════════════════════════════════════════════
        var orderEl = document.getElementById('dn-order');

        // formHasUserData() is checked BEFORE the order is applied, so the
        // just-picked order's own id (already written into #dn-order-id by
        // the combobox's choose()) must not count as "user data" — only the
        // customer and item rows matter here.
        function formHasUserData() {
            var partyIdEl = document.getElementById('dn-party-id');
            if (partyIdEl && partyIdEl.value) return true;
            var hasRow = false;
            tbody.querySelectorAll('.dn-row').forEach(function (row) {
                var prod = row.querySelector('.dn-item');
                var qty  = parseFloat(row.querySelector('.dn-qty').value) || 0;
                if ((prod && prod.value) || qty > 0) hasRow = true;
            });
            return hasRow;
        }

        function fillPartyFromOrder(o) {
            if (!o.customer_id) return;
            partyBox.addAndSelect({ id: o.customer_id, name: o.customer || '' });
        }

        function fillItemsFromOrder(o) {
            var items = Array.isArray(o.items) ? o.items : [];
            // Clear existing rows down to a single blank one, then rebuild.
            tbody.querySelectorAll('.dn-row').forEach(function (row) { row.remove(); });
            if (!items.length) { addRow(); return; }
            items.forEach(function (it) {
                var row = addRow();
                var prodMatch = it.product_id != null ? PROD_BY_ID[String(it.product_id)] : null;
                var search = row.querySelector('.dn-item-search');
                var hidden = row.querySelector('.dn-item');
                search.disabled = false;
                hidden.value = it.product_id != null ? String(it.product_id) : '';
                hidden.dataset.gst = it.gst_rate != null ? it.gst_rate : 0;
                search.value = prodMatch ? prodMatch.name : (it.description || '');
                row.querySelector('.dn-hsn').value  = it.hsn || '';
                row.querySelector('.dn-unit').value = it.unit || '';
                row.querySelector('.dn-godown').value = it.godown || '';
                row.querySelector('.dn-desc').value = it.description || '';
                row.querySelector('.dn-qty').value  = it.quantity != null ? it.quantity : 0;
                row.querySelector('.dn-qty').disabled = false;
                row.querySelector('.dn-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.dn-rate').disabled = false;
                row.querySelector('.dn-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                row.querySelector('.dn-taxincl').checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
        }

        function applyOrderPrefill(o) {
            fillPartyFromOrder(o);
            fillItemsFromOrder(o);
        }

        function fetchOrderDetail(id) {
            return fetch('/delivery-notes/order/' + encodeURIComponent(id))
                .then(function (r) { return r.json(); })
                .then(function (j) { return (j && j.ok && j.data) ? j.data : null; })
                .catch(function () { return null; });
        }

        var orderBox = ORDERS.length ? makeCombobox({
            input:  orderEl,
            hidden: document.getElementById('dn-order-id'),
            menu:   document.getElementById('dn-order-menu'),
            clearBtn: document.getElementById('dn-order-clear'),
            list:   ORDERS,
            getLabel: function (o) { return o.order_no; },
            getSubLabel: function (o) { return o.customer; },
            getValue: function (o) { return o.id; },
            onChoose: function (o) {
                // The hidden #dn-order-id already carries the picked order's id
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
                        'This will replace the customer and item rows you already entered ' +
                        'with the details from the selected sales order. Continue?');
                    if (!ok) return; // decline → only the order reference (#dn-order-id) stays attached
                }
                proceed();
            },
        }) : null;

        // Seed the table with a single (locked) empty row, then open Party.
        addRow();
        partyBox.open();
    }
})();
