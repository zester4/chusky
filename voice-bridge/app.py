"""Chusky's server-side Sendblue FaceTime media bridge.

This service accepts an already-authorized call handoff from Chusky, joins the
short-lived Agora room supplied by Sendblue, streams 16 kHz PCM to Deepgram,
and speaks Chusky's response back into the room. It intentionally stores no
audio, Agora token, transcript, or caller phone number.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from websockets.asyncio.client import connect

LOG = logging.getLogger("chusky.voice_bridge")
logging.basicConfig(level=os.getenv("VOICE_BRIDGE_LOG_LEVEL", "INFO"))
load_dotenv(Path(__file__).with_name(".env"))
SAMPLE_RATE = 16_000
CHANNELS = 1
BYTES_PER_MS = SAMPLE_RATE * CHANNELS * 2 // 1000
PCM_CHUNK_BYTES = BYTES_PER_MS * 20


@dataclass(frozen=True)
class Settings:
    bridge_secret: str
    deepgram_api_key: str
    chusky_turn_url: str
    chusky_status_url: str
    max_call_seconds: int
    max_active_calls: int

    @classmethod
    def from_env(cls) -> "Settings":
        secret = os.getenv("FACETIME_MEDIA_BRIDGE_SECRET", "").strip()
        deepgram = os.getenv("DEEPGRAM_API_KEY", "").strip()
        turn_url = os.getenv("CHUSKY_VOICE_TURN_URL", "http://127.0.0.1:3003/internal/facetime/turn").strip()
        status_url = os.getenv("CHUSKY_VOICE_STATUS_URL", "http://127.0.0.1:3003/internal/facetime/status").strip()
        if not secret or not deepgram or not turn_url.startswith(("http://", "https://")) or not status_url.startswith(("http://", "https://")):
            raise RuntimeError("FACETIME_MEDIA_BRIDGE_SECRET, DEEPGRAM_API_KEY, CHUSKY_VOICE_TURN_URL, and CHUSKY_VOICE_STATUS_URL are required")
        return cls(secret, deepgram, turn_url, status_url, max(60, min(int(os.getenv("VOICE_BRIDGE_MAX_CALL_SECONDS", "7200")), 14_400)), max(1, min(int(os.getenv("VOICE_BRIDGE_MAX_ACTIVE_CALLS", "4")), 20)))


class AgoraCredentials(BaseModel):
    appId: str = Field(min_length=1, max_length=300)
    channelName: str = Field(min_length=1, max_length=300)
    token: str = Field(min_length=1, max_length=4000)
    uid: int = Field(ge=0)


class StartCall(BaseModel):
    callId: str = Field(pattern=r"^ftc_[0-9a-fA-F-]{36}$")
    userId: int = Field(gt=0)
    phoneNumber: str = Field(pattern=r"^\+[1-9]\d{7,14}$")
    purpose: str = Field(min_length=1, max_length=1000)
    agora: AgoraCredentials


class CallerAudioObserver:  # Base class is added dynamically after Agora imports.
    pass


def load_agora_observer(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[bytes]):
    """Load the optional native SDK only when a live call starts."""
    from agora.rtc.audio_frame_observer import IAudioFrameObserver  # type: ignore[import-not-found]

    class Observer(IAudioFrameObserver):
        def _enqueue(self, audio: bytes) -> None:
            def put() -> None:
                if not queue.full():
                    queue.put_nowait(audio)
            loop.call_soon_threadsafe(put)

        def on_record_audio_frame(self, *_args: Any) -> int:
            return 0

        def on_playback_audio_frame(self, *_args: Any) -> int:
            return 0

        def on_ear_monitoring_audio_frame(self, *_args: Any) -> int:
            return 0

        def on_playback_audio_frame_before_mixing(self, _local_user: Any, _channel_id: str, _uid: str, frame: Any, *_args: Any) -> int:
            # Agora is configured below to provide exactly 16 kHz mono 16-bit PCM.
            if frame.samples_per_sec == SAMPLE_RATE and frame.channels == CHANNELS and frame.bytes_per_sample == 2 and frame.buffer:
                self._enqueue(bytes(frame.buffer))
            return 1

        def on_get_audio_frame_position(self, *_args: Any) -> int:
            return 0

    return Observer()


class VoiceCall:
    def __init__(self, request: StartCall, settings: Settings) -> None:
        self.request = request
        self.settings = settings
        self.session_id = f"vbr_{uuid.uuid4()}"
        self.stop = asyncio.Event()
        self.audio: asyncio.Queue[bytes] = asyncio.Queue(maxsize=500)  # bounded: roughly ten seconds.
        self.connection: Any | None = None
        self.service: Any | None = None

    async def run(self) -> None:
        try:
            self._connect_agora()
            await self._notify_status("active")
            await asyncio.wait_for(self._run_transcription(), timeout=self.settings.max_call_seconds)
            await self._notify_status("ended")
        except asyncio.TimeoutError:
            LOG.info("Voice call reached maximum duration", extra={"call_id": self.request.callId})
            await self._notify_status("ended")
        except Exception:
            LOG.exception("Voice call ended with an error", extra={"call_id": self.request.callId})
            await self._notify_status("failed", "media bridge connection or processing failed")
        finally:
            self.stop.set()
            self._release_agora()

    def _connect_agora(self) -> None:
        # Exact configuration follows Agora's Python Server SDK PCM receive/send example.
        from agora.rtc.agora_service import AgoraService, AgoraServiceConfig  # type: ignore[import-not-found]
        from agora.rtc.agora_base import (  # type: ignore[import-not-found]
            AudioProfileType, AudioPublishType, AudioScenarioType, AudioSubscriptionOptions,
            RTCConnConfig, RtcConnectionPublishConfig, VideoPublishType,
        )

        loop = asyncio.get_running_loop()
        service = AgoraService()
        result = service.initialize(AgoraServiceConfig(
            appid=self.request.agora.appId,
            enable_audio_processor=1,
            enable_audio_device=0,
            enable_video=0,
        ))
        if result != 0:
            raise RuntimeError(f"Agora service initialization failed ({result})")
        connection = service.create_rtc_connection(
            RTCConnConfig(
                auto_subscribe_audio=1,
                auto_subscribe_video=0,
                audio_recv_media_packet=0,
                audio_subs_options=AudioSubscriptionOptions(packet_only=0, pcm_data_only=1, bytes_per_sample=2, number_of_channels=1, sample_rate_hz=SAMPLE_RATE),
            ),
            RtcConnectionPublishConfig(
                audio_profile=AudioProfileType.AUDIO_PROFILE_DEFAULT,
                audio_scenario=AudioScenarioType.AUDIO_SCENARIO_AI_SERVER,
                is_publish_audio=True,
                is_publish_video=False,
                audio_publish_type=AudioPublishType.AUDIO_PUBLISH_TYPE_PCM,
                video_publish_type=VideoPublishType.VIDEO_PUBLISH_TYPE_NONE,
            ),
        )
        if connection is None:
            service.release()
            raise RuntimeError("Agora connection could not be created")
        if connection.connect(self.request.agora.token, self.request.agora.channelName, str(self.request.agora.uid)) != 0:
            connection.release()
            service.release()
            raise RuntimeError("Agora channel connection failed")
        local_user = connection.get_local_user()
        # Must be configured before registering the frame observer.
        local_user.set_playback_audio_frame_before_mixing_parameters(CHANNELS, SAMPLE_RATE)
        if connection.register_audio_frame_observer(load_agora_observer(loop, self.audio), 0, None) != 0:
            connection.disconnect()
            connection.release()
            service.release()
            raise RuntimeError("Agora audio observer registration failed")
        if connection.publish_audio() != 0:
            connection.disconnect()
            connection.release()
            service.release()
            raise RuntimeError("Agora audio publish failed")
        self.connection, self.service = connection, service

    async def _run_transcription(self) -> None:
        query = "model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&interim_results=false&endpointing=300"
        url = f"wss://api.deepgram.com/v1/listen?{query}"
        async with connect(url, additional_headers={"Authorization": f"Token {self.settings.deepgram_api_key}"}, max_size=1_000_000) as socket:
            sender = asyncio.create_task(self._send_audio(socket))
            receiver = asyncio.create_task(self._receive_transcripts(socket))
            stopper = asyncio.create_task(self.stop.wait())
            done, pending = await asyncio.wait({sender, receiver, stopper}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()

    async def _send_audio(self, socket: Any) -> None:
        while not self.stop.is_set():
            audio = await self.audio.get()
            await socket.send(audio)

    async def _receive_transcripts(self, socket: Any) -> None:
        final_parts: list[str] = []
        async for raw in socket:
            if not isinstance(raw, str):
                continue
            event = json.loads(raw)
            if event.get("type") != "Results":
                continue
            transcript = str((((event.get("channel") or {}).get("alternatives") or [{}])[0]).get("transcript") or "").strip()
            if transcript and event.get("is_final"):
                final_parts.append(transcript)
            if event.get("speech_final") and final_parts:
                text = " ".join(final_parts).strip()
                final_parts.clear()
                if text:
                    await self._respond(text)

    async def _respond(self, transcript: str) -> None:
        # The bridge has no agent, memory, or tool credentials. Chusky owns all of that.
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
            response = await client.post(self.settings.chusky_turn_url, headers={"Authorization": f"Bearer {self.settings.bridge_secret}"}, json={"callId": self.request.callId, "userId": self.request.userId, "transcript": transcript})
            response.raise_for_status()
            text = str(response.json().get("text") or "").strip()
        if text:
            await self._speak(text[:5000])

    async def _notify_status(self, status: str, error: str | None = None) -> None:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
                response = await client.post(self.settings.chusky_status_url, headers={"Authorization": f"Bearer {self.settings.bridge_secret}"}, json={"callId": self.request.callId, "userId": self.request.userId, "status": status, **({"error": error} if error else {})})
                response.raise_for_status()
        except Exception:
            # The bridge must still clean up its Agora resources if Chusky is restarting.
            LOG.warning("Could not report call status", extra={"call_id": self.request.callId, "status": status})

    async def _speak(self, text: str) -> None:
        url = "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000"
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
            response = await client.post(url, headers={"Authorization": f"Token {self.settings.deepgram_api_key}", "Content-Type": "application/json"}, json={"text": text})
            response.raise_for_status()
            audio = response.content
        # Agora requires a whole-number duration in milliseconds. Linear16 at 16 kHz is 32 bytes/ms.
        remainder = len(audio) % BYTES_PER_MS
        if remainder:
            audio += b"\x00" * (BYTES_PER_MS - remainder)
        for offset in range(0, len(audio), PCM_CHUNK_BYTES):
            if self.stop.is_set() or self.connection is None:
                return
            while not self.stop.is_set() and not self.connection.is_push_to_rtc_completed():
                await asyncio.sleep(0.01)
            if self.stop.is_set():
                return
            chunk = memoryview(audio[offset:offset + PCM_CHUNK_BYTES])
            if self.connection.push_audio_pcm_data(chunk, SAMPLE_RATE, CHANNELS) != 0:
                raise RuntimeError("Agora rejected synthesized PCM audio")
            await asyncio.sleep(len(chunk) / (SAMPLE_RATE * CHANNELS * 2))

    def _release_agora(self) -> None:
        if self.connection is not None:
            try:
                self.connection.disconnect()
                self.connection.release()
            except Exception:
                LOG.exception("Agora connection cleanup failed", extra={"call_id": self.request.callId})
            self.connection = None
        if self.service is not None:
            try:
                self.service.release()
            except Exception:
                LOG.exception("Agora service cleanup failed", extra={"call_id": self.request.callId})
            self.service = None


class CallManager:
    def __init__(self) -> None:
        self.calls: dict[str, VoiceCall] = {}
        self.lock = asyncio.Lock()

    async def start(self, request: StartCall, settings: Settings) -> VoiceCall:
        async with self.lock:
            existing = self.calls.get(request.callId)
            if existing:
                return existing
            if len(self.calls) >= settings.max_active_calls:
                raise RuntimeError("voice bridge call capacity reached")
            call = VoiceCall(request, settings)
            self.calls[request.callId] = call
            task = asyncio.create_task(call.run(), name=f"facetime-{request.callId}")
            task.add_done_callback(lambda _task: self.calls.pop(request.callId, None))
            return call


app = FastAPI(title="Chusky FaceTime Media Bridge", docs_url=None, redoc_url=None)
calls = CallManager()


def authenticate(authorization: str | None, settings: Settings) -> None:
    expected = f"Bearer {settings.bridge_secret}"
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/calls", status_code=202)
async def start_call(request: StartCall, authorization: str | None = Header(default=None)) -> dict[str, str]:
    try:
        settings = Settings.from_env()
    except RuntimeError as error:
        LOG.error("Voice bridge is not configured: %s", error)
        raise HTTPException(status_code=503, detail="voice bridge is not configured") from error
    authenticate(authorization, settings)
    try:
        call = await calls.start(request, settings)
    except RuntimeError as error:
        raise HTTPException(status_code=429, detail="voice bridge call capacity reached") from error
    return {"status": "accepted", "sessionId": call.session_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("VOICE_BRIDGE_HOST", "127.0.0.1"),
        port=int(os.getenv("VOICE_BRIDGE_PORT", "3004")),
        proxy_headers=True,
    )
