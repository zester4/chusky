# Chusky on Oracle Cloud with Hostinger DNS

This guide deploys Chusky on an Oracle Compute instance while keeping other applications on the same server. Hostinger manages DNS, Nginx handles public HTTPS traffic, and Chusky listens privately on port `3003`.

## Final architecture

```text
Telegram / terminal / Composio / QStash
                  |
        https://chusky.selithub.shop
                  |
       Hostinger DNS A record
                  |
          Oracle public IPv4
                  |
          Nginx :80 / :443
                  |
       Chusky 127.0.0.1:3003
                  |
              Redis
```

DNS points to an IP address, not a port. Nginx receives public HTTPS traffic on `443` and forwards it internally to Chusky on `3003`. Do not expose port `3003` publicly.

## Prerequisites

- Oracle Compute instance with SSH access.
- Oracle public IPv4 address.
- Hostinger-managed domain.
- Telegram bot token.
- OpenRouter API key.
- Composio API key.
- Redis URL for restart-safe sessions and memory.
- QStash credentials and public workflow URLs for reminders, recurring jobs, or video workflows.

## 1. Configure Hostinger DNS

In Hostinger DNS, create this record:

```text
Type: A
Name: chusky
Target: YOUR_ORACLE_PUBLIC_IP
TTL: 300 or default
```

This creates:

```text
chusky.selithub.shop → YOUR_ORACLE_PUBLIC_IP
```

Verify from Windows:

```powershell
nslookup chusky.selithub.shop
```

The result should contain the Oracle public IP. A resolver timeout followed by the correct IP is normally not a Chusky problem. Remove an incorrect `AAAA` record unless IPv6 is intentionally configured.

## 2. Enter the repository on Oracle

```bash
find /home/ubuntu -maxdepth 3 -name package.json -print
cd /home/ubuntu/chusky
pwd
ls
```

The directory should contain `package.json`, `src`, `tests`, and the Chusky README. Do not run Chusky from another application directory such as `selit-pay` unless it is actually this repository.

## 3. Pull the latest code safely

```bash
git status
git branch --show-current
git remote -v
git pull --ff-only origin main
git log -1 --oneline
```

The expected current commit is:

```text
f71dbb0 Build Chusky CLI and production agent capabilities
```

If source changes exist, do not use `git reset --hard`. Inspect them with `git diff --stat` first. `.env` is ignored and should not appear in Git status.

## 4. Configure Chusky

Run the safe setup wizard:

```bash
npm install
npm run setup
```

Choose `webhook` mode and enter:

```text
https://chusky.selithub.shop
```

The wizard preserves existing values, masks secrets, generates missing webhook secrets, and lets you skip optional integrations.

The essential `.env` values are:

```env
TELEGRAM_BOT_TOKEN=your_telegram_token
OPENROUTER_API_KEY=your_openrouter_key
COMPOSIO_API_KEY=your_composio_key
WEBHOOK_URL=https://chusky.selithub.shop
PORT=3003
WEBHOOK_SECRET=generated_random_value
COMPOSIO_WEBHOOK_SECRET=generated_random_value
REDIS_URL=your_redis_url
```

For durable workflows:

```env
QSTASH_TOKEN=your_qstash_token
VIDEO_WORKFLOW_URL=https://chusky.selithub.shop/workflows/video
REMINDER_WORKFLOW_URL=https://chusky.selithub.shop/workflows/reminder
JOB_WORKFLOW_URL=https://chusky.selithub.shop/workflows/job
```

### Production Better Auth database (Neon Postgres)

Create a Neon project for production and copy its **pooled** PostgreSQL
connection string. Add it on Oracle only—never in Vercel or Git:

```env
BETTER_AUTH_ENABLED=true
BETTER_AUTH_DATABASE_URL=postgresql://<role>:<password>@<endpoint>-pooler.<region>.aws.neon.tech/neondb?sslmode=require
```

Keep `REDIS_URL`: Neon stores Better Auth's relational records, while Redis
continues to hold Chusky's locks, agent state, workflow state, and delivery
outbox. Do not set `BETTER_AUTH_DATABASE` in production; SQLite is local-only.
On startup, Chusky applies Better Auth's built-in migration to the configured
Postgres database. Deploy first to a Neon staging branch, test sign-up,
verification, sign-in, sign-out, and `/api/auth/ok`, then switch the production
Oracle environment to the production branch connection string.

Optional multi-channel adapters (keep these in `.env`, never in Git):

```env
SLACK_ENABLED=false
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=https://chusky.selithub.shop/slack/oauth/callback
WHATSAPP_ENABLED=false
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_GRAPH_VERSION=v23.0
```

Slack Event Subscriptions should target `https://chusky.selithub.shop/slack/events` and
Interactivity should target `https://chusky.selithub.shop/slack/interactions`. In Telegram,
run `/channel link slack`; open the generated installation link to bind the installing Slack
user. WhatsApp Cloud API webhook verification and events both use
`https://chusky.selithub.shop/whatsapp/webhook`; run `/channel link whatsapp` in Telegram and
send the one-time code from the WhatsApp account. The gateway rejects invalid signatures,
isolates unlinked users, deduplicates provider events in Redis, and persists outbound receipts.

Never place real keys in this guide, GitHub, or chat.

Run the configuration report:

```bash
npm run doctor
```

It reports configured and missing settings without printing secret values.

## 5. Confirm port `3003` is available

```bash
sudo ss -ltnp | grep :3003
```

No output means the port is free. If another application owns it, identify that application before choosing another port. Update both `.env` and Nginx if a different port is required.

## 6. Configure Nginx without disturbing other applications

```bash
sudo systemctl status nginx --no-pager
```

Install it only if necessary:

```bash
sudo apt update
sudo apt install -y nginx
```

Create a separate server block:

```bash
sudo nano /etc/nginx/sites-available/chusky
```

Add:

```nginx
server {
    listen 80;
    listen [::]:80;

    server_name chusky.selithub.shop;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Enable and test it:

```bash
sudo ln -s /etc/nginx/sites-available/chusky /etc/nginx/sites-enabled/chusky
sudo nginx -t
sudo systemctl reload nginx
```

If the symbolic link already exists, skip that `ln` command. Do not remove or replace existing Nginx server blocks.

## 7. Allow public HTTP and HTTPS

In Oracle Cloud VCN security rules, allow inbound:

```text
TCP 80
TCP 443
```

If Ubuntu UFW is active:

```bash
sudo ufw status
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3003/tcp
sudo ufw reload
```

## 8. Enable HTTPS

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d chusky.selithub.shop
```

Choose the HTTP-to-HTTPS redirect. Then test:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I https://chusky.selithub.shop
```

## 9. Build and test Chusky

```bash
cd /home/ubuntu/chusky
npm install
npm run typecheck
npm test
npm run build
npm start
```

Keep the first process open. From another SSH session:

```bash
curl https://chusky.selithub.shop/health
```

A successful JSON response confirms DNS, HTTPS, Nginx, Chusky, and the Telegram token are working together.

## 10. Run Chusky permanently

Stop the foreground process with `Ctrl+C`, then use PM2:

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs --only chusky --update-env
pm2 save
pm2 startup
```

Run the extra command printed by `pm2 startup`, then check:

```bash
pm2 status
pm2 logs chusky
```

Rotate PM2 logs so an otherwise healthy VM cannot eventually run out of disk space:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

After future releases:

```bash
cd /home/ubuntu/chusky
bash scripts/deploy-oracle.sh
```

Chusky's PM2 configuration is intentionally in one-worker cluster mode. `pm2 reload`
starts a replacement, waits for Chusky's Redis/Telegram/HTTP/webhook readiness signal, then
lets the old worker drain accepted Telegram updates for up to 30 seconds. Do not use
`pm2 restart chusky`, `pm2 stop chusky`, or `npm start` for routine releases; they create a
window where Telegram cannot reach a healthy worker.

### Migrating an existing PM2 process

If Chusky was originally launched with `pm2 start dist/index.js --name chusky`, run this
once after building the current release. It replaces only Chusky; it does not touch the
other PM2 applications or Nginx.

```bash
cd /home/ubuntu/chusky
pm2 delete chusky
pm2 start ecosystem.config.cjs --only chusky --update-env
pm2 save
```

## 11. Configure Composio and workflows

Register this Composio webhook URL:

```text
https://chusky.selithub.shop/composio/triggers
```

Workflow endpoints:

```text
https://chusky.selithub.shop/workflows/video
https://chusky.selithub.shop/workflows/reminder
https://chusky.selithub.shop/workflows/job
```

Use verified webhook secrets. Workflow handlers re-read durable records before delivery, so a cancelled reminder will not send even if a queued workflow runs later.

## 12. Pair the local terminal

In Telegram:

```text
/cli link
```

On Windows:

```powershell
cd C:\Users\mseyy\Downloads\tg-agent
npm.cmd run build
node dist\cli.js auth link --server https://chusky.selithub.shop --code YOUR_CODE --name my-laptop
node dist\cli.js chat
```

The terminal uses the same Redis-backed history, memory, scratchpad, approvals, reminders, jobs, and Composio session as Telegram.

Manage devices in Telegram:

```text
/cli devices
/cli revoke my-laptop
```

## 13. Verify the complete system

```bash
cd /home/ubuntu/chusky
git status
npm run doctor
curl https://chusky.selithub.shop/health
pm2 status
```

Then test text, voice, image analysis, model switching, terminal continuation, memory, reminder cancellation, approval denial, and restart persistence.

## Troubleshooting

### `502 Bad Gateway`

```bash
sudo ss -ltnp | grep :3003
pm2 logs chusky
curl http://127.0.0.1:3003/health
sudo nginx -t
```

### Telegram webhook fails

Confirm that `WEBHOOK_URL` is exactly `https://chusky.selithub.shop`, the domain resolves to Oracle, HTTPS is valid, Oracle allows port `443`, and only one Chusky instance owns the bot webhook.

### CLI pairing fails

CLI routes require webhook mode. Confirm:

```bash
grep '^WEBHOOK_URL=' .env
curl https://chusky.selithub.shop/health
```

Pairing codes expire after ten minutes and work once only.

### History disappears after restart

Confirm `REDIS_URL` is configured and logs do not show the in-memory fallback:

```bash
grep '^REDIS_URL=' .env
pm2 logs chusky
```

### Existing applications are affected

Inspect Nginx without changing it:

```bash
sudo nginx -T
```

Chusky should have its own `server_name chusky.selithub.shop` block. Do not replace existing Nginx configuration.

## Security rules

- Keep `.env` out of Git; only `.env.example` belongs in the repository.
- Use HTTPS for Telegram, CLI, Composio, and QStash.
- Keep Chusky port `3003` private.
- Keep Redis private and authenticated.
- Never paste provider keys, pairing tokens, or webhook secrets into logs or support messages.
- Use `git pull --ff-only` and avoid destructive production resets.
