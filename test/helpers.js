// Shared test setup. Each test file runs in its own process (node --test), so each gets a fresh temp database.
// Call setupEnv() BEFORE importing anything from ../src (they read the environment when first imported).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export function setupEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotebot-test-'));
  Object.assign(process.env, {
    QB_NO_DOTENV: '1',               // never read the real .env
    DATA_DIR: dir,
    WA_DISABLED: '1',                // never connect to WhatsApp
    DASHBOARD_PASSWORD: 'test-password-123',
    WA_LOG_LEVEL: 'silent',
    QB_QUIET: '1',                   // keep test output readable
    QB_FAST: '1',                    // no waiting between payment reminders
    ...extra,
  });
  delete process.env.CONTACT_PHONE;
  delete process.env.ANTHROPIC_API_KEY;
  if (extra.CONTACT_PHONE) process.env.CONTACT_PHONE = extra.CONTACT_PHONE;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

/** Minimal stand-in for a Baileys socket: records what the bot sends. */
export function fakeSocket({ unlink = 'ack' } = {}) {
  const ev = new EventEmitter();
  let n = 0;
  const sock = {
    ev, sent: [], queries: [], ended: false,
    authState: { creds: { me: { id: '919000000009:3@s.whatsapp.net' } } },
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content, opts = {}) => { sock.sent.push({ jid, text: content.text, quoted: !!opts.quoted }); sock.sentCount = ++n; return { key: { id: `BOT${n}` } }; },
    query: async node => {
      sock.queries.push(node);
      if (unlink === 'ack') return { tag: 'iq', attrs: { type: 'result' } };
      if (unlink === 'close') {
        setTimeout(() => ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }), 20);
        throw new Error('Connection Closed');
      }
      throw new Error('Timed Out');
    },
    groupRevokeInvite: async () => { throw new Error('not-authorized'); },
    end() { sock.ended = true; },
  };
  return sock;
}

let seq = 0;
/** A WhatsApp group message as Baileys delivers it. */
export function waMessage(text, { group = '120363000000000001@g.us', from = '919000000001@s.whatsapp.net', fromMe = false, name = 'Rakesh', ageSec = 0, id, replyTo } = {}) {
  return {
    key: { remoteJid: group, id: id || `MSG${++seq}`, participant: fromMe ? undefined : from, fromMe },
    pushName: name,
    messageTimestamp: Math.floor(Date.now() / 1000) - ageSec,
    // replyTo = { id, participant }: a swipe-reply to an earlier message (e.g. the bot's quote)
    message: text == null ? null : replyTo
      ? { extendedTextMessage: { text, contextInfo: { stanzaId: replyTo.id, participant: replyTo.participant } } }
      : { conversation: text },
  };
}

/** Sample catalogue used by the pure parser / quote tests. */
export const CHEMS = [
  { id: 1, name: 'Phthalic Anhydride', alias_list: ['pa', 'p.a.', 'phthalic', 'phthalic anhydride', 'pthalic anhydride'], unit: 'kg', gst: 18, manufacturer: 'IGPL',
    packaging: '25 kgs Bag', location: 'Bhiwandi / Mumbai Ex-Godown', status: 'In Stock', price: null,
    origin_rates: [{ country: 'India', brand: 'Reliance / IGPL', rate: 108.5 }, { country: 'Russia', brand: 'Imported', rate: 105 }, { country: 'Korea', brand: 'Aekyung', rate: 110 }] },
  { id: 2, name: 'Acrylic Acid', alias_list: ['aa', 'a.a.', 'acrylic', 'acrylic acid'], unit: 'kg', gst: 18, packaging: '200 kg Drum', status: 'In Stock', price: null,
    origin_rates: [{ country: 'China', brand: '', rate: 138 }] },
  { id: 3, name: 'Maleic Anhydride', alias_list: ['ma', 'm.a', 'maleic', 'maleic anhydride', 'malic'], unit: 'kg', gst: 18, manufacturer: 'Tengda', packaging: '25 kg Bag', status: 'In Stock', price: null,
    origin_rates: [{ country: 'China', brand: 'Tengda', rate: 165 }, { country: 'China', brand: 'Boiko', rate: 168 }] },
  { id: 4, name: 'Monosodium Glutamate', alias_list: ['msg', 'm.s.g.'], unit: 'kg', gst: 5, manufacturer: 'MEIHUA', packaging: '25 kgs Bag', status: 'Limited', origin_rates: [], price: 120 },
  { id: 5, name: 'Isopropyl Alcohol', alias_list: ['ipa', 'isopropyl alcohol', 'isopropanol'], unit: 'kg', gst: 18, packaging: '160 kg Drum', status: 'In Stock', origin_rates: [], price: 102 },
];
