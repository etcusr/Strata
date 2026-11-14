"""Unreachable update feeds stay quiet for background checks and name the host for explicit checks."""
from __future__ import annotations

import unittest

from strata_control import driver_floor, feed as feedmod
from tests.terminal import net_dead


class QuietCallers(unittest.TestCase):
    def test_the_driver_floor_read_is_silent(self):
        for kind in net_dead.KINDS:
            with net_dead.dead_feed(kind) as dead:
                self.assertIsNone(driver_floor.from_feed(dead, "linux-x86_64", seconds=5.0), kind)

    def test_an_explicit_update_check_names_the_host_and_is_the_class_the_quiet_callers_catch(self):
        for kind in net_dead.KINDS:
            with net_dead.dead_feed(kind) as dead:
                with self.assertRaises(feedmod.FeedError) as caught:
                    feedmod.fetch(dead, {"k": b"0" * 32}, timeout=0.6)
                self.assertIsInstance(caught.exception, feedmod.FeedUnreachable, kind)
                self.assertEqual(caught.exception.exit_code, 6)
                self.assertIn("so the update check could not run", str(caught.exception), kind)


if __name__ == "__main__":
    unittest.main()
