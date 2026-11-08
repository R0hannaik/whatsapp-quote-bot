# Deploying Quote Bot on the web

This puts the dashboard on your own web address (e.g. `https://quotes.yourcompany.in`) with HTTPS,
running 24×7 so the bot keeps replying when your laptop is closed.

## What the bot needs from a server

| Need | Why |
|---|---|
| **Always on** (no "sleeping") | The WhatsApp connection must stay open to see messages. |
| **A disk that survives restarts** | The database, backups and WhatsApp login are files in `data/`. |
| **Exactly one copy running** | Two copies would fight over the same WhatsApp login. |
| **About 1 GB RAM** | The app normally uses 150–300 MB. |

**Won't work:** Vercel, Netlify, Cloudflare Workers/Pages, AWS Lambda or any "serverless" host, and free tiers that
sleep when idle or wipe the disk on restart.

**Good choices:**
- **A small VPS (recommended)** in an India region (Mumbai / Bangalore / Hyderabad) — e.g. DigitalOcean, AWS Lightsail,
  Google Cloud, Azure, Oracle Cloud, Hostinger, E2E Networks. Ubuntu 24.04, 1 vCPU, 1–2 GB RAM, 25 GB disk.
  Follow **Option A** below.
- **A managed app platform** with a persistent disk/volume (e.g. Railway, Render, Fly.io) — see **Option B**.

---

## Option A — VPS with Docker (recommended)

### 1. Get a server and a web address
1. Create an Ubuntu 24.04 server (India region). Add your SSH key while creating it.
2. In your domain's DNS settings, add an **A record**: `quotes` → *your server's IP address*.
   (Any domain works: `quotes.yourcompany.in`, `bot.example.com`, …)

### 2. Prepare the server (one time)
```bash
ssh root@YOUR_SERVER_IP

# Install Docker
curl -fsSL https://get.docker.com | sh

# Firewall: only SSH and web traffic
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Automatic security updates
apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades
```

### 3. Install the bot
```bash
git clone https://github.com/R0hannaik/whatsapp-quote-bot.git /opt/quotebot
cd /opt/quotebot
cp .env.example .env
nano .env          # set DOMAIN, DASHBOARD_PASSWORD, CONTACT_PHONE (see below)
chmod 600 .env
docker compose up -d --build
```

Minimum `.env` for a server:
```dotenv
DOMAIN=quotes.yourcompany.in
DASHBOARD_PASSWORD=a-long-strong-password
CONTACT_PHONE=+91 98xxx xxxxx
WA_DEVICE_NAME=Quote Bot
```
(`HOST`, `PORT`, `TRUST_PROXY` and `DATA_DIR` are set by `docker-compose.yml` — leave them out.)

### 4. Open it and link WhatsApp
1. Visit `https://quotes.yourcompany.in` — the HTTPS certificate is created automatically on the first visit
   (can take up to a minute).
2. Log in → click **Link WhatsApp** → scan the QR from the bot's phone (*Settings → Linked devices*).
3. **Sync Live Groups**, switch ON the groups, done.

If you were already running the bot on your laptop, **unlink it there first** — only one copy may be linked.

### Everyday commands (run in `/opt/quotebot`)
| Task | Command |
|---|---|
| See what the bot is doing | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Update to the latest version | `git pull && docker compose up -d --build` |
| Stop / start | `docker compose stop` / `docker compose start` |
| Status | `docker compose ps` (should say `healthy`) |

Updates keep all your data — it lives in the `quotebot_data` Docker volume, not in the code folder.

---

## Option B — Managed platform (Railway, Render, Fly.io …)

1. Create a new service from the GitHub repo (it builds the included `Dockerfile`).
2. Add a **persistent volume/disk mounted at `/app/data`**.
3. Set **1 instance** (no autoscaling) and make sure the service never sleeps.
4. Environment variables: `DASHBOARD_PASSWORD`, `CONTACT_PHONE`, `TRUST_PROXY=1` (the platform provides HTTPS).
   The platform's `PORT` is picked up automatically.
5. Health check path: `/healthz`.
6. Open the platform's URL (or attach your domain), log in, link WhatsApp.

---

## The database

### How it's stored
Everything — chemicals and rates, templates, groups, orders & decisions, settings and the password hash — is in
**one SQLite file**, `data/quotebot.db`. The WhatsApp login is kept separately in `data/wa-auth/`.

SQLite is the right fit here: there's only ever one bot process (one WhatsApp login), it handles many thousands of
enquiries a day comfortably, needs no separate database server, and it runs in WAL mode so the dashboard and the bot
can read and write at the same time. A separate database server (PostgreSQL, MySQL) would only make sense if you
later ran several bots or branches sharing one database.

The `data` folder is private to the app (owner-only permissions) and is never exposed on the web.

### Backups
- **Automatic:** every day at 3 AM India time, the last 14 kept. Change both in **Settings → Database backups**.
- **Manual:** **Settings → Database backups → Back up now**.
- **Off-server copy (important):** backups on the server don't help if the server itself is lost. Once a week,
  click **Download** on the latest backup and keep it in Google Drive or on your laptop.
  Or copy them all from your computer:
  ```bash
  scp -r root@YOUR_SERVER_IP:/var/lib/docker/volumes/quotebot_quotebot_data/_data/backups ./quotebot-backups
  ```
- Most VPS providers also offer weekly whole-server snapshots for a small fee — worth turning on.

Backups are made with SQLite's online backup, so they are consistent even while the bot is working.
They don't include the WhatsApp login (on purpose — it's a secret); after a restore you just scan the QR again.

### Restoring a backup
```bash
cd /opt/quotebot
docker compose stop app
# a backup that is already on the server:
docker compose run --rm --no-deps app node scripts/restore.js data/backups/quotebot-2026-11-08_0300.db
# …or one you downloaded earlier — copy it in first:
#   docker compose cp ./quotebot-2026-11-08_0300.db app:/app/data/backups/
docker compose start app
```
The script checks the file is a valid Quote Bot backup, refuses to run while the app is running, and keeps the
current database as `quotebot.before-restore-<time>.db` so a restore can be undone.

### Moving to a new server
On the old server: **Back up now** → **Download**. On the new server: install (steps 1–3), restore that backup,
start, and scan the WhatsApp QR. Unlink the old server's device on the phone.

---

## Security checklist
- [ ] Strong `DASHBOARD_PASSWORD` (change it any time in *Settings → Security*)
- [ ] `.env` is `chmod 600`; never commit it to GitHub
- [ ] Firewall allows only 22, 80, 443; SSH with keys, not passwords
- [ ] Only HTTPS — Caddy redirects HTTP to HTTPS automatically
- [ ] Weekly off-server backup download
- [ ] Bot runs on a **separate WhatsApp number** (see README → Important notes)

## Troubleshooting
| Problem | Fix |
|---|---|
| Browser says the site can't be reached | Check the DNS A record points at the server and ports 80/443 are open. `docker compose logs caddy` |
| Certificate error right after setup | Wait a minute — Caddy is getting the certificate. DNS must already point at the server. |
| Dashboard says WhatsApp not linked after a restart | Normal only after a restore/move — scan the QR again. Otherwise check `docker compose logs app`. |
| `docker compose ps` shows `unhealthy` | `docker compose logs app` — usually a missing `DASHBOARD_PASSWORD` in `.env` on the first start. |
