import unittest

from voice_runtime import AdaptiveTurnPolicy


class AdaptiveTurnPolicyTests(unittest.TestCase):
    def test_waits_for_multiple_clean_turns_before_tuning(self):
        policy = AdaptiveTurnPolicy(
            eager_eot_threshold=0.45,
            eot_threshold=0.65,
            eot_timeout_ms=800,
            enabled=True,
        )

        for index in range(2):
            policy.start(index, float(index))
            self.assertIsNone(policy.complete(index, float(index) + 1.0))

        policy.start(2, 2.0)
        update = policy.complete(2, 3.0)

        self.assertIsNotNone(update)
        assert update is not None
        self.assertLess(update.eager_eot_threshold, 0.45)
        self.assertLess(update.eot_threshold, 0.65)
        self.assertLess(update.eot_timeout_ms, 800)

    def test_resumed_turns_make_the_policy_more_patient(self):
        policy = AdaptiveTurnPolicy(
            eager_eot_threshold=0.45,
            eot_threshold=0.65,
            eot_timeout_ms=800,
            enabled=True,
        )

        for index in range(3):
            policy.start(index, float(index))
            policy.resumed(index)
            if index < 2:
                self.assertIsNone(policy.complete(index, float(index) + 1.0))
        update = policy.complete(2, 3.0)

        self.assertIsNotNone(update)
        assert update is not None
        self.assertGreater(update.eager_eot_threshold, 0.45)
        self.assertGreater(update.eot_threshold, 0.65)
        self.assertGreater(update.eot_timeout_ms, 800)

    def test_disabled_policy_never_changes_configuration(self):
        policy = AdaptiveTurnPolicy(
            eager_eot_threshold=0.45,
            eot_threshold=0.65,
            eot_timeout_ms=800,
            enabled=False,
        )
        for index in range(5):
            policy.start(index, float(index))
            policy.resumed(index)
            self.assertIsNone(policy.complete(index, float(index) + 1.0))
        self.assertEqual(policy.current.eot_timeout_ms, 800)


if __name__ == "__main__":
    unittest.main()
