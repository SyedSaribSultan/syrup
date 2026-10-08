import unittest

from util import average, clamp


class TestHiddenUtil(unittest.TestCase):
    def test_average_single(self):
        self.assertEqual(average([5]), 5)

    def test_average_floats_and_negatives(self):
        self.assertAlmostEqual(average([1.5, 2.5]), 2.0)
        self.assertAlmostEqual(average([-3, 3, 9]), 3.0)

    def test_clamp_edges(self):
        self.assertEqual(clamp(10, 0, 10), 10)
        self.assertEqual(clamp(0, 0, 10), 0)
        self.assertEqual(clamp(1000, -5, 5), 5)
        self.assertEqual(clamp(-1000, -5, 5), -5)


if __name__ == "__main__":
    unittest.main()
