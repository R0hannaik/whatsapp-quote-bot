# WhatsApp Auto-Quotation Bot

A WhatsApp bot that reads enquiries in your groups ("PA 2 ton Bhiwandi rate urgent chahiye"), understands
which chemical, quantity, location and origin the person wants, and replies with a formatted quotation from
your rates matrix — plus a password-protected dashboard to run it.

## What's inside

| Dashboard tab | What it does |
|---|---|
| **Chemicals & Rates Matrix** | Add / edit chemicals, aliases (PA, p.a., phthalic…), brand, packaging, single price or rates by origin (China, Korea…), stock status. *Edit Chemical* opens the **Edit Chemical Details & Price** modal. |
| **WhatsApp Groups Monitor** | Every group the bot's number is in: name & ID, type, members, quotes sent, and an **auto-reply toggle** (all OFF by default). *Sync Live Groups*, *Turn All OFF*, *+ Add Custom Group* (by group ID, phone number, or invite link). |
| **WhatsApp Reply Templates** | *Price Quotation* and *Deal & Negotiation* templates with presets, click-to-insert variables, bold/italic/mono toolbar and a live WhatsApp preview. Type any message in the preview bubble to see exactly what the bot would understand and reply. |
| **Orders & Decisions** | Every enquiry the bot answered (and requests it couldn't match). **You** set the final status — Confirmed, Negotiating, On Hold, Rejected, Dispatched — with final rate, qty, private notes, history, and a box to reply in the group. CSV export. |
| **Group Join QR** | A QR code that **changes every 10 minutes**: the bot revokes the group's invite link and creates a new one, so old screenshots stop working. Includes a public page (no login) you can show on a screen or website. |
| **Settings** | Business name / phone, reply delays, cooldowns, negotiation & seller-post keywords, optional AI fallback, password change, WhatsApp unlink. |

How the bot decides:
- Replies **only** in groups switched ON, quoting the original message, after a 2–6 s "typing…" delay.
- Recognises aliases, dotted codes (p.a.), joined words and typos (pthalic → Phthalic). Short codes like
  "PA"/"AA" need to be in capitals or next to a request word/quantity so Hindi words like "aa" don't trigger it.
- Ignores seller posts ("available with us @ 104/kg"), greetings, long price lists, and backlog after a reconnect.
- "last rate", "best price", "discount", "kam"… → **Deal & Negotiation** template (it never promises a lower price).
- Asks for an origin ("Korea PA rate") → only that origin's rate is sent.
- Cooldown per person + chemical, and a per-group cap, to keep the number safe.

## Run it

Needs **Node.js 20+** on a machine that stays on (a small VPS or an always-on PC).

```bash
cp .env.example .env        # set DASHBOARD_PASSWORD
npm install
npm start                   # → http://localhost:3000
```

1. Log in with your password.
2. Click the red **Link WhatsApp** bar → on the bot's phone open **WhatsApp → Settings → Linked devices → Link a device** and scan.
3. **WhatsApp Groups Monitor → Sync Live Groups**, then switch ON the groups where the bot should quote.
4. Fill in your **Chemicals & Rates Matrix** and test in **Reply Templates** by typing messages in the preview.

Keep it running with pm2: `npm i -g pm2 && pm2 start src/server.js --name quotebot && pm2 save`
or Docker: `docker build -t quotebot . && docker run -d -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data quotebot`

For access from outside your network, put it behind HTTPS (Caddy / Nginx / Cloudflare Tunnel) and set `TRUST_PROXY=1`.

## Important notes

- **Use a separate WhatsApp number** for the bot. This uses WhatsApp Web's linked-device protocol (Baileys), which is
  not an official WhatsApp API; automated messaging can get a number restricted. The delays, cooldowns and
  ON-only groups reduce that risk — keep them on.
- For the rotating join QR, the bot's number must be an **admin** of the group.
- Everything is stored in `data/` (SQLite database + WhatsApp session). Back up that folder; delete
  `data/wa-auth` to force a fresh WhatsApp login.

## Tests

`npm test` runs the message-understanding checks (Hinglish enquiries, typos, seller posts, multi-chemical messages).
