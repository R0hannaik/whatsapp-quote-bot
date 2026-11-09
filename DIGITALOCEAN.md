# Hosting on DigitalOcean (Bangalore)

The recommended way to host Quote Bot — for a client trial and for live use. ≈ 20 minutes, all in the browser.

**Cost:** a 1 GB server is **$6/month**. New DigitalOcean accounts get **$200 of credit for 60 days**, so a trial costs
nothing. Optional weekly server snapshots add $1.20/month.
**Why Bangalore:** WhatsApp sees the bot's login coming from an Indian internet address, like the phone itself.

---

## 1. Create the account

1. Sign up at **digitalocean.com** (the $200 / 60-day credit is shown on sign-up for new accounts). Add a card or PayPal.
2. Recommended: **Settings → Billing → Billing alerts** → alert at **$10**, so nothing surprises you after the credit ends.
3. Recommended: **Settings → Security → Two-factor authentication** on. This account will hold a WhatsApp login.

## 2. Create the server ("Droplet")

**Create → Droplets**, then:

| Setting | Choose |
|---|---|
| Region | **Bangalore** (BLR1) |
| Image | **Ubuntu 24.04 (LTS) x64** |
| Size | **Basic → Regular → $6/mo** (1 GB RAM / 1 CPU / 25 GB disk) |
| Authentication | **SSH key** if you have one; otherwise **Password** (long and random — save it in your password manager) |
| Backups (optional) | **Weekly** (+$1.20/mo) — whole-server snapshots, on top of the bot's own encrypted backups |
| Hostname | `quotebot` (or `quotebot-trial`) |

Click **Create Droplet** and copy its **IPv4 address** (e.g. `139.59.12.34`).

## 3. Give it a web address

Pick one:
- **A domain you own** (e.g. `zero7.space` at Hostinger): in the domain's DNS settings add an **A record** —
  name `proto-pawan-chemicals` (or `quotes`), value = the Droplet's IP. Your link becomes
  `https://proto-pawan-chemicals.zero7.space`. DNS usually works within minutes.
- **No domain:** skip this. The installer offers `<ip>.sslip.io` (e.g. `139.59.12.34.sslip.io`, which needs no DNS) —
  fine for a prototype; use a real domain for live use.

## 4. Install the bot (one command)

On the Droplet's page: **Access → Launch Droplet Console** (a terminal opens in your browser — no SSH needed).
Paste:

```bash
curl -fsSL https://raw.githubusercontent.com/R0hannaik/whatsapp-quote-bot/main/scripts/install-server.sh | bash
```

Answer the three questions:
1. **Web address** — the one from step 3 (or press Enter for the sslip.io one).
2. **Client trial?** — `y` for a trial (getting-started checklist + Test mode on), `n` for live use.
3. **Phone number for quotations** — optional.

It takes ~5 minutes and ends with:

```
  ✅ Quote Bot is running.
  Open:      https://proto-pawan-chemicals.zero7.space
  Password:  3f9c…
```

Save the password in your password manager. (Forgot it? In the console: `grep DASHBOARD_PASSWORD /opt/quotebot/.env`
— valid until someone changes it in *Settings → Security*.)

## 5. Hand it to the client

1. Open the link, log in, check the checklist/dashboard shows.
2. Send the client the **link and password** (separately is better — e.g. link on email, password on WhatsApp).
3. The client clicks **Link WhatsApp** and scans the QR with his phone
   (*WhatsApp → Settings → Linked devices → Link a device*), then follows the checklist.

Tell him first (see SHARING.md → C): use a spare number or one test group, keep buyer groups OFF while testing.

## 6. Afterwards

| To… | Do this (Droplet Console) |
|---|---|
| Update the bot to the latest version | run the same install command again (keeps data + password) |
| See what the bot is doing | `cd /opt/quotebot && docker compose logs -f app` |
| Restart | `cd /opt/quotebot && docker compose restart app` |
| Turn the trial into live use | `cd /opt/quotebot && sed -i '/^TRIAL_MODE=/d' .env && docker compose up -d`, then in the dashboard turn **Test mode** off (Settings) |
| Protect the data off-site | DEPLOY.md → *Off-site backups* (encrypted, hourly) |
| End the trial and wipe everything | client unlinks (dashboard or phone) → DigitalOcean → Droplet → **Destroy**. Billing stops; the server, database and WhatsApp login are deleted. |

**Cost after the credit:** $6/month (+$1.20 with backups), billed monthly. Destroying the Droplet stops the charge —
switching it *off* does not.
