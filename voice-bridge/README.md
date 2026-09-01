# Chusky FaceTime media bridge

This service is the private media participant for outbound Sendblue FaceTime
calls. Chusky starts the call and gives it short-lived Agora credentials. The
bridge joins that Agora room, receives 16 kHz PCM audio, sends final speech to
Chusky's authenticated internal agent endpoint, synthesizes the response with
Deepgram, and publishes PCM audio back to the call.

It is deliberately a separate process from Chusky. It never persists audio,
Agora credentials, phone numbers, or transcripts.

## Required environment

```ini
FACETIME_MEDIA_BRIDGE_SECRET=<same random secret configured in Chusky>
DEEPGRAM_API_KEY=<Deepgram server API key>
CHUSKY_VOICE_TURN_URL=http://127.0.0.1:3003/internal/facetime/turn
CHUSKY_VOICE_STATUS_URL=http://127.0.0.1:3003/internal/facetime/status
VOICE_BRIDGE_HOST=127.0.0.1
VOICE_BRIDGE_PORT=3004
VOICE_BRIDGE_MAX_ACTIVE_CALLS=4
```

## Oracle installation

```bash
cd ~/chusky/voice-bridge
cp .env.example .env
# Edit .env: set the same FACETIME_MEDIA_BRIDGE_SECRET as Chusky and a Deepgram key.
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
pm2 start ecosystem.config.cjs
pm2 save
curl -i http://127.0.0.1:3004/health
```

The Nginx virtual host for `voice.selithub.shop` must proxy `/` to
`http://127.0.0.1:3004`; it should not expose port 3004 publicly.

## Safety boundary

`POST /calls` requires `Authorization: Bearer <FACETIME_MEDIA_BRIDGE_SECRET>`.
The bridge can call only `/internal/facetime/turn` with the same secret. That
Chusky endpoint validates the call ID and owner, uses the owner's existing
memory, limits tools to read-only calls, and stores only text turns in Chusky's
normal history.
