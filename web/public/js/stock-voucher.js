'use strict';

/* ─────────────────────────────────────────────────────────────
 * stock-voucher.js — line-item engine + keyboard-first auto-advance flow
 * shared by the Create Stock Journal and Create Physical Stock pages.
 *
 * Own copy of delivery-note.js's flow (not shared) — these are GOODS
 * vouchers with NO ledger / GST / rate-based money totals, only quantity.
 * One file drives BOTH forms; which one is active is decided purely from
 * the DOM (#stock-journal-form vs #physical-stock-form both present is
 * never the case — only one form exists per page).
 *
 * DOM contract (views/stock-journals/create.ejs, views/physical-stock/create.ejs):
 *   Form: #stock-journal-form | #physical-stock-form, hidden #items_json
 *   Header: #sv-date, #sv-no (+ #sv-no-edit)
 *   Table: <tbody id="sv-body">, <template id="sv-row-tpl">, #sv-add-row
 *   Row: .sv-item (hidden product id) / .sv-item-search (visible text box) /
 *        .sv-qty / .sv-godown (Stock Journal, per row) / .sv-dir (Stock
 *        Journal only) / .sv-current-qty (Physical Stock, read-only) / .sv-del
 *   Header-level: .sv-godown (Physical Stock — ONE godown applies to every
 *        counted line, unlike Stock Journal where it's per-row)
 *   Submit: #sv-submit
 *   Products: window.STOCK_JOURNAL_PRODUCTS | window.PHYSICAL_STOCK_PRODUCTS
 *             [{id,name,unit,stock}]
 *
 * window.StockVoucherCalc exposes the pure math so it can be unit-tested
 * without a DOM (web/tests/stockVoucherFlow.test.js).
 * ─────────────────────────────────────────────────────────── */

// किसी भी rows array में `qty` जोड़ता है — खाली/non-numeric qty को अनदेखा
// करता है (0 गिनता है, स्ट्रिंग को नहीं)।
function totalQty(rows) {
    let sum = 0;
    for (const r of (rows || [])) {
        const q = Number(r && r.qty);
        if (!isNaN(q)) sum += q;
    }
    return sum;
}

// Custom voucher-no popup (LiveKeeping's Default/Custom panel) — joins
// Prefix/Voucher no/Suffix exactly as typed, trimmed, skipping empty parts.
// Identical to delivery-note.js's own copy (kept separate on purpose).
function buildVoucherNo(parts) {
    var p = parts || {};
    return [p.prefix, p.number, p.suffix]
        .map(function (v) { return (v == null ? '' : String(v)).trim(); })
        .filter(function (v) { return v !== ''; })
        .join('');
}

window.StockVoucherCalc = { totalQty, buildVoucherNo };

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var sjForm = document.getElementById('stock-journal-form');
        var psForm = document.getElementById('physical-stock-form');
        if (sjForm) return initForm(sjForm, 'stock-journal');
        if (psForm) return initForm(psForm, 'physical-stock');
    }

    function initForm(form, kind) {
        var tbody = document.getElementById('sv-body');
        var tpl   = document.getElementById('sv-row-tpl');
        var addBtn = document.getElementById('sv-add-row');
        if (!form || !tbody || !tpl) return;

        var isJournal = kind === 'stock-journal';
        var PRODUCTS = Array.isArray(isJournal ? window.STOCK_JOURNAL_PRODUCTS : window.PHYSICAL_STOCK_PRODUCTS)
            ? (isJournal ? window.STOCK_JOURNAL_PRODUCTS : window.PHYSICAL_STOCK_PRODUCTS) : [];

        // ── One popup/dropdown open at a time ──
        // Same gate as delivery-note.js: opening any custom menu closes every
        // other one first. Re-registering the SAME popup must not close it —
        // a single click fires both mousedown and focus, each of which
        // re-opens (and so re-registers) the combobox; closing "everything
        // else" blindly would run this popup's own close() right after it
        // opened, so the field looked dead. Close only the OTHERS.
        var openPopups = [];
        function closeAllPopups() {
            var list = openPopups;
            openPopups = [];
            list.forEach(function (p) { p.close(); });
        }
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

        function openField(el) {
            if (!el || el.disabled) return;
            el.focus();
            if (el.select) el.select();
        }

        function rowToLine(row) {
            return {
                qty: parseFloat(row.querySelector('.sv-qty').value) || 0,
                dir: isJournal ? (row.querySelector('.sv-dir') ? row.querySelector('.sv-dir').value : 'source') : null,
            };
        }

        function recalcTotals() {
            var lines = [];
            tbody.querySelectorAll('.sv-row').forEach(function (row) { lines.push(rowToLine(row)); });

            if (isJournal) {
                var sourceLines = lines.filter(function (l) { return l.dir !== 'destination'; });
                var destLines   = lines.filter(function (l) { return l.dir === 'destination'; });
                var sourceQty = totalQty(sourceLines);
                var destQty   = totalQty(destLines);
                var srcEl = document.getElementById('sv-source-qty');
                var dstEl = document.getElementById('sv-dest-qty');
                if (srcEl) srcEl.textContent = String(sourceQty);
                if (dstEl) dstEl.textContent = String(destQty);

                var balanced = (sourceQty === 0) ? (destQty === 0) : (destQty === 0 || Math.abs(sourceQty - destQty) < 1e-9);
                var warn = document.getElementById('sv-balance-warning');
                if (warn) warn.hidden = balanced;
            } else {
                var total = totalQty(lines);
                var totEl = document.getElementById('sv-counted-qty');
                if (totEl) totEl.textContent = String(total);
            }
        }

        function isLastRow(row) {
            var rows = tbody.querySelectorAll('.sv-row');
            return rows.length && rows[rows.length - 1] === row;
        }

        // Searchable product picker — same widget as delivery-note.js's, minus
        // rate/hsn/gst; for Physical Stock, choosing a product also fills the
        // read-only Current Qty field.
        function wireProductPicker(row) {
            var search = row.querySelector('.sv-item-search');
            var hidden = row.querySelector('.sv-item');
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
                openField(row.querySelector('.sv-qty'));
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
                if (e.key === 'Escape') { closePicker(); return; }
                if (menu.hidden) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
                else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
            });
            search.addEventListener('blur', function () { setTimeout(closePicker, 150); });
        }

        function applyProduct(row, p) {
            var search = row.querySelector('.sv-item-search');
            var hidden = row.querySelector('.sv-item');
            hidden.value = p ? String(p.id) : '';
            if (search) search.value = p ? p.name : '';
            if (!isJournal) {
                var curEl = row.querySelector('.sv-current-qty');
                if (curEl) curEl.value = p && p.stock != null ? p.stock : 0;
            }
        }

        function resetRow(row) {
            var search = row.querySelector('.sv-item-search');
            var hidden = row.querySelector('.sv-item');
            if (search) search.value = '';
            if (hidden) hidden.value = '';
            var menu = row.querySelector('.li-prod-menu');
            if (menu) { menu.hidden = true; menu.innerHTML = ''; }
            var cur = row.querySelector('.sv-current-qty');
            if (cur) cur.value = '';
            row.querySelector('.sv-qty').value = isJournal ? '1' : '0';
            var godown = row.querySelector('.sv-godown');
            if (godown) godown.value = '';
            var dir = row.querySelector('.sv-dir');
            if (dir) dir.value = 'source';
            recalcTotals();
        }

        function wireRow(row) {
            wireProductPicker(row);
            row.querySelector('.sv-qty').addEventListener('input', recalcTotals);
            row.querySelector('.sv-qty').addEventListener('change', recalcTotals);
            var dir = row.querySelector('.sv-dir');
            if (dir) dir.addEventListener('change', recalcTotals);

            // Tally-style auto-advance: Qty → Enter → next row's item picker
            // (or a brand-new row if this was last). Only Enter is
            // intercepted — Tab/Shift+Tab keep native behaviour.
            row.querySelector('.sv-qty').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isLastRow(row)) {
                    var newRow = addRow();
                    openField(newRow.querySelector('.sv-item-search'));
                } else {
                    var next = row.nextElementSibling;
                    if (next) openField(next.querySelector('.sv-item-search'));
                }
            });

            row.querySelector('.sv-del').addEventListener('click', function () {
                if (tbody.querySelectorAll('.sv-row').length > 1) {
                    row.remove();
                } else {
                    resetRow(row);
                }
                recalcTotals();
            });
        }

        function addRow() {
            var node = tpl.content.firstElementChild.cloneNode(true);
            tbody.appendChild(node);
            wireRow(node);
            recalcTotals();
            return node;
        }

        if (addBtn) addBtn.addEventListener('click', function () {
            var newRow = addRow();
            openField(newRow.querySelector('.sv-item-search'));
        });

        // ── Serialise line items into #items_json on submit ──
        // Empty rows (no item AND no qty) are dropped — server never sees them.
        // For Stock Journal, block submit client-side if unbalanced (the api
        // 422s the same rule server-side — this is just a faster echo).
        form.addEventListener('submit', function (e) {
            var hidden = document.getElementById('items_json');
            if (!hidden) return;
            var items = [];
            var lines = []; // for the balance check below
            tbody.querySelectorAll('.sv-row').forEach(function (row) {
                var prod = row.querySelector('.sv-item');
                var pid  = prod ? prod.value : '';
                var qty  = parseFloat(row.querySelector('.sv-qty').value) || 0;
                if (!pid && qty <= 0) return;
                if (isJournal) {
                    var dir = row.querySelector('.sv-dir').value;
                    items.push({
                        product_id: pid ? Number(pid) : null,
                        direction:  dir,
                        godown:     row.querySelector('.sv-godown').value || '',
                        quantity:   qty,
                    });
                    lines.push({ qty: qty, dir: dir });
                } else {
                    var godownInput = document.getElementById('sv-godown');
                    items.push({
                        product_id:  pid ? Number(pid) : null,
                        counted_qty: qty,
                        godown:      godownInput ? (godownInput.value || '') : '',
                    });
                }
            });

            if (isJournal) {
                var sourceQty = totalQty(lines.filter(function (l) { return l.dir !== 'destination'; }));
                var destQty   = totalQty(lines.filter(function (l) { return l.dir === 'destination'; }));
                var balanced = (sourceQty === 0) ? (destQty === 0) : (destQty === 0 || Math.abs(sourceQty - destQty) < 1e-9);
                var warn = document.getElementById('sv-balance-warning');
                if (!balanced) {
                    e.preventDefault();
                    if (warn) warn.hidden = false;
                    return;
                }
            }

            hidden.value = JSON.stringify(items);
        });

        // ── Voucher No — Default/Custom popup ── (identical pattern to
        // delivery-note.js's #dn-no popup, just the `sv-` prefix).
        (function wireNoPopup() {
            var editBtn   = document.getElementById('sv-no-edit');
            var popup     = document.getElementById('sv-no-popup');
            var noInput   = document.getElementById('sv-no');
            var modeDefault = document.getElementById('sv-no-mode-default');
            var modeCustom  = document.getElementById('sv-no-mode-custom');
            var fieldsWrap  = document.getElementById('sv-no-popup-fields');
            var prefixEl = document.getElementById('sv-no-prefix');
            var numberEl = document.getElementById('sv-no-number');
            var suffixEl = document.getElementById('sv-no-suffix');
            var cancelBtn = document.getElementById('sv-no-cancel');
            var saveBtn   = document.getElementById('sv-no-save');
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
                    noInput.value = buildVoucherNo({ prefix: prefixEl.value, number: numberEl.value, suffix: suffixEl.value });
                } else {
                    noInput.value = '';
                }
                closePopup();
            });
        })();

        // Seed the table with a single empty row, then open Date → first
        // row's item picker (keyboard-first: Date, Voucher No is optional).
        addRow();
        var dateEl = document.getElementById('sv-date');
        if (dateEl) {
            openField(dateEl);
            dateEl.addEventListener('change', function () {
                var firstRow = tbody.querySelector('.sv-row');
                if (firstRow) openField(firstRow.querySelector('.sv-item-search'));
            });
        }
    }
})();
