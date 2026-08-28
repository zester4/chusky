# Chusky on Google Cloud Run

This guide deploys the existing Chusky Docker service to Google Cloud Run. Cloud Run provides the public HTTPS endpoint, runs the repository `Dockerfile`, and supplies the container `PORT`. Redis remains the durable store and QStash/Upstash calls the public workflow endpoints.

## Final architecture

```text
Telegram / local CLI / Composio / QStash
                 |
       Cloud Run HTTPS service URL
                 |
          Chusky container
              PORT=8080
                 |
        External Redis / Upstash
```

Cloud Run is not an Oracle VM. Do not use Nginx, port `3003`, PM2, or Telegram polling here. Deploy Chusky in webhook mode.

## Important rules

- Use `WEBHOOK_URL=https://...`, never HTTP.
- Use the Cloud Run HTTPS URL or a mapped custom HTTPS domain.
- Do not set `PORT=3003`; Cloud Run normally supplies `8080`.
- Do not run `npm run dev` in Cloud Run.
- Do not commit `.env` or provider keys.
- Configure Redis before using production history, memory, approvals, reminders, or jobs.
- Multiple Cloud Run instances require Redis locks and event deduplication, which Chusky uses.

## 1. Prepare Google Cloud

Install the Google Cloud CLI, authenticate, and choose the project:

```bash
gcloud auth login
gcloud projects list
gcloud config set project YOUR_GCP_PROJECT_ID
gcloud config set run/region europe-west2
```

Enable required APIs:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

Choose a region close to your users and Redis.

## 2. Pull and validate the repository

```bash
git clone https://github.com/zester4/chusky.git
cd chusky
git pull --ff-only origin main
git log -1 --oneline
npm install
npm run typecheck
npm test
npm run build
```

The repository should contain `Dockerfile`, `package.json`, `src/`, and `tests/`.

## 3. Store secrets safely

Use Google Secret Manager instead of passing real values directly in shell commands. Create these secrets in the Google Cloud Console or through a secure CI secret store:

```text
TELEGRAM_BOT_TOKEN
OPENROUTER_API_KEY
COMPOSIO_API_KEY
REDIS_URL
QSTASH_TOKEN
WEBHOOK_SECRET
COMPOSIO_WEBHOOK_SECRET
```

Attach the **Secret Manager Secret Accessor** role to the Cloud Run runtime service account. `DAYTONA_API_KEY` is optional.

Never print secret values, place them in Git, or put them in shell history.

## 4. First deployment

Cloud Run creates its service URL during deployment, while Chusky needs a non-empty `WEBHOOK_URL` to start its HTTP server. Use a temporary valid HTTPS URL for the first deployment, then replace it immediately with the real Cloud Run URL.

```bash
gcloud run deploy chusky \
  --source . \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 900 \
  --min 1 \
  --max 3 \
  --set-env-vars "NODE_ENV=production,PORT=8080,WEBHOOK_URL=https://example.com,DEFAULT_MODEL=~deepseek/deepseek-v4-flash-latest,VISION_MODEL=openai/gpt-5.6-luna,TRANSCRIPTION_MODEL=openai/gpt-transcribe,IMAGE_MODEL=openai/gpt-image-1,VIDEO_MODEL=bytedance/seedance-2.0-mini" \
  --set-secrets "TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,COMPOSIO_API_KEY=COMPOSIO_API_KEY:latest,REDIS_URL=REDIS_URL:latest,QSTASH_TOKEN=QSTASH_TOKEN:latest,WEBHOOK_SECRET=WEBHOOK_SECRET:latest,COMPOSIO_WEBHOOK_SECRET=COMPOSIO_WEBHOOK_SECRET:latest"
```

The temporary URL must be replaced immediately. Do not leave it in production.

## 5. Set the real Cloud Run URL

```bash
gcloud run services describe chusky \
  --region europe-west2 \
  --format='value(status.url)'
```

The result will look similar to:

```text
https://chusky-abcdefg-ew.a.run.app
```

Update the service:

```bash
gcloud run services update chusky \
  --region europe-west2 \
  --update-env-vars WEBHOOK_URL=https://chusky-abcdefg-ew.a.run.app
```

Chusky registers Telegram at:

```text
https://chusky-abcdefg-ew.a.run.app/webhook
```

Wait for the new revision to become ready before testing Telegram.

## 6. Optional custom domain

You can map a domain such as:

```text
https://chusky.selithub.shop
```

Create the Cloud Run domain mapping and follow the exact DNS records Google provides. Do not guess the DNS target. After the certificate is active:

```bash
gcloud run services update chusky \
  --region europe-west2 \
  --update-env-vars WEBHOOK_URL=https://chusky.selithub.shop
```

Cloud Run manages HTTPS for the mapped domain. Nginx is not required in front of Cloud Run.

## 7. Configure workflows

After the final public URL is known, configure:

```text
VIDEO_WORKFLOW_URL=https://YOUR_PUBLIC_URL/workflows/video
REMINDER_WORKFLOW_URL=https://YOUR_PUBLIC_URL/workflows/reminder
JOB_WORKFLOW_URL=https://YOUR_PUBLIC_URL/workflows/job
```

For example:

```bash
gcloud run services update chusky \
  --region europe-west2 \
  --update-env-vars "VIDEO_WORKFLOW_URL=https://YOUR_PUBLIC_URL/workflows/video,REMINDER_WORKFLOW_URL=https://YOUR_PUBLIC_URL/workflows/reminder,JOB_WORKFLOW_URL=https://YOUR_PUBLIC_URL/workflows/job"
```

Register the Composio webhook at:

```text
https://YOUR_PUBLIC_URL/composio/triggers
```

## 8. Health and logs

Test the public health endpoint:

```bash
curl https://YOUR_PUBLIC_URL/health
```

The repository Dockerfile checks port `8080` and `/health`. Also inspect Cloud Run:

```bash
gcloud run services describe chusky --region europe-west2
gcloud run services logs read chusky --region europe-west2 --limit 100
```

Keep provider keys, Redis URLs, bearer tokens, raw media, and private payloads out of logs.

## 9. Pair the local terminal

In Telegram:

```text
/cli link
```

On Windows:

```powershell
cd C:\Users\mseyy\Downloads\tg-agent
npm.cmd run build
node dist\cli.js auth link --server https://YOUR_PUBLIC_URL --code YOUR_CODE --name my-laptop
node dist\cli.js chat
```

Telegram and CLI use the same Redis-backed history, memories, scratchpad, approvals, reminders, jobs, and Composio session.

## 10. Full verification

Test, in order:

1. `/health` returns success.
2. Telegram text receives a response.
3. Voice is transcribed.
4. Images route to the vision model.
5. Model switching preserves history.
6. CLI pairing and Telegram-to-CLI continuation work.
7. Memory and scratchpad work.
8. A reminder can be created and cancelled.
9. A recurring job can be created and cancelled.
10. Approval denial prevents the external action.
11. A new Cloud Run revision preserves state through Redis.

## 11. Safe updates

```bash
git pull --ff-only origin main
npm install
npm run typecheck
npm test
npm run build
gcloud run deploy chusky \
  --source . \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 900 \
  --min 1 \
  --max 3
```

Keep environment variables and secrets attached in Cloud Run service configuration or deployment automation. Confirm the active revision and `/health` after every release.

## Troubleshooting

### Container fails to start

Check `WEBHOOK_URL` is non-empty and HTTPS, `PORT` is `8080`, and the runtime service account can read Secret Manager values.

### Health check fails

```bash
gcloud run services logs read chusky --region europe-west2 --limit 100
curl -i https://YOUR_PUBLIC_URL/health
```

Check the Telegram token, secret access, and whether Chusky failed before starting its HTTP server.

### CLI pairing returns 404

The service is likely in polling mode or the terminal uses the wrong URL. Ensure the active revision has a real `WEBHOOK_URL` and that `/health` works.

### Telegram does not respond

Confirm the latest revision is ready, `/health` works, and no second polling process owns the same bot token.

### History disappears

Verify the `REDIS_URL` secret is attached to the active revision. Never rely on in-memory mode in Cloud Run.

### Workflows fail

Verify QStash can reach the exact public workflow URLs and that the QStash token is attached to the active revision.

## Production recommendations

- Use Secret Manager for all secrets.
- Keep at least one warm instance when low latency matters.
- Start with a low maximum instance count and watch costs.
- Keep Cloud Run and Redis geographically close.
- Retain the previous revision until health and end-to-end tests pass.
- Configure Cloud Logging alerts for startup, webhook, Redis, provider, and workflow failures.
- Never run polling and webhook mode simultaneously for the same Telegram bot token.
