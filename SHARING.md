# Sharing the prototype with a client

Two ways: the **demo** (A/B — sample data, simulated WhatsApp, zero risk) or a **trial** (C — the client links their own
WhatsApp and tests the real bot).

The demo is a separate copy with sample chemicals, groups, enquiries, orders and
payments, and a **simulated WhatsApp**: your client types as a buyer in **💬 Demo Chat** and watches the real bot logic
reply. Nothing is sent to real WhatsApp, your real data and `.env` are never used, and no number can get banned.

| | A. From your Mac (quick) | B. Render (always on) |
|---|---|---|
| Set-up time | 2 minutes | ~10 minutes, one time |
| Cost | Free | Free plan |
| Link | `https://<random>.trycloudflare.com` — changes every time | `https://quotebot-demo.onrender.com` — stays the same |
| Works when | Your Mac is on, awake and the commands are running | Always (sleeps after 15 min idle; first visit then takes ~1 min) |
| Client's changes | Kept in `demo-data/` until you reset | Reset whenever Render restarts the demo |
| Best for | A live walkthrough on a call today | Letting the client explore on their own over a few days |

## A. Share from your Mac (Cloudflare Quick Tunnel)

```bash
cd quotebot
git pull && npm install
DEMO_PASSWORD='pick-a-password' npm run demo      # demo on http://localhost:3100
```
In a **second** Terminal window:
```bash
brew install cloudflared                          # one time (Homebrew)
cloudflared tunnel --url http://localhost:3100
```
It prints a link like `https://quiet-river-1234.trycloudflare.com` — send that and the password to your client.

- Want only your client to get in, even with the link? Add their email:
  `cloudflared tunnel --url http://localhost:3100 --allowed-mail client@theircompany.com`
  (they'll get a one-time code by email before the login page).
- Keep your Mac awake while they use it (plug in; *System Settings → Battery → Prevent sleeping* or run `caffeinate -d` in a third window).
- Stop sharing: press `Ctrl+C` in both windows. The link dies immediately.
- Without `DEMO_PASSWORD`, a password is generated and printed when the demo starts (it's also in `demo-data/demo-password.txt`).

## B. Always-on demo on Render (free)

1. Sign up at **render.com** with your GitHub account.
2. **New → Blueprint** → choose the `whatsapp-quote-bot` repository. Render reads `render.yaml` from the repo.
3. It asks for two values: **DEMO_PASSWORD** (what you'll give the client, 8+ characters) and **DEMO_CONTACT_PHONE**
   (the number shown in quotes, e.g. `+91 98xxx xxxxx`). Click **Apply**.
   (Leave the password empty and one is generated — it appears in the service's **Logs** as *Login password: demo-…*.)
4. Wait for the first build (a few minutes). Your link is shown at the top, e.g. `https://quotebot-demo.onrender.com`.
5. Send the client the link and password. Every `git push` to GitHub redeploys the demo automatically.

To take it down: Render dashboard → the service → **Settings → Delete**.

## C. Let the client try it with their own WhatsApp (trial)

`npm run trial` starts a separate copy of the **real** bot: the client links their own WhatsApp by scanning a QR on
their screen, and real messages in their groups get real replies. It has its own folder (`trial-data/`), its own
password, sample chemicals to start with, and a step-by-step checklist at the top of the dashboard.

**Before you start, tell the client:**
- **Their number is at risk, not yours.** This uses WhatsApp's linked-device protocol (not the official API). Low
  volume testing is low risk, but a number *can* get restricted. Safest: a spare number. At least: test in **one new
  group** (e.g. *Quote Bot test* with a colleague), keep every buyer group **OFF**.
- **Their WhatsApp session lives wherever the trial runs** (Render, your Mac or your server). Whoever can log in to
  the trial dashboard can send messages from their number. So: use a long random password (only the client gets
  it), restrict the Mac link to their email, and end the trial properly (below).
- Test mode starts **ON**, so they can test by typing on their own phone. Every group starts with auto-reply **OFF**.

**Where to run it:**

| | **Hosted on Render** (recommended) | Your Mac + Cloudflare link | Your own server (DEPLOY.md) |
|---|---|---|---|
| Cost | ~US$7.25 / month (≈ ₹650) | Free | ~₹400–600 / month |
| Set-up | ~10 min in the browser, no server to manage | 2 min | ~30 min, you look after the server |
| Bot answers | 24×7 | Only while your Mac is on and awake | 24×7 |
| WhatsApp stays linked | Yes (1 GB disk) | Yes | Yes |
| Updates | Automatic on every `git push` | `git pull` + restart | `git pull` + rebuild |
| Link | `https://quotebot-trial.onrender.com` (fixed) | Changes every run | Your own domain |

(Render's *free* plan doesn't work for the trial: it sleeps after 15 minutes — the bot stops answering — and has no
disk, so WhatsApp unlinks on every restart. It's fine for the sample-data demo in B.)

**Hosted trial on Render:**
1. Sign in at **render.com** with GitHub and add a card (Billing).
2. **New → Blueprint** → choose `whatsapp-quote-bot` → set **Blueprint file** to `render-trial.yaml`.
3. Render asks for **DASHBOARD_PASSWORD** (the client's login — use 12+ random characters) and, optionally,
   **CONTACT_PHONE**. Click **Apply** and wait for the first build (~5 min).
4. Open `https://quotebot-trial.onrender.com` (the exact link is at the top of the service page), log in, and check
   the checklist appears. Send the client the link and the password.
5. The client clicks **Link WhatsApp** and scans the QR with their phone. Done — it keeps running on its own.

Notes: a password typed into Render is used only at the first start; after that change it in *Settings → Security*.
Each `git push` redeploys with ~30 s of downtime (the disk can't be shared between two copies), and WhatsApp reconnects by
itself. To end it: client unlinks, then Render → the service → *Settings → Delete* (this deletes the disk and their
WhatsApp session too).

**Trial from your Mac:**
```bash
cd quotebot && git pull && npm install
npm run trial                 # prints the password (also in trial-data/trial-password.txt) → http://localhost:3200
```
In a second Terminal window (update cloudflared first: `brew upgrade cloudflared`):
```bash
cloudflared tunnel --url http://localhost:3200 --allowed-mail client@theircompany.com
```
Send the client the `https://….trycloudflare.com` link and the password. They get a one-time code by email, log in,
click **Link WhatsApp**, scan the QR with their phone (*WhatsApp → Settings → Linked devices → Link a device*), then
follow the checklist. Keep your Mac awake (`caffeinate -d` in a third window).

**On your own server:** follow DEPLOY.md and add `TRIAL_MODE=1` to that server's `.env` (shows the
checklist and turns on Test mode at the first start). Remove it when they go live.

**Ending a trial on your Mac:**
1. The client unlinks: dashboard pill → *Unlink this number* (or on the phone: *Linked devices → Quote Bot (trial) → Log out*).
2. You press `Ctrl+C` in both windows — the link stops working immediately.
3. Delete their session and data: `rm -rf trial-data`. (Or, if they're going live, move the folder to their server —
   chemicals, templates and history carry over.)

You can run the demo (port 3100), the trial (3200) and your own bot (3000) at the same time — each has its own data and
WhatsApp session.

## D. Free (or free-to-start) servers

The bot must run **all the time** (it holds a live connection to WhatsApp) and needs a **disk** (database + WhatsApp
login). Most "free hosting" sleeps or has no disk, so it only suits the demo. These do work:

| | DigitalOcean | Oracle Cloud *Always Free* | Google Cloud *e2-micro* |
|---|---|---|---|
| Price | **$200 credit for 60 days** for new accounts, then from ~$6/month | **Free, no end date** | **Free, no end date** |
| Server | Any size within the credit (1 GB is plenty) | Arm: 2 cores / 12 GB total, or 2 small AMD VMs (1 GB) | 1 small VM (1 GB RAM, 30 GB disk) |
| Location | **Bangalore** (Indian IP) | **Mumbai / Hyderabad** (Indian IP) | USA only (Oregon, Iowa, S. Carolina) |
| Catch | Card needed; not free after 60 days | Card needed; "out of capacity" for Arm is common; Oracle may **reclaim idle** free VMs (CPU, network and — on Arm — memory all under 20% for 7 days, which a light bot can hit). Upgrading the account to *Pay-As-You-Go* (still ₹0 within the free limits) is the usual fix | Card needed; only 1 GB/month outbound traffic free (fine for a trial) |
| Ease | Easiest | Hardest sign-up and network set-up | Medium |

Not suitable for the real bot (fine for the demo): Render free and Koyeb free (sleep, no disk), Fly.io (trial only),
Hugging Face Spaces (sleeps; Docker needs a paid plan), Back4app (60-minute containers), Vercel / Netlify /
Cloudflare Pages (no always-running process).

**Set-up on any of them (≈15 minutes):**
1. Create an **Ubuntu 24.04** server (Oracle Arm: the *aarch64* image works) with your SSH key, and note its IP.
2. Web address: add a DNS **A record** pointing at that IP — e.g. `proto-pawan-chemicals.yourdomain.com`
   (if you own `zero7.space`, add `proto-pawan-chemicals` in Hostinger's DNS zone). No domain? Press Enter when the script
   asks and it uses `<ip>.sslip.io`, which needs no DNS (an IP-based name — fine for a prototype).
3. Log in and run **one command** (it asks for the address and whether it's a client trial):
   ```bash
   ssh root@YOUR_SERVER_IP          # Oracle/Google: ssh ubuntu@… and the command runs with sudo
   curl -fsSL https://raw.githubusercontent.com/R0hannaik/whatsapp-quote-bot/main/scripts/install-server.sh | sudo bash
   ```
   It sets up swap, Docker, the firewall, automatic security updates and HTTPS, generates a strong password and
   prints the link + password. Oracle only: also open ports 80 and 443 in the subnet's *Security List* (the script reminds you).
4. Open the link, log in, send the client the link + password. Running the command again later updates the bot and
   keeps the data and password.

## What to tell the client

1. Log in with the password.
2. **💬 Demo Chat** → try the quick messages: *Ask a rate*, *Several products*, *Negotiate*, then *Place the order ↩*.
3. Look at **Orders & Decisions** (every enquiry; orders waiting for the owner), **Payments** (overdue reminders),
   **Reply Templates** (change the wording and watch the preview), and **Chemicals & Rates Matrix** (edit a price, ask again).
4. **↺ Reset demo data** (in Demo Chat) puts everything back to the sample data.

In the demo, things that would affect the next visitor are switched off: unlinking WhatsApp, changing the password,
logging everyone out, and off-site backups.

## Showing the real bot later

For a live pilot with the client's own WhatsApp number and data, use **DEPLOY.md** (own server, HTTPS, encrypted backups)
— not the demo.
