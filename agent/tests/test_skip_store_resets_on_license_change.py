"""Tests that activating a licence un-does what Educational mode taught us.

THE RISK THIS CLOSES. The quarantine is permanent by design — a request that
kills TallyPrime must not be re-sent after a restart. On a TallyPrime EDU that
is exactly right: TDSCategory, TCSCategory and the payroll masters are absent
there, and asking takes Tally down.

But "absent" is a property of THAT Tally, not of the company. The day the
customer activates a licence, those object types exist and the masters are real
data the cloud should hold — and the agent would go on skipping them, silently,
forever, because a file written weeks earlier said they were fatal. The customer
sees TDS and payroll simply never sync, with nothing in any log to explain it.

WHY NOT DETECT THE EDITION. Because a wrong guess fails in the worse direction.
Deciding "this is Educational, so skip TDS" means a misread on a LICENSED
machine silently drops real data. Nothing here interprets what TallyPrime is;
it only notices WHEN IT CHANGES. Every response carries the product identity in
its header (PRODTYPE + the version quad) — free, already parsed, and no claim
about what any value means. A different Tally is a Tally whose limits we have
not learned yet, so we forget and re-learn.

Run: python -m unittest discover -s agent/tests
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tally_connector as TC  # noqa: E402

EDU = "<ENVELOPE><HEADER><PRODTYPE>5</PRODTYPE><PRODMAJORVER>1</PRODMAJORVER>" \
      "<PRODMAJORREL>7</PRODMAJORREL></HEADER></ENVELOPE>"
LICENSED = "<ENVELOPE><HEADER><PRODTYPE>1</PRODTYPE><PRODMAJORVER>1</PRODMAJORVER>" \
           "<PRODMAJORREL>7</PRODMAJORREL></HEADER></ENVELOPE>"


class SkipStoreResetTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="tel-lic-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, ".tally_skip.json")
        TC._POISON.clear()
        self.addCleanup(TC._POISON.clear)
        TC._POISON_FILE = None
        TC._TALLY_IDENTITY = ""

    def _stored(self):
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_the_same_tally_keeps_what_it_taught_us(self):
        TC.use_skip_store(self.path)
        TC._POISON.add("Collection TSSMTDSCategory")
        TC.note_tally_identity(EDU)
        TC.note_tally_identity(EDU)
        self.assertIn("Collection TSSMTDSCategory", TC._POISON)

    def test_activating_a_licence_forgets_the_educational_limits(self):
        """The whole point: TDS and payroll must start syncing again."""
        TC.use_skip_store(self.path)
        TC.note_tally_identity(EDU)
        TC._POISON.add("Collection TSSMTDSCategory")
        TC._POISON.add("Collection TSSMPayHead")

        TC.note_tally_identity(LICENSED)

        self.assertEqual(TC._POISON, set(),
                         "a licensed Tally is still being denied what Educational "
                         "mode could not serve")

    def test_the_forgetting_is_written_to_disk(self):
        """Otherwise the next process reloads the stale list and we are back."""
        TC.use_skip_store(self.path)
        TC.note_tally_identity(EDU)
        TC._POISON.add("Collection TSSMTDSCategory")
        TC._save_skip_store()
        TC.note_tally_identity(LICENSED)

        stored = self._stored()
        self.assertEqual(stored.get("labels"), [])
        self.assertTrue(stored.get("tally"), "the identity must be recorded too")

    def test_a_store_written_by_an_older_build_still_loads(self):
        """Those are bare lists with no identity. Keep them; adopt the first
        identity we see rather than throwing away a real crash list."""
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(["Collection TSSMTDSCategory"], fh)

        TC.use_skip_store(self.path)
        self.assertIn("Collection TSSMTDSCategory", TC._POISON)
        TC.note_tally_identity(EDU)
        self.assertIn("Collection TSSMTDSCategory", TC._POISON)

    def test_the_first_identity_is_written_down_immediately(self):
        """Otherwise the comparison can never happen across restarts.

        The identity used to reach disk only when a NEW quarantine was recorded.
        On a machine whose store was already complete nothing more is ever
        quarantined — so the file kept no identity, every process adopted
        whatever it saw as "the first one", and activating a licence would be
        compared against nothing and pass unnoticed. The stale TDS and payroll
        skips would then survive the licence forever, which is the single thing
        this whole mechanism exists to prevent.
        """
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(["Collection TSSMTDSCategory"], fh)   # older build's shape

        TC.use_skip_store(self.path)
        TC.note_tally_identity(EDU)

        stored = self._stored()
        self.assertEqual(stored.get("tally"), TC._identity_of(EDU))
        self.assertEqual(stored.get("labels"), ["Collection TSSMTDSCategory"],
                         "adopting an identity must not drop what was learned")

    def test_an_unreadable_header_changes_nothing(self):
        """A response we cannot parse is not evidence that Tally changed."""
        TC.use_skip_store(self.path)
        TC.note_tally_identity(EDU)
        TC._POISON.add("Collection TSSMTDSCategory")
        TC.note_tally_identity("not xml at all")
        TC.note_tally_identity("")
        self.assertIn("Collection TSSMTDSCategory", TC._POISON)


if __name__ == "__main__":
    unittest.main()
