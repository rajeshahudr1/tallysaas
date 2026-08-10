"""Tests that the quarantine survives the cache-busting nonce.

THE BUG THIS PINS, watched happening live. An AlterID-filtered collection needs
a unique name per fetch, because Tally caches a TDL definition by name for the
session (see _collection_request_xml). So the incremental path sends:

    Collection TSSMTDSCategory75d7c310

while the FULL path — and therefore everything the skip store learned on the
first cycle — is:

    Collection TSSMTDSCategory

Those are different strings, so the quarantine matched nothing from the second
cycle onward. The store said TDSCategory was fatal, the agent agreed, and then
asked for it again anyway under a new name, every incremental cycle, killing
Tally each time. The persistence that was supposed to make this a once-ever
event made it a never-ending one instead:

    18:34:03  Tally request -> Collection TSSMTDSCategory75d7c310
    18:36:03  Read timed out (120s)   <- the error box, again

WHY MATCH NAMES RATHER THAN STRIP HEX. The nonce is bare hex appended with no
separator, and collection names end in hex letters too — PayHead ends in 'd',
VoucherType and AttendanceType in 'e'. Blind stripping would corrupt those into
different keys. Collapsing onto a KNOWN name cannot.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402


class PoisonKeyTests(unittest.TestCase):

    def key(self, label):
        return TallyConnector._poison_key(label)

    def test_the_nonce_collapses_onto_the_plain_name(self):
        """The live failure: the incremental name must key the same as the full."""
        self.assertEqual(
            self.key("Collection TSSMTDSCategory75d7c310 company=ACME"),
            self.key("Collection TSSMTDSCategory company=ACME"))

    def test_a_name_ending_in_hex_letters_is_not_eaten(self):
        """PayHead ends in 'd', VoucherType in 'e'. Neither is a nonce."""
        self.assertEqual(self.key("Collection TSSMPayHead company=ACME"),
                         "Collection TSSMPayHead")
        self.assertEqual(self.key("Collection TSSMVoucherType company=ACME"),
                         "Collection TSSMVoucherType")
        self.assertEqual(self.key("Collection TSSMAttendanceType"),
                         "Collection TSSMAttendanceType")

    def test_two_different_masters_never_collapse_together(self):
        """Quarantining one master must never take an unrelated one with it."""
        self.assertNotEqual(self.key("Collection TSSMTDSCategory1a2b"),
                            self.key("Collection TSSMTCSCategory1a2b"))

    def test_a_poisoned_plain_name_matches_a_nonced_request(self):
        """The end-to-end effect: what cycle 1 learned, cycle 2 honours."""
        import tally_connector as TC

        TC._POISON.clear()
        self.addCleanup(TC._POISON.clear)
        TC._POISON.add("Collection TSSMTDSCategory")

        c = TallyConnector(url="http://localhost:9000")
        self.assertTrue(c._is_poison("Collection TSSMTDSCategory75d7c310 "
                                     "company=ACME"))

    def test_the_delete_detector_shares_the_masters_quarantine(self):
        """The SAME object type, asked under a second name.

        master_ids() (the delete detector) asks for the identical Tally object
        type under "TSSRec<Type>" instead of "TSSM<Type>". A type Tally cannot
        serve kills it down either path, but the quarantine keyed on the NAME
        treated them as unrelated requests — so a company already known to crash
        on TSSMTDSCategory crashed a second time on TSSRecTDSCategory, and the
        store grew a second entry for one broken object type:

            [ "Collection TSSMTDSCategory", "Collection TSSRecTDSCategory", ... ]

        Quarantine is a property of the OBJECT TYPE, not of the name we happened
        to ask under.
        """
        self.assertEqual(self.key("Collection TSSRecTDSCategory company=ACME"),
                         self.key("Collection TSSMTDSCategory company=ACME"))
        # …and with the nonce on top, which is how it really arrives.
        self.assertEqual(self.key("Collection TSSRecTDSCategory75d7c3 company=ACME"),
                         self.key("Collection TSSMTDSCategory company=ACME"))

    def test_an_unknown_collection_is_left_alone(self):
        """No guessing: a name we do not know keeps its exact text."""
        self.assertEqual(self.key("Collection SomethingElse99 company=ACME"),
                         "Collection SomethingElse99")


if __name__ == "__main__":
    unittest.main()
