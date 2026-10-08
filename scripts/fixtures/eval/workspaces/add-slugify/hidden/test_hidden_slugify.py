import unittest

from text_utils import slugify, title_case


class TestHiddenSlugify(unittest.TestCase):
    def test_spec_example(self):
        self.assertEqual(slugify("  Hello, World! 2026 "), "hello-world-2026")

    def test_runs_collapse_and_edges_trimmed(self):
        self.assertEqual(slugify("---a---b---"), "a-b")
        self.assertEqual(slugify("Tabs\tand\nnewlines"), "tabs-and-newlines")
        self.assertEqual(slugify("100% sure"), "100-sure")

    def test_nothing_left(self):
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("___"), "")

    def test_already_a_slug(self):
        self.assertEqual(slugify("already-slugged"), "already-slugged")
        self.assertEqual(slugify("Already-Slugged"), "already-slugged")

    def test_title_case_still_works(self):
        self.assertEqual(title_case("hello big world"), "Hello Big World")


if __name__ == "__main__":
    unittest.main()
