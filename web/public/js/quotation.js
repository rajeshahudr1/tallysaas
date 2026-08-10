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

/**
 * Totals for the on-screen panel.
 *
 * `subtotal` is the TAXABLE value — after discount, with GST taken back out of
 * a tax-inclusive rate — so the panel always reads as an arithmetic you can
 * follow: Sub Total + Taxes = Grand Total.
 *
 * It used to be the GROSS, which broke the display in two ways nobody had
 * noticed: a discounted bill showed 250 + 32.40 against a stated 262.40, and a
 * tax-inclusive line showed 118 + 18 against a stated 118 — the GST counted
 * twice on screen. `gross` and `discount` are still returned so the panel can
 * show those rows too; the stored figures (QuotationController.computeTotals)
 * are unchanged, this is presentation only.
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
        gross: r2(gross),
        discount: r2(discount),
        subtotal: r2(taxable),
        taxes: r2(taxes),
        grand: r2(taxable + taxes),
    };
}

// Custom Quotation No popup (LiveKeeping's Default/Custom panel, our theme) —
// joins Prefix/Voucher no/Suffix exactly as typed, trimmed, skipping empty
// parts. Pure function so it's unit-testable without a DOM.
function buildVoucherNo(parts) {
    var p = parts || {};
    return [p.prefix, p.number, p.suffix]
        .map(function (v) { return (v == null ? '' : String(v)).trim(); })
        .filter(function (v) { return v !== ''; })
        .join('');
}

/**
 * Which price-level slab applies at this quantity.
 *
 * Tally lets a price level band its rate by quantity ("1–99 at 100, 100+ at
 * 90"), so the rate a line gets depends on how many are being sold. A null
 * bound is open-ended on that side.
 *
 * Falls back to the FIRST slab when the quantity matches none — a level with a
 * single un-banded rate must still apply before any quantity is typed, which
 * is the common case. Returns null only when there are no slabs at all, which
 * the caller reads as "this level says nothing about this item".
 *
 * Pure, so it is unit-testable without a DOM.
 */
function slabRate(slabs, qty) {
    if (!slabs || !slabs.length) return null;
    const q = Number(qty) || 0;
    for (const s of slabs) {
        const from = s.from_qty == null ? 0 : Number(s.from_qty);
        const to   = s.to_qty == null ? Infinity : Number(s.to_qty);
        if (q >= from && q <= to) return s;
    }
    return slabs[0];
}

window.QuotationCalc = { lineAmount, formTotals, buildVoucherNo, slabRate };

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

        // A ledger balance printed the way Tally prints it: magnitude plus the
        // side it sits on. "₹-23,003.00" reads like a bug; "₹23,003.00 Dr"
        // reads like money the customer owes.
        function drCr(n) {
            var v = Number(n) || 0;
            if (v === 0) return inr(0);
            return inr(Math.abs(v)) + (v > 0 ? ' Dr' : ' Cr');
        }

        // The chosen party's standing, under the picker.
        function showPartyBalance(p) {
            var el = document.getElementById('q-party-balance');
            if (!el) return;
            if (!p || p.balance == null) { el.hidden = true; el.textContent = ''; return; }
            el.textContent = 'Closing Balance: ' + drCr(p.balance);
            el.hidden = false;
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
            // Gross + Discount only appear once there IS a discount, so a plain
            // bill stays three clean rows.
            var hasDisc = t.discount > 0;
            var grossEl = document.getElementById('q-gross');
            var grossRow = document.getElementById('q-gross-row');
            var discEl = document.getElementById('q-discount');
            var discRow = document.getElementById('q-discount-row');
            if (grossEl) grossEl.textContent = inr(t.gross);
            if (grossRow) grossRow.hidden = !hasDisc;
            if (discEl) discEl.textContent = '− ' + inr(t.discount);
            if (discRow) discRow.hidden = !hasDisc;
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

        // ── Price level ──────────────────────────────────────────────
        // What a price level DOES: it decides which rate card fills the Rate
        // column when an item is picked, instead of the item's own standard
        // price. Tally stores a card per level, optionally split into quantity
        // slabs ("100+ units at this rate"), so the lookup is item → slabs.
        //
        // The whole card is fetched once per level rather than per item, so
        // choosing an item never waits on the network.
        var priceCard = null;      // Map: lower(item name) → [slabs]
        var priceLevelEl = document.getElementById('q-price-level');

        // The rate this row should carry: the level's rate when the level has
        // one for this item, otherwise the item's own price. Returning null
        // means "no opinion" so the caller leaves what is already there.
        function priceLevelRate(productName, qty) {
            if (!priceCard || !productName) return null;
            var slabs = priceCard.get(String(productName).toLowerCase());
            var slab = slabRate(slabs, qty);
            return slab && slab.rate != null ? slab : null;
        }

        function loadPriceCard(level) {
            if (!level) { priceCard = null; reapplyPriceLevel(); return; }
            fetch('/tally/price-list?level=' + encodeURIComponent(level))
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    priceCard = new Map();
                    (j && j.data ? j.data : []).forEach(function (row) {
                        var key = String(row.stock_item || '').toLowerCase();
                        if (!key) return;
                        if (!priceCard.has(key)) priceCard.set(key, []);
                        priceCard.get(key).push(row);
                    });
                    reapplyPriceLevel();
                })
                .catch(function () {
                    // A failed lookup must not silently price the voucher at the
                    // standard rate as though the level had been applied.
                    priceCard = null;
                    reapplyPriceLevel();
                });
        }

        // Changing the level re-rates every row that already has an item —
        // otherwise the header says one thing and the lines say another.
        function reapplyPriceLevel() {
            tbody.querySelectorAll('.q-row').forEach(function (row) {
                var search = row.querySelector('.q-item-search');
                var name = search ? search.value : '';
                if (!name) return;
                var hit = priceLevelRate(name, row.querySelector('.q-qty').value);
                if (hit) {
                    row.querySelector('.q-rate').value = hit.rate;
                    if (hit.discount != null && hit.discount !== 0) {
                        row.querySelector('.q-disc').value = hit.discount;
                    }
                } else {
                    // Back to the item's own price when the level does not
                    // cover it.
                    var pid = row.querySelector('.q-item').value;
                    var prod = PRODUCTS.filter(function (x) { return String(x.id) === String(pid); })[0];
                    if (prod && prod.rate != null) row.querySelector('.q-rate').value = prod.rate;
                }
                recalcRow(row);
            });
            recalcTotals();
        }

        if (priceLevelEl) {
            priceLevelEl.addEventListener('change', function () {
                loadPriceCard(priceLevelEl.value);
            });
            if (priceLevelEl.value) loadPriceCard(priceLevelEl.value);
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
            // Rate: the chosen PRICE LEVEL wins where it covers this item —
            // that is the whole point of picking a level — otherwise the
            // item's own standard price.
            if (p) {
                var levelHit = priceLevelRate(p.name, row.querySelector('.q-qty').value);
                if (levelHit) {
                    row.querySelector('.q-rate').value = levelHit.rate;
                    if (levelHit.discount != null && levelHit.discount !== 0) {
                        row.querySelector('.q-disc').value = levelHit.discount;
                    }
                } else if (p.rate != null) {
                    row.querySelector('.q-rate').value = p.rate;
                }
            }
            // Item chosen → this row's Qty step unlocks (auto-advance gating).
            if (p) row.querySelector('.q-qty').disabled = false;
            var qty = row.querySelector('.q-qty');
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

        // Re-rate one row after its quantity changed, when the active price
        // level bands its rate by quantity. No level, or no band for this item
        // → nothing to do, and whatever the user typed into Rate stands.
        function applySlabRate(row) {
            var search = row.querySelector('.q-item-search');
            var name = search ? search.value : '';
            if (!name) return;
            var hit = priceLevelRate(name, row.querySelector('.q-qty').value);
            if (hit) row.querySelector('.q-rate').value = hit.rate;
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
                        // HSN and stock-on-hand under the name — the two things
                        // you check BEFORE committing to an item, so putting
                        // them in the option saves opening the item master.
                        // Stock is omitted (not shown as 0) when unknown, and a
                        // NEGATIVE figure is shown plainly: Tally allows it, and
                        // it means goods went out before they came in.
                        var bits = [];
                        if (p.hsn) bits.push('HSN: ' + p.hsn);
                        if (p.stock != null) {
                            bits.push('In stock: ' + p.stock + (p.unit ? ' ' + p.unit : ''));
                        }
                        if (bits.length) {
                            var sub = document.createElement('span');
                            sub.className = 'li-prod-sub';
                            sub.textContent = bits.join('  ·  ');
                            if (p.stock != null && Number(p.stock) < 0) sub.classList.add('is-negative');
                            d.appendChild(sub);
                        }
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
                    if (inp.classList.contains('q-qty')) {
                        clampQty(row);
                        // A price level can band its rate by quantity ("100+ at
                        // this rate"), so crossing a slab boundary has to
                        // re-rate the line — otherwise the qty says one band and
                        // the rate still shows the other.
                        applySlabRate(row);
                    }
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
            serialiseVoucherDetails();
        });

        // ── Buyer / Consignee / Dispatch / Order block ──
        // Each field declares its own group+key, so adding a field to the view
        // needs no change here. Empty values are dropped rather than stored as
        // "" — an absent key reads as "not entered", which is what a blank box
        // means; a stored empty string would print as a real (blank) value.
        function serialiseVoucherDetails() {
            var out = document.getElementById('q-voucher-details');
            if (!out) return;
            var details = {};
            document.querySelectorAll('.q-vd').forEach(function (el) {
                var g = el.dataset.vdGroup;
                var k = el.dataset.vdKey;
                var v = (el.value == null ? '' : String(el.value)).trim();
                if (!g || !k || v === '') return;
                if (!details[g]) details[g] = {};
                details[g][k] = v;
            });
            out.value = JSON.stringify(details);
        }

        // Picking a party fills the buyer block — that is the point of picking
        // one — but every field stays editable, because a bill-to address does
        // genuinely differ from the master often enough to matter. Only BLANK
        // fields are filled, so re-picking a party never overwrites something
        // already typed.
        function prefillBuyerFrom(p) {
            if (!p) return;
            var map = {
                name: p.name, gstin: p.gst_number, country: p.country,
                state: p.state, pincode: p.pincode, address: p.billing_address,
                registration_type: p.gst_registration_type,
                // Place of supply is the buyer's state unless stated otherwise —
                // it decides CGST+SGST vs IGST, so a sensible default beats an
                // empty box the user forgets to fill.
                place_of_supply: p.state,
            };
            Object.keys(map).forEach(function (key) {
                var el = document.querySelector('.q-vd[data-vd-group="buyer"][data-vd-key="' + key + '"]');
                if (el && !el.value && map[key]) el.value = map[key];
            });
        }

        var copyBtn = document.getElementById('q-consignee-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                document.querySelectorAll('.q-vd[data-vd-group="buyer"]').forEach(function (src) {
                    var el = document.querySelector('.q-vd[data-vd-group="consignee"][data-vd-key="' + src.dataset.vdKey + '"]');
                    if (el) el.value = src.value;
                });
            });
        }

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
                    // Clearing the party has to clear what was shown ABOUT that
                    // party too, or the balance of the party you just removed
                    // sits under an empty box.
                    if (typeof opts.onClear === 'function') opts.onClear();
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

        // ── Quotation No — Default/Custom popup (Task 3) ──
        // Pencil opens a small panel (registered through the shared
        // registerPopup()/closeAllPopups() gate above): Default leaves the
        // #q-no field empty ("Auto-generated on save" placeholder — the
        // server's own series fills it in, untouched by this feature) while
        // Custom composes buildVoucherNo({prefix, number, suffix}) into it.
        (function wireQuotationNoPopup() {
            var editBtn   = document.getElementById('q-no-edit');
            var popup     = document.getElementById('q-no-popup');
            var noInput   = document.getElementById('q-no');
            var modeDefault = document.getElementById('q-no-mode-default');
            var modeCustom  = document.getElementById('q-no-mode-custom');
            var fieldsWrap  = document.getElementById('q-no-popup-fields');
            var prefixEl = document.getElementById('q-no-prefix');
            var numberEl = document.getElementById('q-no-number');
            var suffixEl = document.getElementById('q-no-suffix');
            var cancelBtn = document.getElementById('q-no-cancel');
            var saveBtn   = document.getElementById('q-no-save');
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
                // in #q-no means Custom was saved before — restore its parts
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
            // Where the party stands right now, beside their name. This used
            // to be left out because the options carried only id/name/location
            // and opening_balance is NOT a closing balance; the customers API
            // now returns the synced Tally closing balance, so the real figure
            // is shown — and still omitted (rather than faked as ₹0.00) for a
            // party that has no synced ledger.
            getSubLabel: function (p) {
                return p.balance == null ? '' : drCr(p.balance);
            },
            getValue: function (p) { return p.id; },
            onChoose: function (p) { showPartyBalance(p); prefillBuyerFrom(p); unlockLedgerOrDate(p); },
            onClear: function () { showPartyBalance(null); },
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
            getSubLabel: function (l) { return window.VoucherExtras.ledgerSubLabel(l); },
            getValue: function (l) { return l.name; },
            onChoose: unlockDate,
        }) : null;

        if (dateEl) dateEl.addEventListener('change', unlockFirstItem);

        // ── EDIT MODE ──────────────────────────────────────────────
        // window.QUOTATION_EDIT is set by the view when the screen was opened
        // as /quotations/:id/edit. Rebuild the saved lines and fill the header,
        // then STOP — the guided "open Party and walk the user through it" flow
        // is for a blank voucher; on an existing one it would reopen a combobox
        // over data the user came here to change.
        var EDIT = window.QUOTATION_EDIT || null;
        if (EDIT) {
            var partyInput = document.getElementById('q-party');
            if (partyInput && EDIT.customer_name) partyInput.value = EDIT.customer_name;
            if (ledgerEl && EDIT.ledger_name) ledgerEl.value = EDIT.ledger_name;
            var noEl = document.getElementById('q-no');
            if (noEl && EDIT.quotation_no) noEl.value = EDIT.quotation_no;

            var lines = Array.isArray(EDIT.items) ? EDIT.items : [];
            if (!lines.length) { addRow(); }
            lines.forEach(function (it) {
                var row = addRow();
                // Match the saved product by id so HSN/unit/GST come from the
                // SAME source a fresh pick would use; fall back to the stored
                // text when the product was deleted since.
                var prod = PRODUCTS.filter(function (p) { return String(p.id) === String(it.product_id); })[0];
                if (prod) {
                    applyProduct(row, prod);
                } else {
                    var si = row.querySelector('.q-item-search');
                    if (si) si.value = it.description || it.product_name || '';
                }
                row.querySelector('.q-qty').value  = it.quantity != null ? it.quantity : 1;
                row.querySelector('.q-rate').value = it.rate != null ? it.rate : 0;
                row.querySelector('.q-disc').value = it.discount_pct != null ? it.discount_pct : 0;
                var hsn = row.querySelector('.q-hsn');   if (hsn && it.hsn) hsn.value = it.hsn;
                var unit = row.querySelector('.q-unit'); if (unit && it.unit) unit.value = it.unit;
                var tx = row.querySelector('.q-taxincl'); if (tx) tx.checked = !!it.tax_inclusive;
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
