#!/usr/bin/env node
// Start a demo copy for showing clients:  npm run demo
//   - uses its own folder (demo-data/), never your real data or .env
//   - simulated WhatsApp (nothing is sent anywhere), sample chemicals, groups, enquiries, orders and payments
//   - prints the login password (or set DEMO_PASSWORD=… yourself)
// Share it with:  cloudflared tunnel --url http://localhost:3100   (see SHARING.md)
process.env.DEMO_MODE = '1';
process.env.QB_NO_DOTENV = '1';            // keep your real .env (password, phone, backup keys) out of the demo
process.env.DATA_DIR ||= './demo-data';
process.env.PORT ||= '3100';
process.env.TRUST_PROXY ||= '1';           // correct visitor IPs + secure cookies behind a tunnel
process.env.QB_START = '1';
await import('../src/server.js');
