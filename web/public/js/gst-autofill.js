/* ─────────────────────────────────────────────────────────────
 * public/js/gst-autofill.js
 *
 * Wires a GSTIN input to /gst/verify (the web forwarding route → api's
 * GET /gst/verify) and, on a valid result, fills the paired State select
 * with the GSTIN's own state — a GSTIN's first two digits ARE the state
 * code, so this is just reading what the number already says, not a
 * guess.
 *
 * Any input carrying `data-gst-autofill` is wired automatically. Paired
 * elements are named via data attributes on the SAME input:
 *   data-gst-state    — CSS selector of the State <select>
 *   data-gst-country  — CSS selector of the Country <select> (optional)
 *
 * Rules (kept in one place so every screen behaves identically):
 *   • Valid GSTIN + State empty   → select the matching State (+ Country
 *     India), with a small "auto-filled from GSTIN" note.
 *   • Valid GSTIN + State already set → NEVER silently overwrite. If it
 *     doesn't match the GSTIN's state, show a soft mismatch warning —
 *     the user decides.
 *   • Invalid GSTIN → a clear error on the field; State untouched.
 *   • Empty GSTIN → nothing happens.
 *
 * Runs on blur, and as-you-type once the field reaches 15 characters.
 * ───────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    function msgEl(input) {
        var el = input.parentElement && input.parentElement.querySelector('.gst-autofill-msg');
        if (!el) {
            el = document.createElement('div');
            el.className = 'form-hint gst-autofill-msg';
            input.insertAdjacentElement('afterend', el);
        }
        return el;
    }

    function setMsg(input, text, kind) {
        var el = msgEl(input);
        if (!text) { el.textContent = ''; el.style.display = 'none'; return; }
        el.textContent = text;
        el.style.display = '';
        el.style.color = kind === 'error' ? 'var(--bs-danger,#dc3545)'
            : kind === 'warn' ? 'var(--bs-warning-text-emphasis,#997404)'
            : 'var(--bs-success,#198754)';
    }

    // Select `name` (case-insensitive) in `select` if an option with that
    // value exists. Returns true if it did.
    function selectByName(select, name) {
        if (!select || !name) return false;
        var opts = select.options;
        for (var i = 0; i < opts.length; i++) {
            if (String(opts[i].value).toLowerCase() === String(name).toLowerCase()) {
                select.selectedIndex = i;
                select.dispatchEvent(new Event('change'));
                return true;
            }
        }
        return false;
    }

    // The Country/State cascade (customer form + quick-create modals) loads
    // states asynchronously after Country changes. Poll briefly for the
    // State select to be enabled and populated before trying to select.
    function waitThenSelectState(stateSelect, stateName, onDone) {
        var attempts = 0;
        var iv = setInterval(function () {
            attempts++;
            var ready = stateSelect && !stateSelect.disabled && stateSelect.options.length > 1;
            if (ready || attempts > 30) {
                clearInterval(iv);
                onDone(ready ? selectByName(stateSelect, stateName) : false);
            }
        }, 150);
    }

    function wire(input) {
        var stateSel   = input.getAttribute('data-gst-state');
        var countrySel = input.getAttribute('data-gst-country');
        var stateEl    = stateSel ? document.querySelector(stateSel) : null;
        var countryEl  = countrySel ? document.querySelector(countrySel) : null;

        function handle() {
            var gstin = (input.value || '').trim().toUpperCase();
            input.classList.remove('is-invalid', 'is-valid');
            setMsg(input, '');
            if (!gstin) return;
            if (gstin.length < 15) return; // wait for the field to be complete

            fetch('/gst/verify?gstin=' + encodeURIComponent(gstin))
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    var data = (j && j.ok && j.data) || null;
                    if (!data || !data.valid || !data.decoded) {
                        input.classList.add('is-invalid');
                        setMsg(input, 'Invalid GSTIN — check the length, format or check digit.', 'error');
                        return;
                    }
                    input.classList.add('is-valid');
                    var stateName = data.decoded.stateName;
                    if (!stateName || !stateEl) return;

                    var current = (stateEl.value || '').trim();
                    if (current) {
                        if (current.toLowerCase() !== stateName.toLowerCase()) {
                            setMsg(input, 'This GSTIN belongs to ' + stateName + ', which does not match the selected State (' + current + ').', 'warn');
                        }
                        return; // never silently overwrite an already-filled State
                    }

                    // State is empty — fill it (and Country → India).
                    if (countryEl && countryEl.value !== 'India' && selectByName(countryEl, 'India')) {
                        waitThenSelectState(stateEl, stateName, function (ok) {
                            if (ok) setMsg(input, 'State auto-filled from GSTIN.', 'ok');
                        });
                    } else {
                        waitThenSelectState(stateEl, stateName, function (ok) {
                            if (ok) setMsg(input, 'State auto-filled from GSTIN.', 'ok');
                        });
                    }
                })
                .catch(function () { /* network hiccup — leave the field alone */ });
        }

        input.addEventListener('blur', handle);
        input.addEventListener('input', function () {
            if ((input.value || '').trim().length === 15) handle();
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        var inputs = document.querySelectorAll('[data-gst-autofill]');
        for (var i = 0; i < inputs.length; i++) wire(inputs[i]);
    });
})();
