import unittest

from speech_text import normalize_voice_chunk, normalize_voice_delta, normalize_voice_text


class RecallSpeechTextTests(unittest.TestCase):
    def test_preserves_stream_delta_boundaries_until_a_complete_phrase_is_ready(self):
        self.assertEqual(normalize_voice_delta(" clarify"), " clarify")
        self.assertEqual(
            normalize_voice_text("The price is $4.99. plan1.clarify your idea."),
            "The price is 4 dollars and 99 cents. plan 1. clarify your idea.",
        )

    def test_removes_ui_emojis_before_text_reaches_tts(self):
        self.assertEqual(
            normalize_voice_text("⏰ I’m checking your reminders… 🧠 I’m checking what I remember."),
            "I’m checking your reminders… I’m checking what I remember.",
        )

    def test_preserves_space_at_a_stream_chunk_boundary(self):
        self.assertEqual(normalize_voice_chunk("book me"), "book me")
        self.assertEqual(normalize_voice_chunk(" tomorrow"), " tomorrow")
        self.assertEqual(normalize_voice_chunk("tomorrow "), "tomorrow ")


if __name__ == "__main__":
    unittest.main()
