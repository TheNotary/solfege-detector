import sys
sys.path.append('../solfege_detector')
from unittest import TestCase

from solfege_detector.sayer import Sayer


class TestApp(TestCase):
    def test_my_number_is_what_i_think_it_will_be(self):
        expected_output = "Hi"
        sayer = Sayer()
        actual_output = sayer.say_hi()

        self.assertEqual(actual_output, expected_output)
        self.assertTrue(isinstance(actual_output, str))
