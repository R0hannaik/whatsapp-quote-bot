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
1. Create an Ubuntu 24.04 server (India region — click-by-click for DigitalOcean Bangalore: **DIGITALOCEAN.md**). Add your SSH key while creating it.
2. In your domain's DNS settings, add an **A record**: `quotes` → *your server's IP address*.
   (Any domain works: `quotes.yourcompany.in`, `bot.example.com`, …)

**Shortcut:** steps 2 and 3 in one command (asks for the domain, generates a password, starts everything):
```bash
curl -fsSL https://raw.githubusercontent.com/R0hannaik/whatsapp-quote-bot/main/scripts/install-server.sh | sudo bash
```
Free servers that work for this (DigitalOcean credit, Oracle Always Free, Google e2-micro): see SHARING.md → *D*.

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

### How the data is protected (and why this way)

| Option | Protects against | Weak spots | Used here? |
|---|---|---|---|
| **Local backups on the server** | Mistakes, bad edits, a damaged database file | Lost together with the server (deleted, hacked, disk failure) | ✅ Daily, each one verified + checksummed |
| **Manual download** (Settings → Download) | Losing the server | Depends on you remembering; unencrypted copies end up on laptops/Drive | Optional extra |
| **Provider server snapshots** | Losing the whole server | Same provider and account; usually daily/weekly only; contains secrets unencrypted | Optional extra |
| **Automatic Google Drive upload** | Losing the server | The server would hold a login that can read/delete your *whole* Drive; anyone who gets in can wipe the backups; no immutability | ❌ |
| **Encrypted off-site copy to S3-compatible storage** | Losing the server, a hacked server, ransomware, the storage provider reading your data | Needs a one-time bucket setup; **you must keep the passphrase safe** | ✅ **Hourly — recommended** |
| Continuous replication (e.g. Litestream) | Even the last hour's changes | Extra moving part to run and monitor; more to go wrong | ❌ Not needed at this size |
| Managed cloud database (PostgreSQL) | Server loss, with live failover | Rewriting the app's storage; network dependency; higher cost and more ways in; still needs backups | ❌ Overkill for one bot |

What the chosen setup gives you:
- **Integrity:** the database writes every change to disk before confirming it (`synchronous=FULL`); every backup is
  integrity-checked and checksummed (SHA-256) before it is kept; the live database is health-checked daily; a damaged or
  altered backup is refused at restore time.
- **Confidentiality:** each off-site copy is compressed and encrypted **on your server** with AES-256-GCM before upload,
  using a key derived from your passphrase (scrypt). The storage provider only ever sees unreadable bytes.
- **Can't be wiped:** the server's storage key can upload and read but **not delete**; with versioning + Object Lock on the
  bucket, even a hacked server can't destroy old backups.
- **Proven restorable:** a restore drill runs automatically every week (and on demand) — download → decrypt → verify.
- **At most 1 hour of data at risk** (hourly uploads), plus the daily local backup.
- **Data stays in India** if you use an India region (e.g. AWS Mumbai `ap-south-1`) — sensible given that buyers' phone
  numbers are personal data under India's DPDP Act.

### Off-site backups — one-time setup (AWS S3, Mumbai)

1. **Create the bucket** — AWS console → S3 → *Create bucket*
   - Name: e.g. `yourcompany-quotebot-backups` · Region: **Asia Pacific (Mumbai) ap-south-1**
   - **Block all public access: ON** (default)
   - **Bucket Versioning: Enable**
   - *Advanced settings* → **Object Lock: Enable** → after creating, open *Properties → Object Lock → Edit*:
     default retention **Governance, 30 days**
   - Default encryption: SSE-S3 (default) is fine — our own encryption is on top of it
2. **Keep costs tiny** — *Management → Create lifecycle rule*: expire current versions after **90 days** and permanently
   delete noncurrent versions after **30 days**. (A year of hourly backups of this database costs very little.)
3. **Create a restricted access key** — IAM → *Users → Create user* `quotebot-backup` (no console access) →
   *Add permissions → Create inline policy → JSON*:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
         "Resource": "arn:aws:s3:::yourcompany-quotebot-backups/quotebot/*" },
       { "Effect": "Allow", "Action": "s3:ListBucket",
         "Resource": "arn:aws:s3:::yourcompany-quotebot-backups",
         "Condition": { "StringLike": { "s3:prefix": "quotebot/*" } } }
     ]
   }
   ```
   No delete, no retention changes — exactly what the bot needs and nothing more. Then *Security credentials → Create access key*.
4. **Make a passphrase** on your computer: `openssl rand -base64 32`.
   Save it in a password manager **and** on paper in a safe place. Without it, the off-site backups cannot be opened —
   by anyone, including you.
5. **Add to `.env`** on the server, then `docker compose up -d`:
   ```dotenv
   BACKUP_S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com
   BACKUP_S3_REGION=ap-south-1
   BACKUP_S3_BUCKET=yourcompany-quotebot-backups
   BACKUP_S3_ACCESS_KEY_ID=AKIA…
   BACKUP_S3_SECRET_ACCESS_KEY=…
   BACKUP_ENCRYPTION_PASSPHRASE=…the passphrase from step 4…
   ```
6. **Check it works** — Settings → Database backups → **Upload now**, then **Run restore drill**. Both should go green.

*Other providers* work the same way (any S3-compatible storage): Cloudflare R2 (`https://<account>.r2.cloudflarestorage.com`,
region `auto`, use *Bucket locks*), Backblaze B2 (`https://s3.<region>.backblazeb2.com`, enable *Object Lock*). Give the key
read + write but not delete. Prefer an India region where offered.

If the off-site upload keeps failing for 6 hours, the dashboard shows a warning at the top.

### Restoring a backup
```bash
cd /opt/quotebot
docker compose stop app
# the newest encrypted off-site backup (works on a brand-new server too):
docker compose run --rm --no-deps app node scripts/restore.js --cloud latest
#   (see all of them first:  docker compose run --rm --no-deps app node scripts/restore.js --cloud list)
# a backup that is already on the server:
docker compose run --rm --no-deps app node scripts/restore.js data/backups/quotebot-2026-11-08_0300.db
# …or one you downloaded earlier — copy it in first:
#   docker compose cp ./quotebot-2026-11-08_0300.db app:/app/data/backups/
docker compose start app
```
The script decrypts and checks the backup (wrong passphrase, damaged or altered files are refused), refuses to run while
the app is running, and keeps the current database as `quotebot.before-restore-<time>.db` so a restore can be undone.

### Moving to a new server (or recovering from a lost one)
Install on the new server (steps 1–3) with the same `.env` (including the `BACKUP_*` lines), then
`docker compose run --rm --no-deps app node scripts/restore.js --cloud latest`, start, and scan the WhatsApp QR.
Unlink the old device on the phone if it still shows.

---

## Security checklist
- [ ] Strong `DASHBOARD_PASSWORD` (change it any time in *Settings → Security*)
- [ ] `.env` is `chmod 600`; never commit it to GitHub
- [ ] Firewall allows only 22, 80, 443; SSH with keys, not passwords
- [ ] Only HTTPS — Caddy redirects HTTP to HTTPS automatically
- [ ] Off-site encrypted backups set up, restore drill green, passphrase stored in two safe places
- [ ] Bot runs on a **separate WhatsApp number** (see README → Important notes)

## Troubleshooting
| Problem | Fix |
|---|---|
| Browser says the site can't be reached | Check the DNS A record points at the server and ports 80/443 are open. `docker compose logs caddy` |
| Certificate error right after setup | Wait a minute — Caddy is getting the certificate. DNS must already point at the server. |
| Dashboard says WhatsApp not linked after a restart | Normal only after a restore/move — scan the QR again. Otherwise check `docker compose logs app`. |
| `docker compose ps` shows `unhealthy` | `docker compose logs app` — usually a missing `DASHBOARD_PASSWORD` in `.env` on the first start. |
