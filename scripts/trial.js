#!/usr/bin/env node
// Start a trial copy where a client links THEIR OWN WhatsApp and tries the real bot:  npm run trial
//   - its own folder (trial-data/): never your real data, .env or WhatsApp session
//   - sample chemicals to start with; every group starts with auto-reply OFF
//   - Test mode ON at first start, so the client can test by typing on their own phone
//   - prints the login password (or set TRIAL_PASSWORD=… yourself)
// Share it with:  cloudflared tunnel --url http://localhost:3200 --allowed-mail client@example.com   (see SHARING.md)
process.env.TRIAL_MODE = '1';
process.env.QB_NO_DOTENV = '1';            // keep your real .env (password, phone, backup keys) out of the trial
delete process.env.DASHBOARD_PASSWORD;
process.env.DATA_DIR ||= './trial-data';
process.env.PORT ||= '3200';
process.env.TRUST_PROXY ||= '1';           // correct visitor IPs + secure cookies behind a tunnel
process.env.WA_DEVICE_NAME ||= 'Quote Bot (trial)';   // the name the client sees under Linked devices
process.env.QB_START = '1';
await import('../src/server.js');
