import unittest
from urllib.parse import parse_qs, urlparse

from audio_formats import (
    AUDIOOP_AVAILABLE,
    DEEPGRAM_INPUT_SAMPLE_RATE,
    DEEPGRAM_OUTPUT_SAMPLE_RATE,
    TWILIO_SAMPLE_RATE,
    deepgram_linear16_to_twilio_mulaw,
    deepgram_flux_listen_url,
    deepgram_flux_speak_url,
    deepgram_nova_listen_url,
    normalize_flux_tts_expressivity,
    normalize_flux_tts_speed,
    normalize_deepgram_tts_host,
    twilio_deepgram_listen_url,
    twilio_deepgram_speak_url,
    twilio_mulaw_to_deepgram_linear16,
)


class TwilioAudioFormatTests(unittest.TestCase):
    @unittest.skipUnless(AUDIOOP_AVAILABLE, "legacy PCM rollback codec is not installed")
    def test_twilio_twenty_ms_frame_becomes_48khz_linear16_without_duration_change(self):
        self.assertEqual(TWILIO_SAMPLE_RATE, 8000)
        self.assertEqual(DEEPGRAM_INPUT_SAMPLE_RATE, 48000)

        # 160 mu-law samples represent 20 ms at Twilio's fixed 8 kHz format.
        pcm, _state = twilio_mulaw_to_deepgram_linear16(b"\xff" * 160)

        # ratecv carries interpolation state between frames; the first frame
        # may omit the initial interpolation edge (at most one 48 kHz sample).
        duration_seconds = len(pcm) / 2 / DEEPGRAM_INPUT_SAMPLE_RATE
        self.assertLess(abs(duration_seconds - 0.020), 0.00011)

    @unittest.skipUnless(AUDIOOP_AVAILABLE, "legacy PCM rollback codec is not installed")
    def test_resampling_state_keeps_adjacent_twilio_frames_contiguous(self):
        state = None
        converted = bytearray()
        for _ in range(50):
            frame, state = twilio_mulaw_to_deepgram_linear16(b"\xff" * 160, state)
            converted.extend(frame)

        duration_seconds = len(converted) / 2 / DEEPGRAM_INPUT_SAMPLE_RATE
        self.assertLess(abs(duration_seconds - 1.0), 0.00011)

    @unittest.skipUnless(AUDIOOP_AVAILABLE, "legacy PCM rollback codec is not installed")
    def test_24khz_linear16_is_converted_back_to_twilio_mu_law(self):
        self.assertEqual(DEEPGRAM_OUTPUT_SAMPLE_RATE, 24000)

        # 480 mono PCM samples at 24 kHz represent 20 ms.
        mulaw, _state = deepgram_linear16_to_twilio_mulaw(b"\x00\x00" * 480)

        self.assertEqual(len(mulaw), 160)

    @unittest.skipUnless(AUDIOOP_AVAILABLE, "legacy PCM rollback codec is not installed")
    def test_rejects_partial_linear16_samples(self):
        with self.assertRaises(ValueError):
            deepgram_linear16_to_twilio_mulaw(b"\x00")

    def test_twilio_flux_listen_contract_uses_native_mulaw_and_turn_detection(self):
        url = twilio_deepgram_listen_url("flux-general-en", 0.45, 0.65, 800, keyterms=["United Cars", "Treffley"])
        query = parse_qs(urlparse(url).query)

        self.assertEqual(urlparse(url).path, "/v2/listen")
        self.assertEqual(query["model"], ["flux-general-en"])
        self.assertEqual(query["encoding"], ["mulaw"])
        self.assertEqual(query["sample_rate"], ["8000"])
        self.assertEqual(query["eager_eot_threshold"], ["0.45"])
        self.assertEqual(query["eot_threshold"], ["0.65"])
        self.assertEqual(query["eot_timeout_ms"], ["800"])
        self.assertEqual(query["keyterm"], ["United Cars", "Treffley"])

        # Recall supplies its own 48 kHz mono PCM directly and keeps a
        # separate Flux contract from Twilio's native μ-law transport.
        recall_url = deepgram_flux_listen_url("flux-general-en", 0.45, 0.65, 800)
        recall_query = parse_qs(urlparse(recall_url).query)
        self.assertEqual(recall_query["encoding"], ["linear16"])
        self.assertEqual(recall_query["sample_rate"], ["48000"])

        recall_confirmed_url = deepgram_flux_listen_url("flux-general-en", None, 0.65, 800)
        recall_confirmed_query = parse_qs(urlparse(recall_confirmed_url).query)
        self.assertNotIn("eager_eot_threshold", recall_confirmed_query)
        self.assertEqual(recall_confirmed_query["eot_timeout_ms"], ["800"])

    def test_multilingual_flux_connection_supports_hints_and_auto_detection(self):
        url = deepgram_flux_listen_url("flux-general-multi", 0.45, 0.65, 800, language_hints=["en", "es"])
        query = parse_qs(urlparse(url).query)
        self.assertEqual(query["model"], ["flux-general-multi"])
        self.assertEqual(query["language_hint"], ["en", "es"])
        auto_url = deepgram_flux_listen_url("flux-general-multi", 0.45, 0.65, 800)
        assert "language_hint" not in parse_qs(urlparse(auto_url).query)

    def test_twilio_flux_speak_contract_uses_native_mulaw(self):
        url = twilio_deepgram_speak_url("flux-haley-en", expressivity=1)
        query = parse_qs(urlparse(url).query)

        self.assertEqual(urlparse(url).path, "/v2/speak")
        self.assertEqual(query["model"], ["flux-haley-en"])
        self.assertEqual(query["encoding"], ["mulaw"])
        self.assertEqual(query["sample_rate"], ["8000"])
        self.assertEqual(query["expressivity"], ["1"])
        self.assertEqual(query["speed"], ["1.05"])
        recall_query = parse_qs(urlparse(deepgram_flux_speak_url("flux-haley-en", expressivity=-1)).query)
        self.assertEqual(recall_query["encoding"], ["linear16"])
        self.assertEqual(recall_query["sample_rate"], ["24000"])
        self.assertEqual(recall_query["expressivity"], ["-1"])

    def test_tts_can_use_a_documented_regional_endpoint(self):
        url = deepgram_flux_speak_url("flux-haley-en", api_host="api.eu.deepgram.com")
        self.assertTrue(url.startswith("wss://api.eu.deepgram.com/v2/speak?"))
        self.assertEqual(normalize_deepgram_tts_host("api.deepgram.com"), "api.deepgram.com")
        with self.assertRaises(ValueError):
            normalize_deepgram_tts_host("https://attacker.example")
        with self.assertRaises(ValueError):
            normalize_deepgram_tts_host("api.us.deepgram.com")

    def test_flux_tts_speed_is_strictly_bounded_and_quantized(self):
        self.assertEqual(normalize_flux_tts_speed("1.05"), 1.05)
        self.assertEqual(normalize_flux_tts_speed(0.5), 0.5)
        self.assertEqual(normalize_flux_tts_speed(1.5), 1.5)
        for value in (0.49, 1.51, 1.01, "fast", True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_flux_tts_speed(value)

    def test_flux_tts_expressivity_is_strictly_bounded(self):
        self.assertEqual(normalize_flux_tts_expressivity("+1"), 1)
        self.assertEqual(normalize_flux_tts_expressivity(0), 0)
        for value in ("-3", "3", "animated", True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_flux_tts_expressivity(value)

    def test_nova_listen_contract_uses_v1_vad_endpointing_and_stable_results(self):
        url = deepgram_nova_listen_url("nova-3", 500, 1000)
        query = parse_qs(urlparse(url).query)

        self.assertEqual(urlparse(url).path, "/v1/listen")
        self.assertEqual(query["model"], ["nova-3"])
        self.assertEqual(query["encoding"], ["linear16"])
        self.assertEqual(query["sample_rate"], ["48000"])
        self.assertEqual(query["channels"], ["1"])
        self.assertEqual(query["interim_results"], ["true"])
        self.assertEqual(query["smart_format"], ["true"])
        self.assertNotIn("punctuate", query)
        self.assertEqual(query["vad_events"], ["true"])
        self.assertEqual(query["endpointing"], ["500"])
        self.assertEqual(query["utterance_end_ms"], ["1000"])

    def test_nova_no_delay_is_explicit_and_smart_format_can_be_disabled(self):
        url = deepgram_nova_listen_url("nova-3", 500, 1000, smart_format=False, no_delay=True)
        query = parse_qs(urlparse(url).query)
        self.assertNotIn("smart_format", query)
        self.assertEqual(query["no_delay"], ["true"])


if __name__ == "__main__":
    unittest.main()
