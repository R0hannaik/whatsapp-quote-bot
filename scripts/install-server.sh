#!/usr/bin/env bash
# One-command set-up of Quote Bot on a fresh Ubuntu/Debian server
# (DigitalOcean, Oracle Cloud Always Free, Google Cloud e2-micro, Hetzner, AWS Lightsail …).
#
#   curl -fsSL https://raw.githubusercontent.com/R0hannaik/whatsapp-quote-bot/main/scripts/install-server.sh | sudo bash
#
# It asks for the web address (DOMAIN) and whether this is a client trial. Or pass them in:
#   … | sudo DOMAIN=quotes.example.com TRIAL=1 CONTACT_PHONE='+91 98xxx xxxxx' bash
#
# What it does: swap on small servers · Docker · firewall (SSH + web only) · automatic security updates ·
# downloads the bot to /opt/quotebot · writes .env with a strong generated password · starts the bot + HTTPS.
# Safe to run again: it updates the code and keeps your .env and data.
set -euo pipefail

REPO="${REPO:-https://github.com/R0hannaik/whatsapp-quote-bot.git}"
DIR="${DIR:-/opt/quotebot}"
say()  { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "question" "default" — reads from the terminal even when piped from curl
  local var=$1 q=$2 def=${3:-} ans=''
  if [ -n "${!var:-}" ]; then return; fi
  if [ -r /dev/tty ]; then read -r -p "$q${def:+ [$def]}: " ans </dev/tty || true; fi
  printf -v "$var" '%s' "${ans:-$def}"
}
set_env() { # set_env KEY VALUE — replace or add one line in .env
  local tmp; tmp=$(mktemp)
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"
}

[ "$(id -u)" = 0 ] || die "Run as root:  curl -fsSL … | sudo bash"
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian servers (apt). See DEPLOY.md for others."
export DEBIAN_FRONTEND=noninteractive

PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org || true)
say "Server address: ${PUBLIC_IP:-unknown}"

# ---------- questions ----------
EXISTING=0; [ -f "$DIR/.env" ] && EXISTING=1
if [ "$EXISTING" = 0 ]; then
  echo "The dashboard needs a web address that points at this server (an A record → ${PUBLIC_IP:-the server IP})."
  echo "  e.g. quotes.yourcompany.in, or a free one like yourname.duckdns.org"
  echo "  (no domain at all? use ${PUBLIC_IP:-1.2.3.4}.sslip.io — works without any DNS set-up)"
  ask DOMAIN "Web address" "${PUBLIC_IP:+$PUBLIC_IP.sslip.io}"
  [ -n "${DOMAIN:-}" ] || die "A web address is needed for HTTPS."
  ask TRIAL "Is this a trial for a client? Shows a getting-started checklist and turns on Test mode (y/N)" "n"
  ask CONTACT_PHONE "Phone number to print in quotations (optional, e.g. +91 98xxx xxxxx)" ""
fi

# ---------- swap: small (1 GB) servers need it for building ----------
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && ! swapon --show | grep -q .; then
  say "Adding 2 GB swap (this server has ${MEM_MB} MB RAM)"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- packages ----------
say "Installing updates, git and Docker"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates unattended-upgrades >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null || die "Docker Compose is missing — see https://docs.docker.com/compose/install/"

# ---------- firewall: SSH + web only ----------
say "Firewall: allowing SSH, HTTP and HTTPS"
if [ -f /etc/iptables/rules.v4 ] && grep -q REJECT /etc/iptables/rules.v4; then
  # Oracle Cloud images ship their own iptables rules that block everything but SSH
  for p in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null; then
      at=$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')   # just before the "block the rest" rule
      iptables -I INPUT "${at:-1}" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    fi
  done
  netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4
  warn "Oracle Cloud: also open ports 80 and 443 in the VCN Security List (Networking → Virtual cloud networks → subnet → Security list → Add ingress rules)."
else
  apt-get install -y -qq ufw >/dev/null
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

# ---------- code ----------
if [ -d "$DIR/.git" ]; then
  say "Updating the bot in $DIR"
  git -C "$DIR" pull --ff-only -q || warn "Could not update the code (changed files in $DIR?) — keeping the current version."
else
  say "Downloading the bot to $DIR"
  git clone -q "$REPO" "$DIR"
fi
cd "$DIR"

# ---------- .env ----------
PASSWORD_MSG="(unchanged — the one you set before)"
if [ "$EXISTING" = 0 ]; then
  cp .env.example .env
  chmod 600 .env
  PASSWORD=$(openssl rand -hex 12 2>/dev/null || head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
  set_env DOMAIN "$DOMAIN"
  set_env DASHBOARD_PASSWORD "$PASSWORD"
  set_env CONTACT_PHONE "${CONTACT_PHONE:-}"
  if [[ "${TRIAL:-n}" =~ ^([yY]|1|yes)$ ]]; then
    set_env TRIAL_MODE 1
    set_env WA_DEVICE_NAME "Quote Bot (trial)"
  fi
  PASSWORD_MSG="$PASSWORD"
fi
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

# ---------- start ----------
say "Building and starting (first time takes a few minutes)"
docker compose up -d --build
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = healthy ] && break
  sleep 3
done
docker compose ps

RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
if [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  warn "$DOMAIN points to '${RESOLVED:-nothing}', not this server ($PUBLIC_IP). Add/fix the DNS A record; HTTPS starts working a few minutes after it's right."
fi

cat <<EOF

  ✅ Quote Bot is running.

  Open:      https://$DOMAIN
  Password:  $PASSWORD_MSG
             (saved in $DIR/.env — change it any time in Settings → Security)

  Next: log in → click "Link WhatsApp" → scan the QR with the bot's phone
        (WhatsApp → Settings → Linked devices → Link a device).

  Logs:      cd $DIR && docker compose logs -f app
  Update:    re-run this script, or: cd $DIR && git pull && docker compose up -d --build
  Backups:   set up encrypted off-site backups — DEPLOY.md → "Off-site backups".
EOF
