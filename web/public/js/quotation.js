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

        var PARTIES = Array.isArray(window.QUOTATION_PARTIES) ? window.QUOTATION_PARTIES : [];
        var LEDGERS = Array.isArray(window.QUOTATION_LEDGERS) ? window.QUOTATION_LEDGERS : [];

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
        function registerPopup(els, closeFn) {
            closeAllPopups();
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
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.q-qty').disabled = false;
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
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var rate = row.querySelector('.q-rate');
                    rate.disabled = false; // Qty done → Rate step unlocks
                    openField(rate);
                }
            });
            row.querySelector('.q-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    newRow.querySelector('.q-item-search').disabled = false;
                    openField(newRow.querySelector('.q-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) {
                        next.querySelector('.q-item-search').disabled = false;
                        openField(next.querySelector('.q-item-search'));
                    }
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
            newRow.querySelector('.q-item-search').disabled = false;
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

        var dateEl = document.getElementById('q-date');
        var ledgerEl = document.getElementById('q-ledger');

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
            var firstRow = tbody.querySelector('.q-row');
            if (!firstRow) return;
            var search = firstRow.querySelector('.q-item-search');
            search.disabled = false;
            openField(search);
        }

        var partyBox = makeCombobox({
            input:  document.getElementById('q-party'),
            hidden: document.getElementById('q-party-id'),
            menu:   document.getElementById('q-party-menu'),
            clearBtn: document.getElementById('q-party-clear'),
            list:   PARTIES,
            getLabel: function (p) { return p.name; },
            // Outstanding balance would go here (getSubLabel) if it were part
            // of the party options this page already loads — it is not
            // (fetchCustomerInvoiceOptions only returns id/name/location; the
            // customers API's opening_balance ≠ a real closing balance and
            // computing one needs a per-customer ledger query), so the
            // right-hand figure is left out rather than shipping a fake ₹0.00.
            getValue: function (p) { return p.id; },
            onChoose: unlockLedgerOrDate,
            createLabel: 'Create New Customer',
            onCreate: openNewCustomerModal,
        });

        // ── "Create New Customer" modal (change 4) ──
        // On save: create via /quotations/create/quick-customer (proxies the
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
            countryEl: document.getElementById('q-nc-country'),
            stateEl:   document.getElementById('q-nc-state'),
            cityEl:    document.getElementById('q-nc-city'),
        });
        [document.getElementById('q-nc-country'), document.getElementById('q-nc-state'), document.getElementById('q-nc-city')]
            .forEach(function (el) { if (el) closeOthersOnNativeOpen(el); });

        var ncModalEl = document.getElementById('q-new-customer-modal');
        var ncModal = (ncModalEl && window.bootstrap && window.bootstrap.Modal)
            ? new window.bootstrap.Modal(ncModalEl) : null;
        var ncErr = document.getElementById('q-nc-error');
        var ncSave = document.getElementById('q-nc-save');

        function openNewCustomerModal() {
            if (!ncModal) return;
            if (ncErr) ncErr.hidden = true;
            var nameEl = document.getElementById('q-nc-name');
            if (nameEl) nameEl.value = document.getElementById('q-party').value.trim();
            ['q-nc-mobile', 'q-nc-email', 'q-nc-gst', 'q-nc-address',
             'q-nc-ledger-group', 'q-nc-opening-balance', 'q-nc-pincode', 'q-nc-narration'].forEach(function (id) {
                var el = document.getElementById(id); if (el) el.value = '';
            });
            var obType = document.getElementById('q-nc-opening-balance-type'); if (obType) obType.value = 'Cr';
            var regType = document.getElementById('q-nc-gst-reg-type'); if (regType) regType.value = '';
            geoCascade.reset();
            ncModal.show();
            ncModalEl.addEventListener('shown.bs.modal', function focusOnce() {
                ncModalEl.removeEventListener('shown.bs.modal', focusOnce);
                if (nameEl) nameEl.focus();
            });
        }

        if (ncSave) ncSave.addEventListener('click', function () {
            var name = (document.getElementById('q-nc-name').value || '').trim();
            if (ncErr) ncErr.hidden = true;
            if (!name) {
                if (ncErr) { ncErr.textContent = 'Customer name is required.'; ncErr.hidden = false; }
                return;
            }
            function fieldVal(id) { var el = document.getElementById(id); return el ? (el.value || '') : ''; }
            var payload = {
                name:    name,
                mobile:  fieldVal('q-nc-mobile'),
                email:   fieldVal('q-nc-email'),
                gst_number: fieldVal('q-nc-gst'),
                billing_address: fieldVal('q-nc-address'),
                ledger_group: fieldVal('q-nc-ledger-group'),
                opening_balance: fieldVal('q-nc-opening-balance'),
                opening_balance_type: fieldVal('q-nc-opening-balance-type'),
                country: fieldVal('q-nc-country'),
                state: fieldVal('q-nc-state'),
                city: fieldVal('q-nc-city'),
                pincode: fieldVal('q-nc-pincode'),
                gst_registration_type: fieldVal('q-nc-gst-reg-type'),
                notes: fieldVal('q-nc-narration'),
            };
            ncSave.disabled = true;
            // Form-urlencoded, not JSON — the web app only mounts
            // express.urlencoded() (see web/index.js), so a JSON body would
            // arrive as an empty req.body server-side.
            var form = new URLSearchParams();
            Object.keys(payload).forEach(function (k) { form.append(k, payload[k]); });
            fetch(window.QUOTATION_QUICK_CUSTOMER_URL || '/quotations/create/quick-customer', {
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
            menu:   document.getElementById('q-ledger-menu'),
            list:   LEDGERS,
            getLabel: function (l) { return l.name; },
            getSubLabel: function (l) { return l.parent; },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockFirstItem);

        // Seed the table with a single (locked) empty row, then open Party.
        addRow();
        partyBox.open();
    }
})();
