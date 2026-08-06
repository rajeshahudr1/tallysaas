"""Tests for the master registry's COLLECTION TYPES.

Every MasterSpec becomes an inline TDL `COLLECTION ... TYPE: <collection_type>`.
Tally does not merely refuse a type it does not have — on a real customer build
(TallyPrime EDU, a 3,585-ledger company) asking for `TYPE: PriceLevel` hung the
request for six minutes, put up

    Internal Error.  Contact Tally Solutions.
    Incorrect Object Type!

and CLOSED Tally. The agent saw only the socket drop, retried on the next cycle,
and killed Tally again — every 60 seconds, forever. Nothing synced at all,
because fetch_all_masters is early in the pull.

Price levels are not a Tally OBJECT type: they are a list on the company, and
their names already reach the cloud on each stock item's price list (see
tally_connector's price_list parsing). So the collection was both fatal and
redundant.

What is pinned: the registry does not ask Tally for an object type that is not
one. The list below is the narrow, evidence-backed part of that — a type is
added here only after it has been observed to kill or hang a real Tally.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_schema import MASTERS  # noqa: E402


# Object types Tally does NOT define. Asking for one is not a no-op — it can
# take the whole application down (see the module docstring).
NOT_TALLY_OBJECT_TYPES = frozenset({"PriceLevel"})


class MasterRegistryTypeTests(unittest.TestCase):

    def test_no_spec_asks_for_a_non_object_type(self):
        bad = [s.kind for s in MASTERS
               if s.collection_type in NOT_TALLY_OBJECT_TYPES]
        self.assertEqual(bad, [], "these masters ask Tally for a type it does "
                                  "not have, which can crash Tally: " + repr(bad))

    def test_registry_is_not_empty(self):
        """Guard the guard: an empty registry would pass the test above."""
        self.assertGreater(len(MASTERS), 5)

    def test_every_spec_has_a_collection_type(self):
        for spec in MASTERS:
            self.assertTrue(spec.collection_type,
                            "master %r has no collection type" % (spec.kind,))


if __name__ == "__main__":
    unittest.main()
