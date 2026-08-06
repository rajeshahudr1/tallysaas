"""Tests for server-published Tally envelopes.

This is the highest-consequence code in the agent. Fetching queries from the
server is what lets a new report ship without a new exe; it also means the
server can tell every installed agent what XML to send to a customer's Tally,
and Tally's XML API writes as well as reads.

Three controls keep that from being a remote command channel, and each gets its
own tests:

  1. the signature (a compromised server cannot mint envelopes),
  2. the read-only check (holds even if the signing key leaks),
  3. the cache fallback (a bad or missing response never becomes a bad query).

Cross-checked against the Node signer so the two implementations cannot drift —
if they ever disagree, every agent in the field stops accepting envelopes.

Run: python -m unittest discover -s agent/tests
"""

import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import envelope_store as store  # noqa: E402

SECRET = "test-signing-secret"
READ_XML = ("<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Collection</TYPE><ID>Ledger</ID></HEADER></ENVELOPE>")


def sign(payload, secret=SECRET):
    mac = hmac.new(secret.encode(), store.canonical(payload).encode(), hashlib.sha256)
    return base64.b64encode(mac.digest()).decode()


def doc(xml=READ_XML, secret=SECRET, **extra):
    payload = {"id": "set-1", "envelopes": {"ledger": {"xml": xml}}, **extra}
    return {**payload, "alg": store.ALG, "version": store.SIG_VERSION,
            "signature": sign(payload, secret)}


# ── Signature ────────────────────────────────────────────────────
class SignatureTests(unittest.TestCase):

    def test_a_correctly_signed_set_is_accepted(self):
        payload = store.validate_set(doc(), SECRET)
        self.assertIn("ledger", payload["envelopes"])

    def test_a_set_signed_with_another_secret_is_refused(self):
        with self.assertRaises(store.EnvelopeError):
            store.validate_set(doc(secret="wrong-secret"), SECRET)

    def test_tampering_after_signing_is_caught(self):
        d = doc()
        d["envelopes"]["ledger"]["xml"] = READ_XML.replace("Ledger", "Voucher")
        with self.assertRaises(store.EnvelopeError):
            store.validate_set(d, SECRET)

    def test_an_unsigned_set_is_refused(self):
        d = doc(); del d["signature"]
        with self.assertRaises(store.EnvelopeError):
            store.validate_set(d, SECRET)

    def test_an_attacker_chosen_algorithm_is_refused(self):
        # The JWT alg:none hole.
        d = doc(); d["alg"] = "none"
        with self.assertRaises(store.EnvelopeError):
            store.validate_set(d, SECRET)

    def test_an_empty_set_is_refused(self):
        payload = {"id": "s", "envelopes": {}}
        d = {**payload, "alg": store.ALG, "signature": sign(payload)}
        with self.assertRaises(store.EnvelopeError):
            store.validate_set(d, SECRET)


class CrossImplementationTests(unittest.TestCase):
    """The Node signer and this verifier must agree byte for byte."""

    def test_a_signature_made_by_the_node_signer_verifies_here(self):
        api = os.path.join(os.path.dirname(os.path.dirname(
            os.path.dirname(os.path.abspath(__file__)))), "api")
        script = (
            "const es=require('./Helpers/envelopeSigning');"
            "const p={id:'set-1',envelopes:{ledger:{xml:process.argv[1]}}};"
            "process.stdout.write(es.sign(p,process.argv[2]).signature);"
        )
        try:
            out = subprocess.run([("node"), "-e", script, READ_XML, SECRET],
                                 cwd=api, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            self.skipTest("node unavailable")
        if out.returncode != 0:
            self.skipTest("node signer unavailable: " + out.stderr[:200])
        payload = {"id": "set-1", "envelopes": {"ledger": {"xml": READ_XML}}}
        self.assertTrue(
            store.verify_signature(payload, out.stdout.strip(), SECRET),
            "Python and Node disagree — every agent would reject every envelope")


# ── Read-only enforcement ────────────────────────────────────────
class ReadOnlyTests(unittest.TestCase):

    def test_an_export_envelope_is_read_only(self):
        self.assertTrue(store.is_read_only(READ_XML))

    def test_writing_envelopes_are_rejected(self):
        for xml in (
            "<ENVELOPE><HEADER><TALLYREQUEST>Import</TALLYREQUEST></HEADER></ENVELOPE>",
            '<ENVELOPE><VOUCHER ACTION="Delete"/></ENVELOPE>',
            '<ENVELOPE><LEDGER ACTION="Alter"/></ENVELOPE>',
            '<ENVELOPE><COLLECTION ISMODIFY="Yes"/></ENVELOPE>',
            "<ENVELOPE><BODY><IMPORTDATA/></BODY></ENVELOPE>",
        ):
            self.assertFalse(store.is_read_only(xml), xml)

    def test_the_check_is_case_insensitive(self):
        self.assertFalse(store.is_read_only('<envelope><voucher action="delete"/></envelope>'))

    def test_a_PERFECTLY_SIGNED_writing_envelope_is_still_refused(self):
        # THE test for this module. If the signing key ever leaks, this is the
        # control that still stands between a compromised server and a
        # customer's books.
        with self.assertRaises(store.EnvelopeError) as ctx:
            store.validate_set(doc(xml='<ENVELOPE><VOUCHER ACTION="Delete"/></ENVELOPE>'), SECRET)
        self.assertIn("can modify Tally", str(ctx.exception))

    def test_an_empty_envelope_is_not_treated_as_harmless(self):
        self.assertFalse(store.is_read_only(""))


# ── Cache + fallback ─────────────────────────────────────────────
class CacheTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "envelopes.json")
        self.store = store.EnvelopeStore(self.path, SECRET)

    def test_accepting_a_set_caches_it_and_it_reloads(self):
        self.store.accept(doc())
        fresh = store.EnvelopeStore(self.path, SECRET)
        self.assertIn(READ_XML, fresh.xml("ledger"))

    def test_a_rejected_download_does_not_overwrite_a_good_cache(self):
        # Otherwise one bad response permanently breaks the agent.
        self.store.accept(doc())
        with self.assertRaises(store.EnvelopeError):
            self.store.accept(doc(secret="wrong"))
        fresh = store.EnvelopeStore(self.path, SECRET)
        self.assertIn(READ_XML, fresh.xml("ledger"))

    def test_a_cache_edited_on_disk_is_refused(self):
        # Local tampering must not be easier than attacking the server.
        self.store.accept(doc())
        with open(self.path, encoding="utf-8") as fh:
            d = json.load(fh)
        d["envelopes"]["ledger"]["xml"] = '<ENVELOPE><VOUCHER ACTION="Delete"/></ENVELOPE>'
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(d, fh)
        self.assertIsNone(store.EnvelopeStore(self.path, SECRET).load_cached())

    def test_a_corrupt_cache_file_is_ignored_not_fatal(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.assertIsNone(self.store.load_cached())

    def test_refresh_falls_back_to_the_cache_when_the_server_is_down(self):
        self.store.accept(doc())

        def down():
            raise RuntimeError("connection refused")

        payload = self.store.refresh(down)
        self.assertIn("ledger", payload["envelopes"])

    def test_refresh_falls_back_rather_than_accepting_a_BAD_signature(self):
        # A compromised server must not be able to replace good queries.
        self.store.accept(doc())
        payload = self.store.refresh(lambda: doc(secret="attacker"))
        self.assertEqual(payload["envelopes"]["ledger"]["xml"], READ_XML)

    def test_refresh_falls_back_rather_than_accepting_a_WRITING_envelope(self):
        self.store.accept(doc())
        evil = doc(xml='<ENVELOPE><VOUCHER ACTION="Delete"/></ENVELOPE>')
        payload = self.store.refresh(lambda: evil)
        self.assertEqual(payload["envelopes"]["ledger"]["xml"], READ_XML)

    def test_with_no_cache_and_no_server_it_fails_loudly(self):
        # Silently syncing nothing would look like "nothing changed".
        def down():
            raise RuntimeError("offline")

        with self.assertRaises(store.EnvelopeError):
            self.store.refresh(down)

    def test_a_fresh_set_replaces_the_cached_one(self):
        self.store.accept(doc())
        newer = ("<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST>"
                 "<TYPE>Collection</TYPE><ID>StockItem</ID></HEADER></ENVELOPE>")
        self.store.refresh(lambda: doc(xml=newer))
        self.assertIn("StockItem", store.EnvelopeStore(self.path, SECRET).xml("ledger"))

    def test_asking_for_an_unknown_envelope_is_an_error(self):
        self.store.accept(doc())
        with self.assertRaises(store.EnvelopeError):
            self.store.xml("no-such-report")

    def test_names_lists_what_is_available(self):
        self.store.accept(doc())
        self.assertEqual(self.store.names(), ["ledger"])


if __name__ == "__main__":
    unittest.main()
