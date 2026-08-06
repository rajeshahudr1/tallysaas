"""Tests for Authenticode signing/verification and the self-update gate.

The property under test is the one that matters on a customer machine: an agent
must not install an update it cannot attribute to US.

Why the publisher check exists at all, given the download is already SHA-256
checked: that hash arrives from the SAME server that serves the file, so it
proves the transfer was intact and nothing more. A server with a foothold would
publish a matching hash for a hostile binary and the agent would install it with
SYSTEM privileges. The signature is the one thing the server cannot produce,
because the signing key lives on a token/HSM it has never held.

`verify_publisher` therefore requires BOTH a valid chain AND our CN — "validly
signed" alone only proves somebody bought a certificate.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import codesign  # noqa: E402
import constants  # noqa: E402


class PublisherMatchingTests(unittest.TestCase):
    """verify_publisher composes a chain check with a CN check."""

    def setUp(self):
        self._verify = codesign.verify
        self._subject = codesign.signer_subject

    def tearDown(self):
        codesign.verify = self._verify
        codesign.signer_subject = self._subject

    def _fake(self, valid, subject):
        codesign.verify = lambda p: valid
        codesign.signer_subject = lambda p: subject

    def test_valid_chain_and_matching_cn_is_accepted(self):
        self._fake(True, "CN=Dukansetu Technologies, O=Dukansetu, C=IN")
        self.assertTrue(codesign.verify_publisher("x.exe", "Dukansetu"))

    def test_a_validly_signed_binary_from_someone_else_is_rejected(self):
        # The whole point: an attacker CAN buy a certificate. Only the CN check
        # distinguishes their signed binary from ours.
        self._fake(True, "CN=Some Other Company, O=Some Other Company, C=IN")
        self.assertFalse(codesign.verify_publisher("x.exe", "Dukansetu"))

    def test_right_cn_but_broken_chain_is_rejected(self):
        # A tampered binary keeps its subject bytes but fails the chain, so the
        # CN alone must never be sufficient.
        self._fake(False, "CN=Dukansetu Technologies, O=Dukansetu, C=IN")
        self.assertFalse(codesign.verify_publisher("x.exe", "Dukansetu"))

    def test_cn_matching_is_case_insensitive(self):
        # Certificate renewals routinely re-case the subject.
        self._fake(True, "CN=DUKANSETU TECHNOLOGIES PRIVATE LIMITED")
        self.assertTrue(codesign.verify_publisher("x.exe", "dukansetu"))

    def test_an_empty_expected_cn_never_passes(self):
        # An accidentally-blank PUBLISHER_CN must fail closed, not wave
        # everything through.
        self._fake(True, "CN=Anyone At All")
        self.assertFalse(codesign.verify_publisher("x.exe", ""))


class PinnedThumbprintTests(unittest.TestCase):
    """The route that makes free (self-signed) releases workable.

    A self-signed certificate fails every chain check by definition, so a gate
    built on chain trust would make the agent reject its own updates — a
    "security feature" that is really an outage. Pinning asks the question that
    actually matters: was this signed with OUR key?
    """

    def setUp(self):
        self._thumb = codesign.signer_thumbprint

    def tearDown(self):
        codesign.signer_thumbprint = self._thumb

    def test_a_matching_thumbprint_is_accepted_without_chain_trust(self):
        codesign.signer_thumbprint = lambda p: "AABBCC"
        codesign.verify = lambda p: False          # untrusted chain, as expected
        self.assertTrue(codesign.verify_publisher("x.exe", "", "AABBCC"))

    def test_a_different_thumbprint_is_refused(self):
        codesign.signer_thumbprint = lambda p: "AABBCC"
        self.assertFalse(codesign.verify_publisher("x.exe", "Dukansetu", "DDEEFF"))

    def test_an_unsigned_file_is_refused_when_a_pin_is_set(self):
        codesign.signer_thumbprint = lambda p: ""
        self.assertFalse(codesign.verify_publisher("x.exe", "Dukansetu", "AABBCC"))

    def test_the_pin_tolerates_spacing_and_case(self):
        # Windows shows thumbprints space-separated and in mixed case; an
        # operator will paste one of those forms.
        codesign.signer_thumbprint = lambda p: "AABBCC"
        self.assertTrue(codesign.verify_publisher("x.exe", "", "aa bb cc"))


class RealBinaryTests(unittest.TestCase):
    """Verification against the actual build on this machine."""

    def _exe(self):
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        exe = os.path.join(here, "dist", "TallyCloudSync.exe")
        if not os.path.exists(exe):
            self.skipTest("no built exe present")
        return exe

    def test_the_built_exe_satisfies_its_own_update_gate(self):
        # The end-to-end assertion: a release this machine produced would be
        # ACCEPTED as an update by an agent built from this source. If this ever
        # fails, self-update is broken in the field.
        exe = self._exe()
        if not codesign.signer_thumbprint(exe):
            self.skipTest("build is unsigned")
        self.assertTrue(
            codesign.verify_publisher(exe, constants.PUBLISHER_CN,
                                      constants.PUBLISHER_THUMBPRINT),
            "the built exe would be rejected by its own publisher gate")

    def test_a_missing_file_verifies_false_rather_than_raising(self):
        self.assertFalse(codesign.verify("no-such-file-here.exe"))
        self.assertEqual(codesign.signer_subject("no-such-file-here.exe"), "")
        self.assertEqual(codesign.signer_thumbprint("no-such-file-here.exe"), "")


class ConfigurationTests(unittest.TestCase):

    def test_a_publisher_cn_is_configured(self):
        # With this blank, the self-update gate silently disables itself.
        self.assertTrue(constants.PUBLISHER_CN.strip(),
                        "PUBLISHER_CN is empty — self-update signature checking "
                        "is disabled")

    def test_every_timestamp_url_is_rfc3161_http(self):
        # Timestamping is not optional: without it, signatures stop validating
        # the day the certificate expires, including on installed copies.
        self.assertTrue(codesign.TIMESTAMP_URLS)
        for url in codesign.TIMESTAMP_URLS:
            self.assertTrue(url.startswith("http"), url)

    def test_more_than_one_timestamp_authority_is_configured(self):
        # A TSA being briefly unreachable is common; a single one would produce
        # an un-timestamped signature that looks fine until expiry.
        self.assertGreater(len(codesign.TIMESTAMP_URLS), 1)


if __name__ == "__main__":
    unittest.main()
