import asyncio
import base64
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

import app as voice_app


class FakeTwilioWebSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, message):
        self.sent.append(json.loads(message))

    async def receive_text(self):
        await asyncio.Event().wait()


class EmptyDeepgramSocket:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class DeepgramConnectionContext:
    def __init__(self, socket):
        self.socket = socket

    async def __aenter__(self):
        return self.socket

    async def __aexit__(self, *_args):
        return False


class FakeTtsSocket:
    def __init__(self):
        self.items = [
            b"\xff" * 160,  # 20 ms, raw μ-law at 8 kHz.
            json.dumps({"type": "SpeechMetadata"}),
        ]
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.items:
            raise StopAsyncIteration
        return self.items.pop(0)

    async def close(self):
        self.closed = True


class StreamingFakeTtsSocket:
    def __init__(self):
        self.sent = []
        self.items = asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.items.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def send(self, message):
        event = json.loads(message)
        self.sent.append(event)
        if event.get("type") == "Speak":
            await self.items.put(b"\xff" * 160)
        elif event.get("type") == "Flush":
            await self.items.put(json.dumps({"type": "SpeechMetadata"}))

    async def close(self):
        await self.items.put(None)


class StreamingFakeElevenLabsSocket:
    def __init__(self):
        self.sent = []
        self.items = asyncio.Queue()
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.items.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def send(self, message):
        event = json.loads(message)
        self.sent.append(event)
        if event.get("text", "").strip():
            await self.items.put(json.dumps({
                "audio": base64.b64encode(b"\xff" * 160).decode(),
                "is_final": False,
            }))
        if event.get("flush") is True:
            await self.items.put(json.dumps({"is_final": True}))

    async def close(self):
        self.closed = True
        await self.items.put(None)


class FakeAgentStreamResponse:
    def __init__(self):
        self.lines = [
            json.dumps({"type": "delta", "text": "I can help you with that."}),
            json.dumps({"type": "done", "text": "I can help you with that.", "cost": 0.01}),
        ]

    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        for line in self.lines:
            await asyncio.sleep(0)
            yield line


class ToolWaitAgentStreamResponse:
    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        yield json.dumps({"type": "tool_start", "toolSlug": "CHUCK_ORDER_TRACK", "text": "Let me quickly check that for you."})
        await asyncio.sleep(0.6)
        yield json.dumps({"type": "done", "text": "", "cost": 0.01})


class TerminalOnlyAgentStreamResponse:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        yield json.dumps({"type": "done", "text": self.text, "cost": 0.01})


class HangingAgentStreamResponse:
    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        await asyncio.Event().wait()
        yield "never reached"


class FakeAgentStreamContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, *_args):
        return False


class FakeAgentHttp:
    def __init__(self):
        self.stream_requests = []
        self.posts = []

    def stream(self, method, url, **kwargs):
        self.stream_requests.append({"method": method, "url": url, **kwargs})
        return FakeAgentStreamContext(FakeAgentStreamResponse())

    async def post(self, url, **kwargs):
        self.posts.append({"url": url, **kwargs})

        class Response:
            def raise_for_status(self):
                return None

        return Response()

    async def aclose(self):
        return None


class CommitRetryHttp:
    def __init__(self, failures: int):
        self.failures = failures
        self.attempts = 0

    async def post(self, _url, **_kwargs):
        self.attempts += 1

        class Response:
            def __init__(self, fail):
                self.fail = fail

            def raise_for_status(self):
                if self.fail:
                    raise RuntimeError("temporary commit failure")

        return Response(self.attempts <= self.failures)

    async def aclose(self):
        return None


class DeepgramTurnSocket:
    def __init__(self, events):
        self.events = events

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.events:
            raise StopAsyncIteration
        return json.dumps(self.events.pop(0))


class TwilioAudioWiringTests(unittest.IsolatedAsyncioTestCase):
    def test_bridge_settings_use_twilio_only_internal_routes(self):
        with patch.dict(voice_app.os.environ, {
            "TWILIO_MEDIA_BRIDGE_SECRET": "twilio-bridge-test-secret",
            "DEEPGRAM_API_KEY": "deepgram-test-key",
            "CHUSKY_VOICE_TURN_URL": "https://chusky.example/internal/twilio/turn",
            "CHUSKY_VOICE_STATUS_URL": "https://chusky.example/internal/twilio/status",
        }, clear=True):
            settings = voice_app.Settings.from_env()
        self.assertEqual(settings.bridge_secret, "twilio-bridge-test-secret")
        self.assertEqual(settings.chusky_turn_url, "https://chusky.example/internal/twilio/turn")
        self.assertEqual(settings.chusky_status_url, "https://chusky.example/internal/twilio/status")
        self.assertFalse(settings.elevenlabs_enabled)
        self.assertEqual(settings.turn_start_budget_ms, 2500)
        self.assertEqual(settings.tts_expressivity, 0)
        self.assertEqual(settings.tts_speed, 1.05)
        self.assertEqual(settings.deepgram_tts_api_host, "api.deepgram.com")
        self.assertEqual(settings.stt_keyterms, [])
        self.assertFalse(settings.stt_adaptive_endpointing)

        with patch.dict(voice_app.os.environ, {
            "TWILIO_MEDIA_BRIDGE_SECRET": "twilio-bridge-test-secret",
            "DEEPGRAM_API_KEY": "deepgram-test-key",
            "CHUSKY_VOICE_TURN_URL": "https://chusky.example/internal/twilio/turn",
            "CHUSKY_VOICE_STATUS_URL": "https://chusky.example/internal/twilio/status",
            "VOICE_TURN_START_BUDGET_MS": "2500",
        }, clear=True):
            guarded_settings = voice_app.Settings.from_env()
        self.assertEqual(guarded_settings.turn_start_budget_ms, 2500)

        with patch.dict(voice_app.os.environ, {
            "TWILIO_MEDIA_BRIDGE_SECRET": "twilio-bridge-test-secret",
            "DEEPGRAM_API_KEY": "deepgram-test-key",
            "CHUSKY_VOICE_TURN_URL": "https://chusky.example/internal/twilio/turn",
            "CHUSKY_VOICE_STATUS_URL": "https://chusky.example/internal/twilio/status",
            "VOICE_TTS_EXPRESSIVITY": "+1",
            "VOICE_TTS_SPEED": "1.10",
            "VOICE_STT_KEYTERMS": "United Cars, Treffley, United Cars",
            "VOICE_STT_ADAPTIVE_ENDPOINTING": "true",
            "DEEPGRAM_TTS_API_HOST": "api.eu.deepgram.com",
        }, clear=True):
            expressive_settings = voice_app.Settings.from_env()
        self.assertEqual(expressive_settings.tts_expressivity, 1)
        self.assertEqual(expressive_settings.tts_speed, 1.1)
        self.assertEqual(expressive_settings.stt_keyterms, ["United Cars", "Treffley"])
        self.assertTrue(expressive_settings.stt_adaptive_endpointing)
        self.assertEqual(expressive_settings.deepgram_tts_api_host, "api.eu.deepgram.com")

    def test_elevenlabs_requires_credentials_only_when_enabled(self):
        base = {
            "TWILIO_MEDIA_BRIDGE_SECRET": "twilio-bridge-test-secret",
            "DEEPGRAM_API_KEY": "deepgram-test-key",
            "CHUSKY_VOICE_TURN_URL": "https://chusky.example/internal/twilio/turn",
            "CHUSKY_VOICE_STATUS_URL": "https://chusky.example/internal/twilio/status",
            "VOICE_ELEVENLABS_ENABLED": "true",
        }
        with patch.dict(voice_app.os.environ, base, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ELEVENLABS_API_KEY"):
                voice_app.Settings.from_env()
        with patch.dict(voice_app.os.environ, {
            **base,
            "ELEVENLABS_API_KEY": "eleven-test-key",
            "ELEVENLABS_VOICE_ID": "voice_123",
            "ELEVENLABS_MODEL_ID": "eleven_flash_v2_5",
        }, clear=True):
            settings = voice_app.Settings.from_env()
        self.assertTrue(settings.elevenlabs_enabled)
        self.assertEqual(settings.elevenlabs_voice_id, "voice_123")

    async def asyncSetUp(self):
        self.websocket = FakeTwilioWebSocket()
        settings = SimpleNamespace(
            bridge_secret="test-bridge-secret",
            deepgram_api_key="test-deepgram-key",
            chusky_turn_url="http://localhost/internal/twilio/turn",
            chusky_status_url="http://localhost/internal/twilio/status",
            stt_model="flux-general-en",
            stt_eager_eot_threshold=0.45,
            stt_eot_threshold=0.65,
            stt_eot_timeout_ms=800,
            stt_keyterms=[],
            tts_model="flux-haley-en",
            tts_expressivity=1,
            twilio_native_mulaw=True,
            greeting="",
            turn_start_budget_ms=1000,
            turn_fallback_enabled=True,
        )
        self.call = voice_app.TwilioVoiceCall(
            "twc_test",
            1,
            "MZ_test",
            self.websocket,
            settings,
            voice_app.BridgeMetrics(),
        )
        self.addAsyncCleanup(self.call.http.aclose)
        self.addAsyncCleanup(self.call._close_persistent_tts)

    async def test_call_context_controls_the_initial_greeting(self):
        class ContextResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "ok": True,
                    "direction": "outbound",
                    "keyterms": ["United Cars", "Treffley"],
                    "greeting": "Hello, this is Amina calling on behalf of Chusky Labs about your appointment. Is now a good time?",
                }

        class ContextHttp:
            async def get(self, _url, **_kwargs):
                return ContextResponse()

        self.call.settings.chusky_context_url = "http://chusky.example/internal/twilio/context"
        self.call.http = ContextHttp()
        greeting = await self.call._load_call_greeting()
        self.assertIn("calling on behalf of Chusky Labs", greeting)
        self.assertIn("appointment", greeting)
        self.assertEqual(self.call.stt_keyterms, ["United Cars", "Treffley"])

    async def test_context_failure_uses_neutral_identity_opening(self):
        class ContextHttp:
            async def get(self, _url, **_kwargs):
                raise RuntimeError("context unavailable")

        self.call.settings.chusky_context_url = "http://chusky.example/internal/twilio/context"
        self.call.http = ContextHttp()
        greeting = await self.call._load_call_greeting()
        self.assertEqual(greeting, "Hello, this is Chusky calling on behalf of the person or business who asked me to reach you. May I ask who I’m speaking with?")

    async def test_context_failure_uses_signed_persona_fallback(self):
        class ContextHttp:
            async def get(self, _url, **_kwargs):
                raise RuntimeError("context unavailable")

        self.call.fallback_greeting = "Hello, this is Amina, an assistant from United Cars. May I speak with Jordan?"
        self.call.settings.chusky_context_url = "http://chusky.example/internal/twilio/context"
        self.call.http = ContextHttp()
        greeting = await self.call._load_call_greeting()
        self.assertEqual(greeting, self.call.fallback_greeting)

    async def test_twilio_ingress_is_sent_to_flux_without_transcoding(self):
        sent_audio = []
        sent_once = asyncio.Event()

        class CaptureSocket:
            async def send(self, frame):
                sent_audio.append(frame)
                sent_once.set()

        self.call.audio.put_nowait(b"\xff" * 160)
        sender = asyncio.create_task(self.call._send_audio(CaptureSocket()))
        await asyncio.wait_for(sent_once.wait(), 1)
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)

        self.assertEqual(sent_audio, [b"\xff" * 160])

    async def test_flux_stt_connection_declares_native_mulaw(self):
        opened_urls = []

        def fake_connect(url, **_kwargs):
            opened_urls.append(url)
            return DeepgramConnectionContext(EmptyDeepgramSocket())

        with patch.object(voice_app, "connect", fake_connect):
            with self.assertRaises(voice_app.ProviderStreamEnded):
                await self.call._run()

        # The fake provider closes immediately; the bridge should make its
        # bounded reconnect attempts rather than silently ending the call.
        self.assertEqual(len(opened_urls), 3)
        query = parse_qs(urlparse(opened_urls[0]).query)
        self.assertEqual(query["encoding"], ["mulaw"])
        self.assertEqual(query["sample_rate"], ["8000"])

    async def test_flux_tts_native_mulaw_is_forwarded_to_twilio_unchanged(self):
        deepgram_socket = FakeTtsSocket()
        opened_urls = []

        async def fake_connect(url, **_kwargs):
            opened_urls.append(url)
            return deepgram_socket

        self.call.tts_done_event = asyncio.Event()
        self.call.response_started_at = time.monotonic()
        with patch.object(voice_app, "connect", fake_connect):
            await self.call._ensure_persistent_tts()
            await asyncio.wait_for(self.call.tts_done_event.wait(), 1)
            await self.call.tts_reader_task

        query = parse_qs(urlparse(opened_urls[0]).query)
        self.assertEqual(query["encoding"], ["mulaw"])
        self.assertEqual(query["sample_rate"], ["8000"])
        self.assertEqual(query["expressivity"], ["1"])
        media = next(item for item in self.websocket.sent if item.get("event") == "media")
        encoded_payload = media["media"]["payload"]
        self.assertEqual(base64.b64decode(encoded_payload), b"\xff" * 160)

    async def test_tts_resegments_arbitrary_provider_chunks_and_emits_playback_mark(self):
        await self.call._forward_tts_audio(b"\xff" * 100)
        await self.call._forward_tts_audio(b"\x00" * 220)
        await self.call._finish_tts_playback()

        media = [item for item in self.websocket.sent if item.get("event") == "media"]
        self.assertEqual([len(base64.b64decode(item["media"]["payload"])) for item in media], [160, 160])
        self.assertEqual(base64.b64decode(media[0]["media"]["payload"]), b"\xff" * 100 + b"\x00" * 60)
        self.assertEqual(base64.b64decode(media[1]["media"]["payload"]), b"\x00" * 160)
        self.assertEqual([item["event"] for item in self.websocket.sent], ["media", "media", "mark"])
        self.assertEqual(self.call.metrics.tts_audio_frames, 2)
        self.assertEqual(self.call.metrics.playback_marks_sent, 1)
        self.assertEqual(self.call.tts_playback_offset_ms, 40)

    async def test_flux_barge_in_sends_playback_offset_and_clears_twilio_buffer(self):
        tts_socket = StreamingFakeTtsSocket()
        self.call.tts_socket = tts_socket
        self.call.stream_sid = "MZ_test"
        self.call.tts_playback_offset_ms = 640
        self.call.tts_first_audio_recorded = True
        self.call.response_task = asyncio.create_task(asyncio.sleep(10))

        await self.call._barge_in()

        self.assertEqual(
            tts_socket.sent,
            [{"type": "Interrupt", "playback_offset": {"type": "time_ms", "value": 640}}],
        )
        self.assertIn({"event": "clear", "streamSid": "MZ_test"}, self.websocket.sent)
        self.assertTrue(self.call.awaiting_tts_interrupt_context)
        self.call._handle_flux_tts_event({"type": "SpeechInterrupted", "text_spoken": "I was saying"})
        self.assertFalse(self.call.awaiting_tts_interrupt_context)

    async def test_flux_speech_interrupted_event_is_forwarded_with_next_turn(self):
        self.call.awaiting_tts_interrupt_context = True
        self.call._handle_flux_tts_event({"type": "SpeechInterrupted", "text_spoken": "I can offer ten AM."})
        self.assertEqual(self.call.pending_interrupted_speech, "I can offer ten AM.")

        agent_http = FakeAgentHttp()
        self.call.http = agent_http
        tts_socket = StreamingFakeTtsSocket()
        self.call.tts_socket = tts_socket
        self.call.tts_reader_task = asyncio.create_task(self.call._receive_persistent_tts())
        result = await self.call._request_agent_stream("Can we do two PM?")

        self.assertIsNotNone(result)
        self.assertEqual(
            agent_http.stream_requests[0]["json"]["interruptedAssistantSpeech"],
            "I can offer ten AM.",
        )
        self.assertEqual(self.call.pending_interrupted_speech, "")

    async def test_selected_voice_overrides_bridge_default_for_tts_connection(self):
        opened_urls = []

        async def fake_connect(url, **_kwargs):
            opened_urls.append(url)
            return FakeTtsSocket()

        selected = voice_app.TwilioVoiceCall(
            "twc_voice", 1, "MZ_voice", self.websocket, self.call.settings,
            voice_app.BridgeMetrics(), tts_model="flux-hannah-en",
        )
        self.addAsyncCleanup(selected.http.aclose)
        self.addAsyncCleanup(selected._close_persistent_tts)
        with patch.object(voice_app, "connect", fake_connect):
            await selected._ensure_persistent_tts()
            await selected.tts_reader_task

        query = parse_qs(urlparse(opened_urls[0]).query)
        self.assertEqual(query["model"], ["flux-hannah-en"])

    async def test_elevenlabs_streaming_tts_is_opt_in_and_forwards_twilio_mulaw(self):
        elevenlabs_socket = StreamingFakeElevenLabsSocket()
        opened = []
        settings = SimpleNamespace(
            bridge_secret="test-bridge-secret",
            deepgram_api_key="test-deepgram-key",
            chusky_turn_url="http://localhost/internal/twilio/turn",
            chusky_status_url="http://localhost/internal/twilio/status",
            stt_model="flux-general-en",
            stt_eager_eot_threshold=0.45,
            stt_eot_threshold=0.65,
            stt_eot_timeout_ms=800,
            tts_model="flux-haley-en",
            elevenlabs_enabled=True,
            elevenlabs_api_key="eleven-test-key",
            elevenlabs_voice_id="voice_123",
            elevenlabs_model_id="eleven_flash_v2_5",
            twilio_native_mulaw=True,
            greeting="",
            turn_start_budget_ms=1000,
            turn_fallback_enabled=True,
        )
        call = voice_app.TwilioVoiceCall(
            "twc_eleven", 1, "MZ_eleven", self.websocket, settings, voice_app.BridgeMetrics(),
        )
        self.addAsyncCleanup(call.http.aclose)
        self.addAsyncCleanup(call._close_persistent_tts)

        async def fake_connect(url, **kwargs):
            opened.append((url, kwargs))
            return elevenlabs_socket

        call.tts_done_event = asyncio.Event()
        call.response_started_at = time.monotonic()
        with patch.object(voice_app, "connect", fake_connect):
            await call._ensure_persistent_tts()
            await call._send_persistent_tts("Hello there.", flush=True)
            await asyncio.wait_for(call.tts_done_event.wait(), 1)

        self.assertEqual(len(opened), 1)
        self.assertIn("output_format=ulaw_8000", opened[0][0])
        self.assertNotIn("eleven-test-key", opened[0][0])
        self.assertEqual(opened[0][1]["additional_headers"], {"xi-api-key": "eleven-test-key"})
        self.assertEqual(elevenlabs_socket.sent[0]["text"], " ")
        self.assertEqual(elevenlabs_socket.sent[-1]["flush"], True)
        media = next(item for item in self.websocket.sent if item.get("event") == "media")
        self.assertEqual(base64.b64decode(media["media"]["payload"]), b"\xff" * 160)

    async def test_elevenlabs_connection_failure_falls_back_to_flux_for_the_call(self):
        opened_urls = []
        deepgram_socket = FakeTtsSocket()
        settings = SimpleNamespace(
            bridge_secret="test-bridge-secret",
            deepgram_api_key="test-deepgram-key",
            chusky_turn_url="http://localhost/internal/twilio/turn",
            chusky_status_url="http://localhost/internal/twilio/status",
            stt_model="flux-general-en",
            stt_eager_eot_threshold=0.45,
            stt_eot_threshold=0.65,
            stt_eot_timeout_ms=800,
            tts_model="flux-haley-en",
            elevenlabs_enabled=True,
            elevenlabs_api_key="eleven-test-key",
            elevenlabs_voice_id="voice_123",
            elevenlabs_model_id="eleven_flash_v2_5",
            twilio_native_mulaw=True,
            greeting="",
            turn_start_budget_ms=1000,
            turn_fallback_enabled=True,
        )
        call = voice_app.TwilioVoiceCall(
            "twc_fallback", 1, "MZ_fallback", self.websocket, settings, voice_app.BridgeMetrics(),
        )
        self.addAsyncCleanup(call.http.aclose)
        self.addAsyncCleanup(call._close_persistent_tts)

        async def fake_connect(url, **_kwargs):
            opened_urls.append(url)
            if "elevenlabs.io" in url:
                raise OSError("provider unavailable")
            return deepgram_socket

        with patch.object(voice_app, "connect", fake_connect):
            await call._ensure_persistent_tts()
            await call.tts_reader_task

        self.assertTrue(call.elevenlabs_runtime_fallback)
        self.assertIn("elevenlabs.io", opened_urls[0])
        self.assertIn("api.deepgram.com", opened_urls[1])

    async def test_eager_turn_waits_for_one_final_tool_capable_request(self):
        agent_http = FakeAgentHttp()
        self.call.http = agent_http
        tts_socket = StreamingFakeTtsSocket()

        async def fake_connect(_url, **_kwargs):
            return tts_socket

        transcript = "Can you help me with that?"
        deepgram = DeepgramTurnSocket([
            {"type": "TurnInfo", "event": "StartOfTurn", "turn_index": 1, "transcript": ""},
            {"type": "TurnInfo", "event": "EagerEndOfTurn", "turn_index": 1, "transcript": transcript},
            {"type": "TurnInfo", "event": "EndOfTurn", "turn_index": 1, "transcript": transcript},
        ])
        with patch.object(voice_app, "connect", fake_connect):
            await self.call._receive_transcripts(deepgram)
            await asyncio.wait_for(self.call.response_task, 1)

        self.assertEqual(len(agent_http.stream_requests), 1)
        request = agent_http.stream_requests[0]
        self.assertFalse(request["json"]["speculative"])
        self.assertEqual(request["json"]["transcript"], transcript)
        self.assertEqual(len(agent_http.posts), 1)
        self.assertTrue(agent_http.posts[0]["url"].endswith("/commit-turn"))
        self.assertEqual(agent_http.posts[0]["json"]["text"], "I can help you with that.")
        self.assertEqual([event["type"] for event in tts_socket.sent].count("Speak"), 1)
        latency = self.call.metrics.snapshot(1)["twilio"]["latencyMs"]
        self.assertEqual(latency["eagerToFirstAudio"]["count"], 0)
        self.assertEqual(latency["endOfTurnToFirstAudio"]["count"], 1)

    async def test_eager_draft_cannot_speak_or_execute_before_caller_finishes(self):
        self.call._request_agent_stream = AsyncMock()
        await self.call._start_draft("Please book it", 1)
        self.call._request_agent_stream.assert_not_called()
        self.assertIsNone(self.call.draft_task)

    async def test_flux_updates_are_used_when_final_event_has_no_transcript(self):
        agent_http = FakeAgentHttp()
        self.call.http = agent_http
        tts_socket = StreamingFakeTtsSocket()

        async def fake_connect(_url, **_kwargs):
            return tts_socket

        deepgram = DeepgramTurnSocket([
            {"type": "TurnInfo", "event": "StartOfTurn", "turn_index": 3, "transcript": ""},
            {"type": "TurnInfo", "event": "Update", "turn_index": 3, "transcript": "Please book me tomorrow"},
            {"type": "TurnInfo", "event": "EndOfTurn", "turn_index": 3, "transcript": ""},
        ])
        with patch.object(voice_app, "connect", fake_connect):
            await self.call._receive_transcripts(deepgram)
            await asyncio.wait_for(self.call.response_task, 1)

        self.assertEqual(agent_http.stream_requests[0]["json"]["transcript"], "Please book me tomorrow")
        self.assertEqual(agent_http.posts[0]["json"]["turnId"], "turn_1")

    async def test_final_turn_commit_retries_the_exact_payload_without_regenerating_speech(self):
        retrying_http = CommitRetryHttp(failures=2)
        self.call.http = retrying_http
        result = voice_app.VoiceTurnResult(text="I will send the details in Telegram.", cost=0.01)

        await self.call._commit_turn("Please send the details.", result, 7)

        self.assertEqual(retrying_http.attempts, 3)

    async def test_call_outcome_stays_retryable_until_the_server_accepts_it(self):
        retrying_http = CommitRetryHttp(failures=5)
        self.call.http = retrying_http
        self.call.outcome_turns.append({"transcript": "What time works?", "response": "Tomorrow afternoon."})

        with patch.object(voice_app.asyncio, "sleep", new=AsyncMock()):
            await self.call._commit_call_outcome()

        self.assertEqual(retrying_http.attempts, 5)
        self.assertFalse(self.call.outcome_committed)

        retrying_http.failures = 0
        with patch.object(voice_app.asyncio, "sleep", new=AsyncMock()):
            await self.call._commit_call_outcome()
        self.assertTrue(self.call.outcome_committed)
        self.assertEqual(retrying_http.attempts, 6)

    async def test_slow_final_turn_uses_recovery_line_without_committing_it(self):
        class HangingAgentHttp(FakeAgentHttp):
            def stream(self, method, url, **kwargs):
                self.stream_requests.append({"method": method, "url": url, **kwargs})
                return FakeAgentStreamContext(HangingAgentStreamResponse())

        self.call.http = HangingAgentHttp()
        fallback = AsyncMock()
        with patch.object(self.call, "_speak_slow_turn_fallback", fallback):
            result = await self.call._request_agent_stream("Please check that.")

        self.assertIsNone(result)
        fallback.assert_awaited_once()
        self.assertEqual(self.call.metrics.turn_start_budget_exceeded, 1)

    async def test_audio_deadline_does_not_cancel_a_dispatched_tool(self):
        self.call.settings.turn_start_budget_ms = 10
        async def tool_turn(*_args, **_kwargs):
            self.call.agent_tool_started = True
            await asyncio.sleep(0.03)
            return voice_app.VoiceTurnResult(text="The booking is complete.", cost=0)
        fallback = AsyncMock()
        with patch.object(self.call, "_consume_agent_stream", tool_turn), patch.object(self.call, "_speak_slow_turn_fallback", fallback):
            result = await self.call._request_agent_stream("Please book it.")
        self.assertEqual(result.text, "The booking is complete.")
        fallback.assert_not_awaited()

    async def test_terminal_done_text_is_spoken_when_no_deltas_arrive(self):
        class TerminalOnlyAgentHttp(FakeAgentHttp):
            def stream(self, method, url, **kwargs):
                self.stream_requests.append({"method": method, "url": url, **kwargs})
                return FakeAgentStreamContext(TerminalOnlyAgentStreamResponse("The answer arrived in the terminal event."))

        self.call.http = TerminalOnlyAgentHttp()
        tts_socket = StreamingFakeTtsSocket()

        async def fake_connect(_url, **_kwargs):
            return tts_socket

        with patch.object(voice_app, "connect", fake_connect):
            result = await self.call._request_agent_stream("Can you answer that?")

        self.assertIsNotNone(result)
        self.assertEqual(result.text, "The answer arrived in the terminal event.")
        self.assertEqual([event["text"] for event in tts_socket.sent if event.get("type") == "Speak"], ["The answer arrived in the terminal event."])

    async def test_empty_agent_response_uses_audible_recovery_line(self):
        class EmptyAgentHttp(FakeAgentHttp):
            def stream(self, method, url, **kwargs):
                self.stream_requests.append({"method": method, "url": url, **kwargs})
                return FakeAgentStreamContext(TerminalOnlyAgentStreamResponse(""))

        self.call.http = EmptyAgentHttp()
        self.call.settings.turn_fallback_enabled = False
        fallback = AsyncMock()
        with patch.object(self.call, "_speak_slow_turn_fallback", fallback):
            await self.call._respond_final("Please answer me.", 3)

        fallback.assert_awaited_once()
        self.assertEqual(self.call.metrics.empty_agent_responses, 1)

    async def test_tool_activity_speaks_immediately_and_emits_one_bounded_waiting_update(self):
        class ToolWaitAgentHttp(FakeAgentHttp):
            def stream(self, method, url, **kwargs):
                self.stream_requests.append({"method": method, "url": url, **kwargs})
                return FakeAgentStreamContext(ToolWaitAgentStreamResponse())

        agent_http = ToolWaitAgentHttp()
        self.call.http = agent_http
        self.call.settings.tool_progress_delay_ms = 500
        tts_socket = StreamingFakeTtsSocket()

        async def fake_connect(_url, **_kwargs):
            return tts_socket

        with patch.object(voice_app, "connect", fake_connect):
            result = await self.call._request_agent_stream("Please check that.")

        self.assertIsNotNone(result)
        speaks = [event["text"] for event in tts_socket.sent if event.get("type") == "Speak"]
        self.assertEqual(speaks, ["Let me quickly check that for you.", "I’m still working on that, thanks for your patience."])


if __name__ == "__main__":
    unittest.main()
