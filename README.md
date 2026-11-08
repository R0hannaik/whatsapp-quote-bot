# WhatsApp Auto-Quotation Bot

A WhatsApp bot that reads enquiries in your groups ("PA 2 ton Bhiwandi rate urgent chahiye"), understands
which chemical, quantity, location and origin the person wants, and replies with a formatted quotation from
your rates matrix — plus a password-protected dashboard to run it.

## What's inside

| Dashboard tab | What it does |
|---|---|
| **Chemicals & Rates Matrix** | Add / edit chemicals, aliases (PA, p.a., phthalic…), brand, packaging, single price or rates by origin (China, Korea…), stock status. *Edit Chemical* opens the **Edit Chemical Details & Price** modal. |
| **WhatsApp Groups Monitor** | Every group the bot's number is in: name & ID, type, members, quotes sent, and an **auto-reply toggle** (all OFF by default). *Sync Live Groups*, *Turn All OFF*, *+ Add Custom Group* (by group ID, phone number, or invite link). |
| **WhatsApp Reply Templates** | *Price Quotation*, *Deal & Negotiation* and *Multi-Product* templates with presets, click-to-insert variables, bold/italic/mono toolbar and a live WhatsApp preview. Type any message in the preview bubble to see exactly what the bot would understand and reply. |
| **Orders & Decisions** | Every enquiry the bot answered (and requests it couldn't match). **You** set the final status — Confirmed, Negotiating, On Hold, Rejected, Dispatched — with final rate, qty, private notes, history, and a box to reply in the group. CSV export. |
| **Payments** | Orders you record (from an enquiry → *📦 Record order*, or *+ New Order*) with amount, invoice, order date and credit days. Pending/Paid, totals outstanding, overdue and due this week. The buyer gets a **payment reminder in the chat where the order was placed** (group — replying to their order message and tagging them — or private chat): first on **day 28** of 30, then **every other day until you mark it Paid**. Timing and wording are editable. |
| **Group Join QR** | A QR code that **changes every 10 minutes**: the bot revokes the group's invite link and creates a new one, so old screenshots stop working. Includes a public page (no login) you can show on a screen or website. |
| **Settings** | Business name / phone, reply delays, cooldowns, negotiation & seller-post keywords, optional AI fallback, password change, WhatsApp unlink. |

How the bot decides:
- Replies **only** in groups switched ON, quoting the original message, after a 2–6 s "typing…" delay.
- Recognises aliases, dotted codes (p.a.), joined words and typos (pthalic → Phthalic). Short codes like
  "PA"/"AA" need to be in capitals or next to a request word/quantity so Hindi words like "aa" don't trigger it.
- Ignores seller posts ("available with us @ 104/kg"), greetings, long price lists, and backlog after a reconnect.
- When a buyer **replies to a quote** with *confirm / book / PO / dispatch…* or asks a follow-up (*payment terms? delivery kab?*), the bot stays quiet and flags it for you in Orders & Decisions (status *Awaiting Owner*).
- "last rate", "best price", "discount", "kam"… → **Deal & Negotiation** template (it never promises a lower price).
- Asks for an origin ("Korea PA rate") → only that origin's rate is sent.
- **Several products in one message** ("Need: 1. PA Korea 2 MT 2. MA China 5 MT 3. IPA 20 drums 4. DOP 1 tanker", or
  "PA 2 MT, AA 10 MT & IPA 5 drums") → **one** combined quotation (up to 10 products). Each product gets its own quantity
  and origin; "5 MT each" is shared; items not in your matrix are listed as *Will check & revert* and saved in
  Orders → Unmatched. Every product gets its own row in Orders, linked as one enquiry. Settings can switch to one
  message per product.
- Cooldown per person + chemical, and a per-group cap, to keep the number safe.

## Run it

Needs **Node.js 20+** on a machine that stays on (a small VPS or an always-on PC).

```bash
cp .env.example .env        # set DASHBOARD_PASSWORD and CONTACT_PHONE
npm install
npm start                   # → http://localhost:3000
```

1. Log in with your password.
2. Click the red **Link WhatsApp** bar → on the bot's phone open **WhatsApp → Settings → Linked devices → Link a device** and scan.
3. **WhatsApp Groups Monitor → Sync Live Groups**, then switch ON the groups where the bot should quote.
4. Fill in your **Chemicals & Rates Matrix** and test in **Reply Templates** by typing messages in the preview.

**Putting it on the web (24×7, HTTPS, your own domain):** see **[DEPLOY.md](DEPLOY.md)** — Docker + automatic HTTPS in a few commands, plus how the database is stored, backed up and restored.

Keep it running with pm2: `npm i -g pm2 && pm2 start src/server.js --name quotebot && pm2 save`
or Docker: `docker build -t quotebot . && docker run -d -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data quotebot`

By default the dashboard only accepts connections from the computer it runs on (`HOST=127.0.0.1`).
To open it from your phone or another PC, set `HOST=0.0.0.0` — and if it will be reachable from the internet,
put it behind HTTPS (Caddy / Nginx / Cloudflare Tunnel) and set `TRUST_PROXY=1`.

## Important notes

- **Use a separate WhatsApp number** for the bot. This uses WhatsApp Web's linked-device protocol (Baileys), which is
  not an official WhatsApp API; automated messaging can get a number restricted. The delays, cooldowns and
  ON-only groups reduce that risk — keep them on.
- For the rotating join QR, the bot's number must be an **admin** of the group.
- Everything is stored in `data/` (SQLite database + WhatsApp session). Daily backups are automatic
  (*Settings → Database backups*); download one regularly. Delete `data/wa-auth` to force a fresh WhatsApp login.

## Security

Built in:
- **Login:** password stored as a salted scrypt hash; signed, HttpOnly session cookie (`Secure` over HTTPS);
  8 failed attempts per IP → 15-minute lockout, plus a global lockout after 50 failures. *Settings → Security*
  has *Change password* and *Log out all devices* (both end every existing session).
- **Every page and API needs login** except `/login` and the public join-QR page, which needs a random secret link
  and only shows group names and invite QRs.
- **Cross-site request forgery** blocked (Origin / Sec-Fetch-Site checks, JSON-only API, SameSite cookie).
- **Script injection** blocked: everything from WhatsApp (names, messages, group names) is escaped, and a strict
  Content-Security-Policy allows only the app's own scripts. Also: no framing (clickjacking), `nosniff`, no API caching.
- **Database:** all queries are parameterised; list sizes and inputs are capped. CSV export neutralises Excel formulas
  (`=`, `+`, `-`, `@`) so a malicious WhatsApp message can't run code when the file is opened.
- **Bot:** sender names are cleaned (no links/formatting) before they can appear in a reply; long messages are ignored;
  per-person cooldown and per-group reply cap; never replies to its own messages; the optional AI step can only
  pick a chemical from your list — prices always come from your matrix.
- **Files:** `data/` (WhatsApp session keys, password hash) is created with owner-only permissions; `.env` and `data/`
  are git-ignored. The Docker image runs as a non-root user.

Your part:
- Use a strong dashboard password and keep `.env` and `data/` private and backed up — anyone with `data/wa-auth`
  can act as the bot's WhatsApp number. If the laptop is shared, enable FileVault (macOS disk encryption).
- Don't expose the dashboard to the internet over plain HTTP. Use HTTPS, or a tunnel with its own login
  (e.g. Cloudflare Access / Tailscale).
- If the bot's phone or a backup is lost: *Settings → Unlink this number*, and also remove the device from
  WhatsApp → Settings → Linked devices on the phone.
- Run `npm audit` occasionally and update dependencies.

## Tests

```bash
npm test            # everything (~1 min): 196 checks
npm run test:quick  # just message reading, quotes, replies and database (a few seconds)
```

| File | What it checks |
|---|---|
| `test/parser.test.js` | Reading messages: enquiries vs chit-chat/seller posts, aliases, typos, Hinglish, quantities & units, origins, negotiation words, multi-product lists |
| `test/quote.test.js` | Quote text: rates by origin, hidden empty lines, every template and preset renders cleanly |
| `test/bot.test.js` | Which reply is sent: single vs combined, Deal template, out-of-stock, paused chemicals, unmatched replies, preview |
| `test/db.test.js` | Groups per linked number (incl. upgrading old databases), `.env` settings, chemicals, templates, orders history & filters |
| `test/whatsapp.test.js` | Live handler with a fake WhatsApp: auto-reply toggles, Test mode, reply-loop guard, cooldowns, group cap, orders records, owner replies, join-link rotation, unlink |
| `test/api.test.js` | Dashboard server: login, every endpoint, validation, cross-site protection, security headers, CSV formula safety, sessions, brute-force lockout |
| `test/ui.test.js` | Clicks through the dashboard in headless Chrome (skipped if Chrome isn't installed; set `CHROME_PATH` to use another) |

Tests use a temporary database and never read your `.env` or connect to WhatsApp. GitHub runs them on every push
(see the *Actions* tab).
