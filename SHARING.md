# Sharing the prototype with a client

Share the **demo**, not your real bot. The demo is a separate copy with sample chemicals, groups, enquiries, orders and
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
