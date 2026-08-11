'use strict';

/* ─────────────────────────────────────────────────────────────
 * app.js — site-wide UI behaviours (Phase 1, no backend).
 *
 * Wires:
 *   • Filter-card collapse chevron sync (aria-expanded ↔ rotation).
 *   • Table select-all → toggles every row checkbox in that table.
 *   • Generic checkbox-group select-all ([data-select-all-checks]).
 *   • Textarea char counters ([data-counter] → "n/max").
 *   • "Same as Shipping Address" → copy shipping → billing + disable.
 *   • PWA install: capture beforeinstallprompt, reveal the header
 *     "Install App" button, prompt on click.
 *   • Online/offline indicator in the header.
 *
 * Everything is defensively guarded so a page missing a given widget
 * never throws. Bootstrap handles the offcanvas sidebar drawer and tab
 * switching declaratively (data-bs-* attrs in the markup).
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        initSidebarCollapse();
        initSidebarGroups();
        initTableDropdowns();
        initConfirms();
        initRowActions();
        initListControls();
        initExport();
        initSelectAll();
        initCheckGroups();
        initCharCounters();
        initSearchableSelects();
        initSelectObserver();
        initSameAsShipping();
        initSyncButtons();
        initNotifications();
        initPwaInstall();
        initOfflineIndicator();
        initCompanyInfo();
        // Bootstrap's collapse already toggles aria-expanded on the
        // filter-card header (it is the [data-bs-toggle] element), so the
        // chevron rotation is pure CSS. Nothing to wire here.
    }

    /* ── Searchable selects — turn any big native <select> into a filterable
     * dropdown so long dynamic lists (customers, products, …) are typeable.
     * Auto-applies to any single <select> with more than 8 options; opt OUT
     * with class "no-search", force ON a small one with "searchable-select".
     * The native <select> stays in the DOM (visually hidden) so form submit +
     * the option values are unchanged — selection is mirrored onto it and its
     * 'change' event fired. ─────────────────────────────────────────── */
    var _ssStyled = false;
    function _ssInjectStyle() {
        if (_ssStyled) return;
        _ssStyled = true;
        var css =
            '.ss-wrap{position:relative}' +
            '.ss-native{position:absolute!important;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none}' +
            '.ss-trigger{text-align:left;display:flex;align-items:center;width:100%;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
            '.ss-trigger.ss-placeholder{color:#9aa2b1}' +
            '.ss-panel{display:none;position:fixed;z-index:1080;background:#fff;border:1px solid #E9EDF3;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.10);overflow:hidden}' +
            '.ss-wrap.is-open .ss-panel{display:block}' +
            '.ss-search-wrap{padding:8px;border-bottom:1px solid #eef0f4}' +
            '.ss-search{width:100%;border:1px solid #E4E7EC;border-radius:9px;padding:8px 11px;font-size:.9rem;outline:none}' +
            '.ss-search:focus{border-color:#1560E0;box-shadow:0 0 0 3px rgba(21,96,224,.12)}' +
            '.ss-list{list-style:none;margin:0;padding:4px;max-height:260px;overflow-y:auto}' +
            '.ss-item{padding:9px 12px;border-radius:8px;cursor:pointer;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.ss-item:hover,.ss-item.is-active{background:#F5F7FB}' +
            '.ss-item.is-selected{background:#EAF1FE;color:#1560E0;font-weight:600}' +
            '.ss-item.is-disabled{color:#b6bcc9;cursor:default}' +
            '.ss-empty{padding:12px 10px;color:#9aa2b1;font-size:.88rem;text-align:center}';
        var st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
    }

    function initSearchableSelects() {
        _ssInjectStyle();
        document.querySelectorAll('select').forEach(function (sel) {
            if (sel.dataset.ssEnhanced) return;
            if (sel.multiple) return;
            if (sel.classList.contains('no-search')) return;
            var force = sel.classList.contains('searchable-select');
            if (!force && sel.options.length <= 8) return;
            _ssEnhance(sel);
        });
        // Re-sync every enhanced trigger. Setting sel.value from script fires
        // NO 'change' event, so without this the button keeps showing the old
        // label after a programmatic reset — which reads as "my selection
        // didn't take". Cheap enough to run on every rescan.
        document.querySelectorAll('select[data-ss-enhanced]').forEach(function (sel) {
            if (typeof sel._ssSync === 'function') sel._ssSync();
        });
    }

    /* Selects that arrive AFTER load — options fetched over AJAX (the
     * country/state/city cascade on every "Add Customer" form), rows cloned
     * from a <template>, whole modals injected — were never enhanced, because
     * the scan above only ever ran once on DOMContentLoaded. An empty <select>
     * also fails the ">8 options" test, so it stayed a bare native control
     * even after 200 countries landed in it. Watch the DOM and rescan. */
    function initSelectObserver() {
        if (!window.MutationObserver) return;
        var queued = false;
        var rescan = function () {
            if (queued) return;
            queued = true;
            // Coalesce bursts (a cascade fills 3 selects back to back).
            (window.requestAnimationFrame || window.setTimeout)(function () {
                queued = false;
                initSearchableSelects();
            }, 0);
        };
        // Ignore the widget's OWN rendering (the trigger label and the dropdown
        // panel it rebuilds on every keystroke). Watching those would mean this
        // observer reacts to work it caused itself. A <select>'s own <option>
        // children still count — that is exactly the AJAX case we are here for.
        function isOurOwnChurn(node) {
            for (var el = node; el; el = el.parentNode) {
                if (el.nodeType !== 1) continue;
                if (el.tagName === 'SELECT') return false;
                if (el.classList && (el.classList.contains('ss-panel') ||
                                     el.classList.contains('ss-trigger'))) return true;
            }
            return false;
        }

        new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                if (r.type !== 'childList') continue;
                if (!r.addedNodes.length && !r.removedNodes.length) continue;
                if (isOurOwnChurn(r.target)) continue;
                rescan();
                return;
            }
        }).observe(document.body, { childList: true, subtree: true });
        // Expose it so page scripts can force a resync right after they reset
        // a form's values by hand.
        window.TCS = window.TCS || {};
        window.TCS.refreshSelects = initSearchableSelects;
    }

    function _ssEnhance(sel) {
        sel.dataset.ssEnhanced = '1';

        var wrap = document.createElement('div');
        wrap.className = 'ss-wrap';
        sel.parentNode.insertBefore(wrap, sel);
        wrap.appendChild(sel);
        sel.classList.add('ss-native');

        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'ss-trigger form-select';
        wrap.appendChild(trigger);

        var panel = document.createElement('div');
        panel.className = 'ss-panel';
        panel.innerHTML =
            '<div class="ss-search-wrap"><input type="text" class="ss-search" placeholder="Type to search…" autocomplete="off"></div>' +
            '<ul class="ss-list" role="listbox"></ul>';
        wrap.appendChild(panel);

        var search = panel.querySelector('.ss-search');
        var list = panel.querySelector('.ss-list');

        function syncTrigger() {
            var o = sel.options[sel.selectedIndex];
            var label = o ? o.textContent : '';
            // Assign ONLY on a real change. Writing textContent replaces the
            // text node even when the string is identical, and that counts as a
            // DOM mutation — which the rescan observer below would see, run this
            // again, and spin forever, freezing every click on the page.
            if (trigger.textContent !== label) trigger.textContent = label;
            trigger.classList.toggle('ss-placeholder', !!(o && (o.disabled || o.value === '')));
        }

        function buildList(filter) {
            list.innerHTML = '';
            var q = (filter || '').toLowerCase();
            for (var i = 0; i < sel.options.length; i++) {
                var o = sel.options[i];
                if (o.hidden) continue;
                var txt = o.textContent;
                if (q && txt.toLowerCase().indexOf(q) === -1) continue;
                var li = document.createElement('li');
                li.className = 'ss-item' + (i === sel.selectedIndex ? ' is-selected' : '') + (o.disabled ? ' is-disabled' : '');
                li.textContent = txt;
                li.dataset.idx = String(i);
                list.appendChild(li);
            }
            if (!list.children.length) {
                var empty = document.createElement('li');
                empty.className = 'ss-empty';
                empty.textContent = 'No matches';
                list.appendChild(empty);
            }
        }

        // The panel is position:fixed (so it escapes any ancestor overflow clip,
        // e.g. .filter-card{overflow:hidden}); pin it under the trigger.
        function placePanel() {
            var r = trigger.getBoundingClientRect();
            panel.style.left  = r.left + 'px';
            panel.style.top   = (r.bottom + 4) + 'px';
            panel.style.width = r.width + 'px';
        }
        function openPanel() {
            wrap.classList.add('is-open');
            search.value = '';
            buildList('');
            placePanel();
            setTimeout(function () { search.focus(); }, 0);
            var selEl = list.querySelector('.is-selected');
            if (selEl) selEl.scrollIntoView({ block: 'nearest' });
        }
        function closePanel() { wrap.classList.remove('is-open'); }
        // Keep the fixed panel pinned while open (page/card scroll, resize).
        window.addEventListener('scroll', function () { if (wrap.classList.contains('is-open')) placePanel(); }, true);
        window.addEventListener('resize', function () { if (wrap.classList.contains('is-open')) placePanel(); });
        function choose(i) {
            if (!sel.options[i] || sel.options[i].disabled) return;
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            syncTrigger();
            closePanel();
            trigger.focus();
        }

        trigger.addEventListener('click', function (e) {
            e.preventDefault();
            if (wrap.classList.contains('is-open')) closePanel(); else openPanel();
        });
        search.addEventListener('input', function () { buildList(search.value); });
        list.addEventListener('click', function (e) {
            var li = e.target.closest('.ss-item');
            if (li && li.dataset.idx != null) choose(parseInt(li.dataset.idx, 10));
        });
        search.addEventListener('keydown', function (e) {
            var items = Array.prototype.slice.call(list.querySelectorAll('.ss-item:not(.is-disabled)'));
            var active = list.querySelector('.ss-item.is-active');
            var idx = items.indexOf(active);
            if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); }
            else if (e.key === 'Enter') { e.preventDefault(); if (active) choose(parseInt(active.dataset.idx, 10)); return; }
            else if (e.key === 'Escape') { closePanel(); trigger.focus(); return; }
            else return;
            items.forEach(function (it) { it.classList.remove('is-active'); });
            if (items[idx]) { items[idx].classList.add('is-active'); items[idx].scrollIntoView({ block: 'nearest' }); }
        });
        document.addEventListener('click', function (e) {
            if (!wrap.contains(e.target)) closePanel();
        });

        sel.addEventListener('change', syncTrigger);
        // Let initSearchableSelects() refresh this trigger after the options
        // or the value were changed from script (no 'change' event fires then).
        sel._ssSync = syncTrigger;
        syncTrigger();
    }

    /* ── Desktop sidebar collapse (topbar ☰) ──────────────────────
     * Below 992px the hamburger is Bootstrap's offcanvas trigger and we
     * leave it alone. At ≥992px there is no drawer, so the same button
     * toggles an icon-only rail instead — matching the reference product,
     * where ☰ collapses the menu rather than opening one. The choice is
     * remembered so it survives navigation.
     * ─────────────────────────────────────────────────────────── */
    function initSidebarCollapse() {
        var KEY = 'tcs.sidebar.rail';
        var btn = document.querySelector('[data-sidebar-toggle]');
        if (!btn) return;

        var isDesktop = function () { return window.matchMedia('(min-width: 992px)').matches; };

        function apply(collapsed) {
            document.body.classList.toggle('sidebar-collapsed', collapsed);
            btn.setAttribute('aria-expanded', String(!collapsed));
        }

        /* Everything that floats over the page — the combobox menus, the date
           popup — is position:fixed at coordinates read from its field. The
           rail shifts every field sideways WITHOUT a scroll or a window
           resize, so those popups stayed where they were and pointed at
           nothing. They all re-place on `resize`, so say so — repeatedly,
           because the sidebar animates over ~250ms and the field is still
           moving.

           Called ONLY from the click below — never from apply(), which the
           window-resize handler also calls: dispatching resize from inside a
           resize handler is an infinite loop. */
        function reflowOverlays() {
            var stop = Date.now() + 400;
            (function tick() {
                window.dispatchEvent(new Event('resize'));
                if (Date.now() < stop) requestAnimationFrame(tick);
            })();
        }

        try { if (isDesktop() && localStorage.getItem(KEY) === '1') apply(true); }
        catch (e) { /* ignore */ }

        btn.addEventListener('click', function (ev) {
            ev.preventDefault();

            if (isDesktop()) {
                var collapsed = !document.body.classList.contains('sidebar-collapsed');
                apply(collapsed);
                reflowOverlays();
                try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
                return;
            }

            // Mobile: open the offcanvas drawer ourselves. The button carries
            // no data-bs-toggle, so this is the only thing that opens it and
            // the two behaviours can never both fire on one click.
            var sel = btn.getAttribute('data-sidebar-toggle');
            var el  = sel && document.querySelector(sel);
            if (el && window.bootstrap && window.bootstrap.Offcanvas) {
                window.bootstrap.Offcanvas.getOrCreateInstance(el).toggle();
            }
        });

        // Crossing the breakpoint must not leave the rail class on, or the
        // offcanvas drawer would render as a 72px stub.
        window.addEventListener('resize', function () {
            if (!isDesktop()) document.body.classList.remove('sidebar-collapsed');
            else { try { apply(localStorage.getItem(KEY) === '1'); } catch (e) { /* ignore */ } }
        });
    }

    /* ── Sidebar group collapse / expand (accordion) ──────────────
     * Each labelled menu group has a [data-group] toggle button + a
     * [data-group-items] list. Only ONE group is ever open: opening a
     * group closes the others. Every group starts collapsed — except the
     * one holding the current page ([data-group-active]) — so a fresh
     * login shows a fully collapsed menu.
     * ─────────────────────────────────────────────────────────── */
    function initSidebarGroups() {
        function apply(gid, isCollapsed) {
            document.querySelectorAll('[data-group="' + gid + '"]').forEach(function (btn) {
                btn.classList.toggle('is-collapsed', isCollapsed);
                btn.setAttribute('aria-expanded', String(!isCollapsed));
            });
            document.querySelectorAll('[data-group-items="' + gid + '"]').forEach(function (list) {
                list.classList.toggle('is-collapsed', isCollapsed);
            });
        }

        var toggles = [].slice.call(document.querySelectorAll('.sidebar-section-toggle'));

        // Collapse everything, then re-open only the active page's group.
        toggles.forEach(function (btn) {
            apply(btn.getAttribute('data-group'), !btn.hasAttribute('data-group-active'));
        });

        toggles.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var gid = btn.getAttribute('data-group');
                var nowCollapsed = !btn.classList.contains('is-collapsed');
                // Accordion: close every other group first.
                toggles.forEach(function (other) {
                    var oid = other.getAttribute('data-group');
                    if (oid !== gid) apply(oid, true);
                });
                apply(gid, nowCollapsed);
            });
        });
    }

    /* ── Table row-action ⋮ dropdowns ─────────────────────────────
     * The table wrapper scrolls horizontally (overflow-x:auto) when a listing
     * is wider than its card, so a normally-positioned dropdown menu would be
     * CLIPPED inside that scroll box. Pre-initialise each row-action dropdown
     * with Popper strategy:'fixed' → its menu is positioned against the
     * viewport and floats ABOVE the scroll box instead of being cut off.
     * ─────────────────────────────────────────────────────────── */
    function initTableDropdowns() {
        var BS = window.bootstrap;
        if (!BS || !BS.Dropdown) return;
        document.querySelectorAll('.data-table-actions [data-bs-toggle="dropdown"]').forEach(function (el) {
            BS.Dropdown.getOrCreateInstance(el, {
                popperConfig: function (defaultConfig) {
                    return Object.assign({}, defaultConfig, { strategy: 'fixed' });
                },
            });
        });
    }

    /* ── Generic custom confirm — replaces the native confirm() dialog ──
     * Any <form data-confirm="Message?"> shows the on-brand #confirmActionModal
     * instead of the ugly "localhost says…" box. On Confirm the form submits
     * (and only THEN does the action-loader spin — cancelling leaves the button
     * untouched). Optional data-confirm-title / data-confirm-ok customise it.
     * ─────────────────────────────────────────────────────────── */
    function initConfirms() {
        var BS = window.bootstrap;
        var el = document.getElementById('confirmActionModal');
        if (!BS || !el) return;
        var modal   = BS.Modal.getOrCreateInstance(el);
        var titleEl = document.getElementById('confirmActionTitle');
        var textEl  = document.getElementById('confirmActionText');
        var okBtn   = document.getElementById('confirmActionBtn');
        var pending = null;   // the form waiting on confirmation

        okBtn.addEventListener('click', function () {
            var form = pending; pending = null;
            modal.hide();
            if (form) { form.dataset._confirmed = '1'; form.submit(); }
        });
        el.addEventListener('hidden.bs.modal', function () { pending = null; });

        // Capture phase → runs BEFORE the bubble-phase action-loader, so a
        // cancelled confirm never spins the button.
        document.addEventListener('submit', function (e) {
            var form = e.target;
            if (!form || form.tagName !== 'FORM' || form.dataset.confirm == null) return;
            if (form.dataset._confirmed === '1') { delete form.dataset._confirmed; return; }
            e.preventDefault();
            if (titleEl) titleEl.textContent = form.dataset.confirmTitle || 'Are you sure?';
            if (textEl)  textEl.textContent  = form.dataset.confirm;
            okBtn.textContent = form.dataset.confirmOk || 'Confirm';
            okBtn.className = 'btn px-4 ' + (form.dataset.confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary');
            pending = form;
            modal.show();
        }, true);
    }

    /* ── Row actions: custom View / Delete popups ─────────────────
     * Replaces browser confirm()/alert() with on-brand Bootstrap modals.
     *   • [data-row-view]   → fills + opens the details modal from its
     *                         data-record JSON (label/value pairs).
     *   • [data-row-delete] → opens the confirm modal; on confirm, POSTs to
     *                         {data-delete-url}/delete (route deletes + flashes).
     * Delegated from document so it also covers rows added after load.
     * ─────────────────────────────────────────────────────────── */
    function initRowActions() {
        var BS = window.bootstrap;
        var delEl  = document.getElementById('confirmDeleteModal');
        var viewEl = document.getElementById('viewRecordModal');
        var delModal  = (BS && delEl)  ? BS.Modal.getOrCreateInstance(delEl)  : null;
        var viewModal = (BS && viewEl) ? BS.Modal.getOrCreateInstance(viewEl) : null;
        var pendingUrl = null;

        document.addEventListener('click', function (e) {
            var del = e.target.closest('[data-row-delete]');
            if (del && delModal) {
                e.preventDefault();
                pendingUrl = del.getAttribute('data-delete-url');
                var label = del.getAttribute('data-delete-label') || 'this record';
                var txt = document.getElementById('confirmDeleteText');
                if (txt) {
                    txt.textContent = '';
                    txt.appendChild(document.createTextNode('You are about to delete '));
                    var strong = document.createElement('strong');
                    strong.textContent = label;
                    txt.appendChild(strong);
                    txt.appendChild(document.createTextNode('. This action cannot be undone.'));
                }
                delModal.show();
                return;
            }

            var view = e.target.closest('[data-row-view]');
            if (view && viewModal) {
                e.preventDefault();
                var rec = [];
                try { rec = JSON.parse(view.getAttribute('data-record') || '[]'); } catch (err) { rec = []; }
                var title = view.getAttribute('data-record-title') || 'Details';
                var titleEl = document.getElementById('viewRecordTitle');
                var body = document.getElementById('viewRecordBody');
                if (titleEl) titleEl.textContent = title;
                if (body) {
                    body.textContent = '';
                    rec.forEach(function (r) {
                        // A {group:'…'} entry renders a tab-wise section header.
                        if (r && r.group) {
                            var h = document.createElement('div');
                            h.className = 'record-detail-group';
                            h.textContent = r.group;
                            h.style.cssText = 'font-weight:600;margin:14px 0 6px;color:#1560E0;border-bottom:1px solid #e5e7eb;padding-bottom:4px;';
                            body.appendChild(h);
                            return;
                        }
                        var rowEl = document.createElement('div'); rowEl.className = 'record-detail-row';
                        var dt = document.createElement('dt'); dt.textContent = r.label;
                        var dd = document.createElement('dd'); dd.textContent = r.value;
                        rowEl.appendChild(dt); rowEl.appendChild(dd); body.appendChild(rowEl);
                    });
                }
                viewModal.show();
                return;
            }
        });

        var confirmBtn = document.getElementById('confirmDeleteBtn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', function () {
                if (!pendingUrl) return;
                confirmBtn.disabled = true;
                var form = document.createElement('form');
                form.method = 'POST';
                form.action = pendingUrl + '/delete';
                document.body.appendChild(form);
                form.submit();
            });
        }
    }

    /* ── List controls: per-page + Ctrl/Cmd+K search focus ────────
     * "Show N entries" reloads the list with ?per_page=N&page=1 (the
     * backend already honours per_page). Filters in the query string are
     * preserved by URL(). Ctrl/Cmd+K focuses the global search box.
     * ─────────────────────────────────────────────────────────── */
    function initListControls() {
        document.querySelectorAll('[data-perpage], .toolbar-show select').forEach(function (sel) {
            sel.addEventListener('change', function () {
                var u = new URL(window.location.href);
                u.searchParams.set('per_page', sel.value);
                u.searchParams.set('page', '1');
                window.location.assign(u.toString());
            });
        });

        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
                var s = document.querySelector('.topbar-search-input');
                if (s) { e.preventDefault(); s.focus(); }
            }
        });

        // Toolbar "Sort By" select → map the chosen column label to a sortable
        // header's key (data-sort-key) and reload with ?sort=&order=.
        document.querySelectorAll('.toolbar-sort select').forEach(function (sel) {
            sel.addEventListener('change', function () {
                var label = (sel.options[sel.selectedIndex].text || '').trim().toLowerCase();
                var hit = Array.prototype.filter.call(
                    document.querySelectorAll('[data-sort-key]'),
                    function (a) { return a.textContent.trim().toLowerCase() === label; }
                )[0];
                if (!hit) return; // not a backend-sortable column
                var u = new URL(window.location.href);
                u.searchParams.set('sort', hit.getAttribute('data-sort-key'));
                if (!u.searchParams.get('order')) u.searchParams.set('order', 'asc');
                u.searchParams.set('page', '1');
                window.location.assign(u.toString());
            });
        });

        // Sort-direction toggle button → flip ?order (only if a sort is active).
        document.querySelectorAll('.sort-dir-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var u = new URL(window.location.href);
                if (!u.searchParams.get('sort')) return;
                u.searchParams.set('order', u.searchParams.get('order') === 'asc' ? 'desc' : 'asc');
                u.searchParams.set('page', '1');
                window.location.assign(u.toString());
            });
        });
    }

    /* ── Export → CSV ─────────────────────────────────────────────
     * Any [data-export] button (the page-head "Export") downloads the
     * current page's data table as a CSV — client-side, no backend. Skips
     * the checkbox + actions columns and the "no records" row. A UTF-8 BOM
     * is prepended so Excel opens ₹/non-ASCII correctly.
     * ─────────────────────────────────────────────────────────── */
    function initExport() {
        document.querySelectorAll('[data-export]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                var table = document.querySelector('.data-table');
                if (!table) return;
                var csv = tableToCsv(table);
                if (csv == null) return;
                var name = (document.title.split('·')[0].trim() || 'export')
                    .replace(/\s+/g, '-').toLowerCase();
                downloadCsv(csv, name + '.csv');
            });
        });
    }

    function tableToCsv(table) {
        function skip(cell) {
            return cell.classList.contains('data-table-check') ||
                   cell.classList.contains('data-table-actions') ||
                   cell.classList.contains('data-table-actions-head');
        }
        function esc(v) {
            v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
            if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
            return v;
        }
        var lines = [];
        var head = table.querySelector('thead tr');
        if (head) {
            var hc = Array.prototype.filter.call(head.children, function (c) { return !skip(c); });
            lines.push(hc.map(function (c) { return esc(c.textContent); }).join(','));
        }
        Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
            if (tr.querySelector('.data-table-empty')) return;
            var cells = Array.prototype.filter.call(tr.children, function (c) { return !skip(c); });
            if (!cells.length) return;
            lines.push(cells.map(function (c) { return esc(c.textContent); }).join(','));
        });
        return lines.join('\r\n');
    }

    function downloadCsv(csv, filename) {
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /* ── Table select-all ─────────────────────────────────────── */
    function initSelectAll() {
        document.querySelectorAll('[data-select-all]').forEach(function (master) {
            var tableId = master.getAttribute('data-select-all');
            master.addEventListener('change', function () {
                document
                    .querySelectorAll('[data-row-check="' + tableId + '"]')
                    .forEach(function (cb) { cb.checked = master.checked; });
            });

            // Keep the master in sync if a row checkbox is toggled.
            var rows = document.querySelectorAll('[data-row-check="' + tableId + '"]');
            rows.forEach(function (cb) {
                cb.addEventListener('change', function () {
                    var all = Array.prototype.every.call(rows, function (r) { return r.checked; });
                    var none = Array.prototype.every.call(rows, function (r) { return !r.checked; });
                    master.checked = all;
                    master.indeterminate = !all && !none;
                });
            });
        });
    }

    /* ── Generic checkbox-group select-all ────────────────────────
     * Markup contract (NOT tied to a table):
     *   master   <input type="checkbox" data-select-all-checks="<group>">
     *   members  <input type="checkbox" data-check-group="<group>">
     * Used by e.g. the Sales Person → Assigned Locations mapping grid.
     * ─────────────────────────────────────────────────────────── */
    function initCheckGroups() {
        document.querySelectorAll('[data-select-all-checks]').forEach(function (master) {
            var group = master.getAttribute('data-select-all-checks');
            var members = document.querySelectorAll('[data-check-group="' + group + '"]');
            if (!members.length) return;

            master.addEventListener('change', function () {
                members.forEach(function (cb) { cb.checked = master.checked; });
            });

            members.forEach(function (cb) {
                cb.addEventListener('change', function () {
                    var all  = Array.prototype.every.call(members, function (m) { return m.checked; });
                    var none = Array.prototype.every.call(members, function (m) { return !m.checked; });
                    master.checked = all;
                    master.indeterminate = !all && !none;
                });
            });
        });
    }

    /* ── Tally sync buttons (demo spinner) ────────────────────────
     * Any [data-sync-btn] shows a "Syncing…" spinner, then a brief
     * "Synced" tick, then restores. Visual only (no backend in Phase 1).
     * ─────────────────────────────────────────────────────────── */
    function initSyncButtons() {
        document.querySelectorAll('[data-sync-btn], .btn-sync-now, #sync-now, #sync-retry').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (btn.classList.contains('is-syncing')) return;
                var original = btn.innerHTML;
                btn.classList.add('is-syncing');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Syncing…';
                setTimeout(function () {
                    btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Synced';
                    setTimeout(function () {
                        btn.innerHTML = original;
                        btn.classList.remove('is-syncing');
                        btn.disabled = false;
                    }, 1200);
                }, 1400);
            });
        });
    }

    /* ── Notification bell read-tracking ──────────────────────────
     * Per-item read state for the header bell (header.ejs):
     *   • Clicking a [data-notif-key] item → POST /notifications/read {key};
     *     on success set the live .topbar-badge to the returned `unread`
     *     (remove it at 0) + mark that item read. The item's normal navigation
     *     is NOT blocked — we fire the fetch and let the real link proceed (only
     *     preventDefault for placeholder "#"/empty hrefs, e.g. agent-update).
     *   • Clicking #notif-mark-all → preventDefault + POST /notifications/read-all
     *     → badge to 0 (removed) + every dropdown item marked read.
     * Everything is null-guarded so a page without the bell is a no-op. Bodies
     * are form-encoded (matches the web's express.urlencoded parser). */
    function initNotifications() {
        // Locate the bell's badge fresh each time (it may have been removed).
        function badgeEl() { return document.querySelector('.topbar-badge'); }

        // Set the visible unread number. 0 (or null/blank) removes the badge.
        function setBadge(n) {
            var num = Number(n);
            var el = badgeEl();
            if (!Number.isFinite(num) || num <= 0) {
                if (el && el.parentNode) el.parentNode.removeChild(el);
                return;
            }
            if (el) { el.textContent = String(num); return; }
            // No badge present but count > 0: recreate it inside the bell button.
            var btn = document.querySelector('.topbar-icon-btn');
            if (!btn) return;
            var span = document.createElement('span');
            span.className = 'topbar-badge';
            span.textContent = String(num);
            btn.appendChild(span);
        }

        // Flip an item's read classes.
        function markItemRead(item) {
            if (!item) return;
            item.classList.remove('is-unread');
            item.classList.add('is-read');
        }

        // POST a form-encoded body and resolve the parsed JSON (or null).
        // keepalive:true so the request still completes when the click also
        // navigates the page away (failed-sync items link to /sync-logs) — the
        // body is tiny, well under the keepalive size cap, so the mark-read
        // actually lands and persists across the reload.
        function postForm(action, params) {
            var body = new URLSearchParams(params || {}).toString();
            return fetch(action, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                keepalive: true,
                body: body,
            }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        }

        // Per-item click (delegated). Fire the mark-read, DON'T block real nav.
        document.addEventListener('click', function (e) {
            var item = e.target.closest('[data-notif-key]');
            if (!item) return;
            var key = item.getAttribute('data-notif-key');
            if (!key) return;
            // Already read → nothing to do (idempotent server-side anyway).
            if (item.classList.contains('is-read')) return;

            // If the link has no real destination (placeholder "#"/empty — e.g.
            // the agent-update entry), keep the dropdown usable by preventing the
            // jump; otherwise let the browser navigate after we fire the fetch.
            var href = item.getAttribute('href') || '';
            if (href === '' || href.charAt(0) === '#') e.preventDefault();

            postForm('/notifications/read', { key: key }).then(function (j) {
                if (j && j.ok) {
                    markItemRead(item);
                    if (j.unread != null) setBadge(j.unread);
                }
            });
        });

        // "Mark all read" → zero the badge + mark every dropdown item read.
        var markAll = document.getElementById('notif-mark-all');
        if (markAll) {
            markAll.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                postForm('/notifications/read-all', {}).then(function (j) {
                    if (j && j.ok) {
                        setBadge(0);
                        document.querySelectorAll('[data-notif-key]').forEach(markItemRead);
                        // Hide itself — there is nothing left to mark.
                        markAll.style.display = 'none';
                    }
                });
            });
        }

        // "Mark all read" on the dedicated /notifications page → reload so the
        // whole list re-renders as read (and the badge clears).
        var pageMarkAll = document.getElementById('notif-page-mark-all');
        if (pageMarkAll) {
            pageMarkAll.addEventListener('click', function () {
                pageMarkAll.disabled = true;
                postForm('/notifications/read-all', {}).then(function () {
                    window.location.reload();
                });
            });
        }
    }

    /* ── Char counters ────────────────────────────────────────────
     * Markup contract: a <textarea data-counter="<targetId>" maxlength="300">
     * paired with <span id="<targetId>">0/300</span> (or any element whose
     * text we overwrite). We read maxlength for the cap.
     * ─────────────────────────────────────────────────────────── */
    function initCharCounters() {
        document.querySelectorAll('[data-counter]').forEach(function (field) {
            var targetId = field.getAttribute('data-counter');
            var out = document.getElementById(targetId);
            if (!out) return;
            var max = parseInt(field.getAttribute('maxlength'), 10) || 300;
            var update = function () { out.textContent = field.value.length + '/' + max; };
            field.addEventListener('input', update);
            update();
        });
    }

    /* ── "Same as Shipping Address" ───────────────────────────────
     * Markup contract:
     *   checkbox  [data-same-as-shipping]  with
     *     data-source="<shippingTextareaId>" data-target="<billingTextareaId>"
     * When checked: copy source → target, mirror future edits, disable target.
     * ─────────────────────────────────────────────────────────── */
    function initSameAsShipping() {
        document.querySelectorAll('[data-same-as-shipping]').forEach(function (box) {
            var source = document.getElementById(box.getAttribute('data-source'));
            var target = document.getElementById(box.getAttribute('data-target'));
            if (!source || !target) return;

            var mirror = function () { target.value = source.value; fireCounter(target); };

            var apply = function () {
                if (box.checked) {
                    mirror();
                    target.setAttribute('disabled', 'disabled');
                    source.addEventListener('input', mirror);
                } else {
                    target.removeAttribute('disabled');
                    source.removeEventListener('input', mirror);
                }
            };
            box.addEventListener('change', apply);
            apply();
        });
    }

    // Re-run a textarea's counter after a programmatic value change.
    function fireCounter(el) {
        if (el.hasAttribute('data-counter')) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /* ── Company Information (switcher ⓘ) ─────────────────────────
     * One modal serves every company row: the clicked button's data-*
     * attributes are copied into the matching [data-ci] cells. Timestamps
     * are rendered in the user's locale here rather than server-side so the
     * panel always reads in local time. */
    function initCompanyInfo() {
        var BS = window.bootstrap;
        var el = document.getElementById('companyInfoModal');
        if (!BS || !el) return;
        var modal = BS.Modal.getOrCreateInstance(el);

        function stamp(v) {
            if (!v) return '—';
            var d = new Date(v);
            if (isNaN(d.getTime())) return '—';
            return d.toLocaleString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
        }
        function day(v) {
            if (!v) return '—';
            var d = new Date(v);
            if (isNaN(d.getTime())) return '—';
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        }
        function put(key, text) {
            var cell = el.querySelector('[data-ci="' + key + '"]');
            if (cell) cell.textContent = text || '—';
        }

        document.addEventListener('click', function (ev) {
            var btn = ev.target.closest('[data-company-info]');
            if (!btn) return;
            // Inside a dropdown item row — don't follow the switch link.
            ev.preventDefault();
            ev.stopPropagation();

            put('name',          btn.getAttribute('data-name'));
            put('booksFrom',     day(btn.getAttribute('data-books-from')));
            put('financialYear', btn.getAttribute('data-financial-year'));
            put('lastSync',      btn.getAttribute('data-last-sync'));
            put('lastPull',      stamp(btn.getAttribute('data-last-pull')));
            put('lastPush',      stamp(btn.getAttribute('data-last-push')));
            put('created',       stamp(btn.getAttribute('data-created')));
            put('status',        btn.getAttribute('data-status'));
            modal.show();
        });
    }

    /* ── PWA install prompt ───────────────────────────────────── */
    function initPwaInstall() {
        var deferred = null;
        var btn = document.getElementById('installAppBtn');

        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            deferred = e;
            if (btn) btn.hidden = false;
        });

        if (btn) {
            btn.addEventListener('click', function () {
                if (!deferred) return;
                deferred.prompt();
                deferred.userChoice.finally(function () {
                    deferred = null;
                    btn.hidden = true;
                });
            });
        }

        window.addEventListener('appinstalled', function () {
            if (btn) btn.hidden = true;
            deferred = null;
        });
    }

    /* ── Online / offline indicator ───────────────────────────── */
    function initOfflineIndicator() {
        var dot = document.getElementById('offlineIndicator');
        var sync = function () {
            var offline = navigator.onLine === false;
            document.body.classList.toggle('is-offline', offline);
            if (dot) dot.hidden = !offline;
        };
        window.addEventListener('online', sync);
        window.addEventListener('offline', sync);
        sync();
    }

    /* ── Action loaders ───────────────────────────────────────────
     * Immediate feedback on every action: a Bootstrap spinner + disabled
     * trigger on form submits (create/update/delete/import/filter/search)
     * and on navigating action buttons/links (export, "Add new", or any
     * [data-loader]). Server-rendered forms navigate away; download/in-page
     * actions auto-restore after a moment. Opt out with data-no-loader. */
    function _spin(el) {
        if (!el || el.dataset._busy) return;
        el.dataset._busy = '1';
        el.dataset._html = el.innerHTML;
        el.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>'
            + (el.dataset.loadingText || 'Please wait…');
        if (el.tagName === 'BUTTON') el.disabled = true;
        el.classList.add('is-loading');
    }
    function _unspin(el) {
        if (!el || !el.dataset._busy) return;
        if (el.dataset._html != null) el.innerHTML = el.dataset._html;
        el.disabled = false;
        el.classList.remove('is-loading');
        delete el.dataset._busy; delete el.dataset._html;
    }
    document.addEventListener('submit', function (e) {
        // BUBBLE phase (not capture) + defaultPrevented guard: this runs AFTER any
        // inline onsubmit / data-confirm handler, so if the user CANCELS a confirm
        // (submit is prevented) we never spin a button that will just sit stuck on
        // "Please wait…". Only spin when the form is genuinely about to submit.
        if (e.defaultPrevented) return;
        var form = e.target;
        if (!form || form.tagName !== 'FORM' || form.dataset.noLoader != null) return;
        if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;
        var btn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (!btn && document.activeElement && document.activeElement.type === 'submit') btn = document.activeElement;
        _spin(btn);
    }, false);
    document.addEventListener('click', function (e) {
        var el = e.target.closest('a.btn, button[data-loader], a[data-loader]');
        if (!el || el.matches('[data-bs-toggle], [data-bs-dismiss]')) return;
        if (el.tagName === 'A') {
            var href = el.getAttribute('href') || '';
            if ((href === '' || href.charAt(0) === '#') && el.dataset.loader == null) return;
            if (el.target === '_blank' && el.dataset.loader == null) return;
        }
        _spin(el);
        setTimeout(function () { _unspin(el); }, parseInt(el.dataset.loaderMs, 10) || 2500);
    });
})();

/* ── Live list search — one box on EVERY list page, right of "Show entries".
 * Injected into each page's .table-toolbar and applied SERVER-SIDE via the
 * ?search= query param (the generic list route already forwards it, so it
 * searches ALL records, not just the rows on screen). Debounced so results
 * refresh a moment after you stop typing. Single source → works everywhere. ── */
(function () {
    function currentSearch() {
        try { return new URLSearchParams(window.location.search).get('search') || ''; }
        catch (_) { return ''; }
    }
    var _seq = 0;   // guards against out-of-order responses (fast typing)
    function applySearch(value) {
        var params;
        try { params = new URLSearchParams(window.location.search); }
        catch (_) { params = new URLSearchParams(); }
        var v = (value || '').trim();
        if (v) params.set('search', v); else params.delete('search');
        params.delete('page');   // a new search always starts at page 1
        var qs = params.toString();
        var url = window.location.pathname + (qs ? '?' + qs : '');

        // DYNAMIC: fetch the filtered page and swap ONLY the table + pagination
        // in place — no full reload, so the search box keeps focus and there's
        // no flash. Falls back to a normal navigation if anything looks off
        // (e.g. the session expired and the server returned the login page).
        var mySeq = ++_seq;
        var wrap = document.querySelector('.data-table-wrap');
        if (wrap) wrap.style.opacity = '0.45';
        fetch(url, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
            .then(function (r) {
                if (!r.ok) throw new Error('bad status');
                return r.text();
            })
            .then(function (html) {
                if (mySeq !== _seq) return;   // a newer keystroke already fired
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var newTable = doc.querySelector('.data-table-wrap');
                var newPager = doc.querySelector('.pagination-bar');
                var curTable = document.querySelector('.data-table-wrap');
                if (!newTable || !curTable) { window.location.href = url; return; }
                curTable.replaceWith(newTable);
                var curPager = document.querySelector('.pagination-bar');
                if (newPager && curPager) curPager.replaceWith(newPager);
                else if (curPager && !newPager) curPager.remove();
                if (window.history && window.history.replaceState) window.history.replaceState(null, '', url);
            })
            .catch(function () { window.location.href = url; })
            .then(function () {
                var w = document.querySelector('.data-table-wrap');
                if (w) w.style.opacity = '';
            });
    }
    function injectCss() {
        if (document.getElementById('tbl-search-css')) return;
        var st = document.createElement('style');
        st.id = 'tbl-search-css';
        st.textContent =
            '.toolbar-search{display:inline-flex;align-items:center;position:relative}' +
            '.toolbar-search i{position:absolute;left:10px;color:#9ca3af;font-size:12px;pointer-events:none}' +
            '.toolbar-search input{min-width:200px;max-width:280px;padding-left:28px;font-size:13px}' +
            '@media(max-width:575px){.toolbar-search{width:100%}.toolbar-search input{max-width:none;width:100%}}';
        document.head.appendChild(st);
    }
    function enhance(toolbar) {
        if (toolbar.querySelector('[data-table-search]')) return;   // already added
        injectCss();
        var wrap = document.createElement('div');
        wrap.className = 'toolbar-search';
        var icon = document.createElement('i');
        icon.className = 'fa-solid fa-magnifying-glass';
        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'form-control form-control-sm';
        input.placeholder = 'Search…';
        input.setAttribute('data-table-search', '');
        input.setAttribute('aria-label', 'Search this list');
        input.value = currentSearch();
        wrap.appendChild(icon);
        wrap.appendChild(input);
        toolbar.appendChild(wrap);   // flex space-between → sits on the right

        var t = null;
        input.addEventListener('input', function () {
            clearTimeout(t);
            t = setTimeout(function () { applySearch(input.value); }, 300);
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { clearTimeout(t); applySearch(input.value); }
        });
        // After a search reload, keep the caret at the end so typing continues.
        if (input.value) {
            input.focus();
            var val = input.value; input.value = ''; input.value = val;
        }
    }
    document.addEventListener('DOMContentLoaded', function () {
        var bars = document.querySelectorAll('.table-toolbar');
        for (var i = 0; i < bars.length; i++) enhance(bars[i]);
    });
})();
