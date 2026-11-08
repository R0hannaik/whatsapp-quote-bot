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
- **Their WhatsApp session lives on the computer running the trial** (your Mac or your server). Whoever can log in to
  the trial dashboard can send messages from their number. So: restrict the link to their email, use the generated
  password, and end the trial properly (below).
- Test mode starts **ON**, so they can test by typing on their own phone. Every group starts with auto-reply **OFF**.

**Where to run it:**

| | Your Mac + Cloudflare link | A small server (DEPLOY.md) | Render free |
|---|---|---|---|
| Cost | Free | ~₹400–600 / month | Free |
| Bot answers | Only while your Mac is on and awake | 24×7 | ✗ Sleeps after 15 min idle — the bot stops answering |
| WhatsApp stays linked | Yes | Yes | ✗ Lost on every restart (no disk) — re-scan each time |
| WhatsApp sees | A home internet connection (like WhatsApp Web on a PC) | A data-centre address | — |
| Good for | A trial of a few hours/days | A longer pilot | ✗ Not suitable for the real bot (fine for the demo) |

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

**On a server for a longer pilot:** follow DEPLOY.md and add `TRIAL_MODE=1` to that server's `.env` (shows the
checklist and turns on Test mode at the first start). Remove it when they go live.

**Ending the trial:**
1. The client unlinks: dashboard pill → *Unlink this number* (or on the phone: *Linked devices → Quote Bot (trial) → Log out*).
2. You press `Ctrl+C` in both windows — the link stops working immediately.
3. Delete their session and data: `rm -rf trial-data`. (Or, if they're going live, move the folder to their server —
   chemicals, templates and history carry over.)

You can run the demo (port 3100), the trial (3200) and your own bot (3000) at the same time — each has its own data and
WhatsApp session.

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
