'use strict';

/* ─────────────────────────────────────────────────────────────
 * return-note.js — line-item engine + keyboard-first auto-advance flow
 * for the Create Credit Note / Create Debit Note page.
 *
 * Loaded only on /credit-notes/create and /debit-notes/create (via the
 * layout `pageScript` slot). ONE script serves BOTH kinds — the create form
 * is a single view with a single set of `cn-` DOM hooks; which kind is
 * active is read off window.RETURN_NOTE_KIND ('credit'|'debit'), set by the
 * create.ejs inline script. Own copy of delivery-note.js's flow engine (not
 * shared) — does NOT import from it, though the row-clone / delete /
 * recompute-totals / items_json-on-submit pattern mirrors it and every other
 * voucher module.
 *
 * DOM contract (shipped by Task 2, views/return-notes/create.ejs):
 *   Form: #return-note-form, hidden #items_json
 *   Header: #cn-party, #cn-ledger, #cn-no (+ #cn-no-edit), #cn-date, #cn-against
 *   Table: <tbody id="cn-body">, <template id="cn-row-tpl">, #cn-add-row
 *   Row: .cn-item (hidden input) / .cn-item-search (visible text box) / .cn-qty /
 *        .cn-rate / .cn-unit / .cn-disc / .cn-hsn / .cn-godown / .cn-desc /
 *        .cn-amount / .cn-taxincl / .cn-del
 *   Totals: #cn-subtotal, #cn-taxes, #cn-grand
 *   Submit: #cn-submit
 *   Products: window.RETURN_NOTE_PRODUCTS [{id,name,hsn,unit,rate,gst,stock}]
 *
 * Money math mirrors ReturnNoteController.computeTotals exactly (discount
 * first, then GST; a tax-inclusive line's rate already contains GST) — see
 * lineAmount/formTotals below. window.ReturnNoteCalc exposes both so they
 * can be unit-tested without a DOM (web/tests/returnNoteFlow.test.js).
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
 * SUBTOTAL is the TAXABLE value — after discount, with GST taken back out of
 * a tax-inclusive rate — so the panel always reads as arithmetic you can
 * follow: Sub Total + Taxes = Grand Total. It used to be the GROSS, which
 * made a discounted bill overshoot and made a tax-inclusive line count its
 * GST twice on screen. The STORED figures are computed server-side and are
 * unchanged; this is presentation only.
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

window.ReturnNoteCalc = { lineAmount, formTotals, buildVoucherNo };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form  = document.getElementById('return-note-form');
        var tbody = document.getElementById('cn-body');
        var tpl   = document.getElementById('cn-row-tpl');
        var addBtn = document.getElementById('cn-add-row');
        if (!form || !tbody || !tpl) return;

        // Price level, party balance, the Buyer/Consignee/Dispatch/Order block
        // and the richer item option are identical on all six voucher forms —
        // they live in voucher-extras.js, driven by this form's id prefix.
        var VX = window.VoucherExtras;

        var KIND = window.RETURN_NOTE_KIND === 'debit' ? 'debit' : 'credit';

        var PRODUCTS = Array.isArray(window.RETURN_NOTE_PRODUCTS) ? window.RETURN_NOTE_PRODUCTS : [];
        var PROD_BY_ID = {};
        PRODUCTS.forEach(function (p) { PROD_BY_ID[String(p.id)] = p; });

        var PARTIES = Array.isArray(window.RETURN_NOTE_PARTIES) ? window.RETURN_NOTE_PARTIES : [];
        var LEDGERS = Array.isArray(window.RETURN_NOTE_LEDGERS) ? window.RETURN_NOTE_LEDGERS : [];
        var BILLS   = Array.isArray(window.RETURN_NOTE_BILLS)   ? window.RETURN_NOTE_BILLS   : [];

        // ── One popup/dropdown open at a time ──
        // Every custom menu (product picker, party/ledger/bill combobox) and
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
                qty:     parseFloat(row.querySelector('.cn-qty').value) || 0,
                rate:    parseFloat(row.querySelector('.cn-rate').value) || 0,
                disc:    parseFloat(row.querySelector('.cn-disc').value) || 0,
                gst:     row.querySelector('.cn-item').dataset.gst ? parseFloat(row.querySelector('.cn-item').dataset.gst) : 0,
                taxIncl: !!row.querySelector('.cn-taxincl').checked,
            };
        }

        function recalcRow(row) {
            var amt = lineAmount(rowToLine(row));
            row.querySelector('.cn-amount').textContent = inr(amt);
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.cn-row').forEach(function (row) { lines.push(rowToLine(row)); });
            var t = formTotals(lines);
            var subEl = document.getElementById('cn-subtotal');
            var taxEl = document.getElementById('cn-taxes');
            var grandEl = document.getElementById('cn-grand');
            if (subEl) subEl.textContent = inr(t.subtotal);
            if (taxEl) taxEl.textContent = inr(t.taxes);
            if (grandEl) grandEl.textContent = inr(t.grand);
        }

        function resetRow(row) {
            var search = row.querySelector('.cn-item-search');
            var hidden = row.querySelector('.cn-item');
            if (search) search.value = '';
            if (hidden) { hidden.value = ''; delete hidden.dataset.gst; }
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            row.querySelector('.cn-hsn').value  = '';
            row.querySelector('.cn-unit').value = '';
            row.querySelector('.cn-qty').value  = '1';
            row.querySelector('.cn-rate').value = '0';
            row.querySelector('.cn-disc').value = '0';
            row.querySelector('.cn-taxincl').checked = false;
            recalcRow(row);
        }

        // Apply a chosen product to the row: pin its id (hidden .cn-item, plus
        // data-gst so rowToLine can read the GST%) + fill HSN/Unit/Rate.
        function applyProduct(row, p) {
            var search = row.querySelector('.cn-item-search');
            var hidden = row.querySelector('.cn-item');
            hidden.value = p ? String(p.id) : '';
            hidden.dataset.gst = p && p.gst != null ? p.gst : 0;
            if (search) search.value = p ? p.name : '';
            row.querySelector('.cn-hsn').value  = p ? (p.hsn || '')  : '';
            row.querySelector('.cn-unit').value = p ? (p.unit || '') : '';
            // Rate: the chosen PRICE LEVEL wins where it covers this item —
            // that is the whole point of picking a level — otherwise the item's
            // own standard price.
            if (p && !VX.applyLevelToRow(row, p.name) && p.rate != null) {
                row.querySelector('.cn-rate').value = p.rate;
            }
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.cn-qty').disabled = false;
            recalcRow(row); recalcTotals();
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.cn-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget/markup as invoice.js's, but
        // wired here so choosing a product also drives the auto-advance flow
        // (jump to Qty on selection).
        function wireProductPicker(row) {
            var search = row.querySelector('.cn-item-search');
            var hidden = row.querySelector('.cn-item');
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
                openField(row.querySelector('.cn-qty'));
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
            row.querySelectorAll('.cn-qty, .cn-rate, .cn-disc, .cn-taxincl').forEach(function (inp) {
                inp.addEventListener('input', function () {
                    // A price level can band its rate by quantity, so crossing a
                    // band boundary has to re-rate the line.
                    if (inp.classList.contains('cn-qty')) VX.applySlabRate(row);
                    recalcRow(row); recalcTotals();
                });
                inp.addEventListener('change', function () { recalcRow(row); recalcTotals(); });
            });

            // Tally-style auto-advance: Qty → Enter → Rate; Rate → Enter →
            // next row's item picker (or a brand-new row if this was last).
            // Only Enter is intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.cn-qty').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var rate = row.querySelector('.cn-rate');
                    rate.disabled = false; // Qty done → Rate step unlocks
                    openField(rate);
                }
            });
            row.querySelector('.cn-rate').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    newRow.querySelector('.cn-item-search').disabled = false;
                    openField(newRow.querySelector('.cn-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) {
                        next.querySelector('.cn-item-search').disabled = false;
                        openField(next.querySelector('.cn-item-search'));
                    }
                }
            });

            row.querySelector('.cn-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.cn-row').length > 1) {
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
            newRow.querySelector('.cn-item-search').disabled = false;
            openField(newRow.querySelector('.cn-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        form.addEventListener('submit', function () {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            tbody.querySelectorAll('.cn-row').forEach(function (row) {
                var prod = row.querySelector('.cn-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.cn-qty').value) || 0;
                if (!pid && qty <= 0) return;
                items.push({
                    product_id:    pid ? Number(pid) : null,
                    description:   row.querySelector('.cn-desc').value || '',
                    hsn:           row.querySelector('.cn-hsn').value || '',
                    quantity:      qty,
                    unit:          row.querySelector('.cn-unit').value || '',
                    rate:          parseFloat(row.querySelector('.cn-rate').value) || 0,
                    discount_pct:  parseFloat(row.querySelector('.cn-disc').value) || 0,
                    gst_rate:      prod && prod.dataset.gst ? parseFloat(prod.dataset.gst) : 0,
                    godown:        row.querySelector('.cn-godown').value || '',
                    tax_inclusive: !!row.querySelector('.cn-taxincl').checked,
                });
            });
            hidden.value = JSON.stringify(items);
        });

        // ══════════════════════════════════════════════════════════════
        // Auto-advance flow — Tally जैसा keyboard-first क्रम: Party → Ledger →
        // Date → Against Bill (वैकल्पिक, कभी न रोके) → पहली row का item → Qty →
        // Enter → Rate → Enter → नई row।
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
        //         onChoose, clearBtn, createLabel, onCreate }
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
        (function wireNoteNoPopup() {
            var editBtn   = document.getElementById('cn-no-edit');
            var popup     = document.getElementById('cn-no-popup');
            var noInput   = document.getElementById('cn-no');
            var modeDefault = document.getElementById('cn-no-mode-default');
            var modeCustom  = document.getElementById('cn-no-mode-custom');
            var fieldsWrap  = document.getElementById('cn-no-popup-fields');
            var prefixEl = document.getElementById('cn-no-prefix');
            var numberEl = document.getElementById('cn-no-number');
            var suffixEl = document.getElementById('cn-no-suffix');
            var cancelBtn = document.getElementById('cn-no-cancel');
            var saveBtn   = document.getElementById('cn-no-save');
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

        var dateEl = document.getElementById('cn-date');
        var ledgerEl = document.getElementById('cn-ledger');

        // Ledger Type step unlocks after Party is picked — unless the tenant
        // has zero synced sales/purchase ledgers, in which case it stays
        // honestly disabled forever and Date unlocks right away instead.
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
        // Against Bill is OPTIONAL and never blocks the flow — Date's own
        // 'change' unlocks it, and the first item row unlocks regardless of
        // whether the user fills it in.
        function unlockAgainstAndItems() {
            if (billEl) billEl.disabled = false;
            unlockFirstItem();
        }
        function unlockFirstItem() {
            if (addBtn) addBtn.disabled = false;
            var firstRow = tbody.querySelector('.cn-row');
            if (!firstRow) return;
            var search = firstRow.querySelector('.cn-item-search');
            if (search.disabled) { // only auto-focus the very first time
                search.disabled = false;
                openField(search);
            }
        }

        // "Create New Customer" — Credit Note only (its party IS a customer);
        // Debit Note's party is a supplier and gets no create-new modal, same
        // decision Purchase Order made for its supplier field.
        var partyBox = makeCombobox({
            input:  document.getElementById('cn-party'),
            hidden: document.getElementById('cn-party-id'),
            menu:   document.getElementById('cn-party-menu'),
            clearBtn: document.getElementById('cn-party-clear'),
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
            createLabel: KIND === 'credit' ? 'Create New Customer' : undefined,
            onCreate: KIND === 'credit' ? openNewCustomerModal : undefined,
        });

        // ── "Create New Customer" modal (Credit Note only) ──
        var ncModalEl = document.getElementById('cn-new-customer-modal');
        var ncModal = (ncModalEl && window.bootstrap && window.bootstrap.Modal)
            ? new window.bootstrap.Modal(ncModalEl) : null;
        var ncErr = document.getElementById('cn-nc-error');
        var ncSave = document.getElementById('cn-nc-save');

        function openNewCustomerModal() {
            if (!ncModal) return;
            if (ncErr) ncErr.hidden = true;
            var nameEl = document.getElementById('cn-nc-name');
            if (nameEl) nameEl.value = document.getElementById('cn-party').value.trim();
            ncModal.show();
            ncModalEl.addEventListener('shown.bs.modal', function focusOnce() {
                ncModalEl.removeEventListener('shown.bs.modal', focusOnce);
                if (nameEl) nameEl.focus();
            });
        }

        if (ncSave) ncSave.addEventListener('click', function () {
            var name = (document.getElementById('cn-nc-name').value || '').trim();
            if (ncErr) ncErr.hidden = true;
            if (!name) {
                if (ncErr) { ncErr.textContent = 'Customer name is required.'; ncErr.hidden = false; }
                return;
            }
            ncSave.disabled = true;
            var form2 = new URLSearchParams();
            form2.append('name', name);
            fetch(window.RETURN_NOTE_QUICK_CUSTOMER_URL || '/credit-notes/create/quick-customer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: form2.toString(),
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
            menu:   document.getElementById('cn-ledger-menu'),
            list:   LEDGERS,
            getLabel: function (l) { return l.name; },
            getSubLabel: function (l) { return window.VoucherExtras.ledgerSubLabel(l); },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockAgainstAndItems);

        VX.init({
            prefix: 'cn',
            form: form,
            onLevelChange: function reapplyPriceLevel() {
                tbody.querySelectorAll('.cn-row').forEach(function (row) {
                    var search = row.querySelector('.cn-item-search');
                    var name = search ? search.value : '';
                    if (!name) return;
                    if (!VX.applyLevelToRow(row, name)) {
                        // Level does not cover this item — back to its own price.
                        var prod = PROD_BY_ID[String(row.querySelector('.cn-item').value)];
                        if (prod && prod.rate != null) row.querySelector('.cn-rate').value = prod.rate;
                    }
                    recalcRow(row);
                });
                recalcTotals();
            },
        });

        // ══════════════════════════════════════════════════════════════
        // Against Bill — prefill.
        //
        // Picking a bill fetches its full detail (GET /credit-notes/bill/:id
        // or /debit-notes/bill/:id — same forwarding trick as delivery-note's
        // "Against Sales Order") and copies the party + item rows onto the
        // form (full return is the common case; the user can reduce
        // quantities). If the user has ALREADY typed something (party
        // chosen, or any row already has an item/qty), we do NOT wipe it
        // silently: confirm() first, and if they decline, only the bill
        // reference itself (#cn-against/-id) stays attached.
        // ══════════════════════════════════════════════════════════════
        var billEl = document.getElementById('cn-against');

        function formHasUserData() {
            var partyIdEl = document.getElementById('cn-party-id');
            if (partyIdEl && partyIdEl.value) return true;
            var hasRow = false;
            tbody.querySelectorAll('.cn-row').forEach(function (row) {
                var prod = row.querySelector('.cn-item');
                var qty  = parseFloat(row.querySelector('.cn-qty').value) || 0;
                if ((prod && prod.value) || qty > 0) hasRow = true;
            });
            return hasRow;
        }

        function fillPartyFromBill(o) {
            var pid = KIND === 'credit' ? o.customer_id : o.supplier_id;
            var pname = KIND === 'credit' ? o.customer : o.supplier;
            if (!pid) return;
            partyBox.addAndSelect({ id: pid, name: pname || '' });
        }

        function fillItemsFromBill(o) {
            var items = Array.isArray(o.items) ? o.items : [];
            tbody.querySelectorAll('.cn-row').forEach(function (row) { row.remove(); });
            if (!items.length) { addRow(); return; }
            items.forEach(function (it) {
                var row = addRow();
                var prodMatch = it.product_id != null ? PROD_BY_ID[String(it.product_id)] : null;
                var search = row.querySelector('.cn-item-search');
                var hidden = row.querySelector('.cn-item');
                search.disabled = false;
                hidden.value = it.product_id != null ? String(it.product_id) : '';
                hidden.dataset.gst = it.gst_rate != null ? it.gst_rate : 0;
                search.value = prodMatch ? prodMatch.name : (it.description || '');
                row.querySelector('.cn-hsn').value  = it.hsn || '';
                row.querySelector('.cn-unit').value = it.unit || '';
                row.querySelector('.cn-godown').value = it.godown || '';
                row.querySelector('.cn-desc').value = it.description || '';
                row.querySelector('.cn-qty').value  = it.quantity != null ? it.quantity : 0;
                row.querySelector('.cn-qty').disabled = false;
                row.querySelector('.cn-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.cn-rate').disabled = false;
                row.querySelector('.cn-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                row.querySelector('.cn-taxincl').checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
        }

        function applyBillPrefill(o) {
            fillPartyFromBill(o);
            fillItemsFromBill(o);
        }

        function fetchBillDetail(id) {
            var base = KIND === 'credit' ? '/credit-notes' : '/debit-notes';
            return fetch(base + '/bill/' + encodeURIComponent(id))
                .then(function (r) { return r.json(); })
                .then(function (j) { return (j && j.ok && j.data) ? j.data : null; })
                .catch(function () { return null; });
        }

        var billBox = BILLS.length ? makeCombobox({
            input:  billEl,
            hidden: document.getElementById('cn-against-id'),
            menu:   document.getElementById('cn-against-menu'),
            clearBtn: document.getElementById('cn-against-clear'),
            list:   BILLS,
            getLabel: function (o) { return o.invoice_no; },
            getSubLabel: function (o) { return o.party; },
            getValue: function (o) { return o.id; },
            onChoose: function (o) {
                var already = formHasUserData();
                var proceed = function () {
                    fetchBillDetail(o.id).then(function (detail) {
                        if (detail) applyBillPrefill(detail);
                    });
                };
                if (already) {
                    var ok = window.confirm(
                        'This will replace the party and item rows you already entered ' +
                        'with the details from the selected bill. Continue?');
                    if (!ok) return; // decline → only the bill reference (#cn-against-id) stays attached
                }
                proceed();
            },
        }) : null;

        // Seed the table with a single (locked) empty row, then open Party.
        // ── EDIT MODE ── set by the view for /credit-notes/:id/edit and
        // /debit-notes/:id/edit (one script serves both kinds).
        var EDIT = window.RETURN_NOTE_EDIT || null;
        if (EDIT) {
            var partyInput = document.getElementById('cn-party');
            if (partyInput && EDIT.party_name) partyInput.value = EDIT.party_name;
            if (ledgerEl && EDIT.ledger_name) ledgerEl.value = EDIT.ledger_name;
            var noEl = document.getElementById('cn-no');
            if (noEl && EDIT.note_no) noEl.value = EDIT.note_no;

            var lines = Array.isArray(EDIT.items) ? EDIT.items : [];
            if (!lines.length) { addRow(); }
            lines.forEach(function (it) {
                var row = addRow();
                var prod = PRODUCTS.filter(function (p) { return String(p.id) === String(it.product_id); })[0];
                if (prod) {
                    applyProduct(row, prod);
                } else {
                    var si = row.querySelector('.cn-item-search');
                    if (si) si.value = it.description || it.product_name || '';
                }
                row.querySelector('.cn-qty').value  = it.quantity != null ? it.quantity : 1;
                row.querySelector('.cn-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.cn-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                var hsn = row.querySelector('.cn-hsn');   if (hsn && it.hsn) hsn.value = it.hsn;
                var unit = row.querySelector('.cn-unit'); if (unit && it.unit) unit.value = it.unit;
                var tx = row.querySelector('.cn-taxincl'); if (tx) tx.checked = !!it.tax_inclusive;
                recalcRow(row);
            });
            recalcTotals();
            return;
        }

        addRow();
        partyBox.open();
    }
})();
