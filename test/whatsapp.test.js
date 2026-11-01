// The live WhatsApp handler, with a fake socket: who gets replies, safety rules, orders records, unlink, invites.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, fakeSocket, waMessage } from './helpers.js';

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const db = await import('../src/db.js');
const wam = await import('../src/whatsapp.js');
const { wa, handleMessage, activity, logoutWhatsApp, rotateInvite, sendOwnerMessage } = wam;
db.ensureSecrets();
db.seedIfEmpty();
db.setSetting('reply_delay_min_sec', 0);
db.setSetting('reply_delay_max_sec', 0);

const ME = '919000000009@s.whatsapp.net';
const G = '120363000000000001@g.us';
let sock;
let senderSeq = 0;
const newSender = () => `91900000${String(++senderSeq).padStart(4, '0')}@s.whatsapp.net`;   // fresh person → no cooldown carry-over
const last = () => activity[0];

function link() {
  sock = fakeSocket();
  wa.sock = sock; wa.status = 'open'; wa.me = { id: ME };
  db.setCurrentAccount(ME);
}
link();
db.upsertLiveGroup({ jid: G, name: 'Traders', members: 10 });

describe('who gets a reply', () => {
  beforeEach(() => { sock.sent.length = 0; db.patchGroup(G, { auto_reply: true }); db.setSetting('cooldown_minutes', 3); });

  test('auto-reply OFF → no reply', async () => {
    db.patchGroup(G, { auto_reply: false });
    await handleMessage(waMessage('PA 2 MT rate chahiye', { from: newSender() }));
    assert.equal(sock.sent.length, 0);
    assert.match(last().detail, /auto-reply is OFF/);
  });
  test('auto-reply ON → quote sent as a reply to the message', async () => {
    await handleMessage(waMessage('PA 2 MT rate chahiye', { from: newSender() }));
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, G);
    assert.equal(sock.sent[0].quoted, true);
    assert.match(sock.sent[0].text, /Phthalic Anhydride/);
    assert.equal(last().result, 'replied');
  });
  test('group not synced → no reply, with a hint', async () => {
    await handleMessage(waMessage('PA 2 MT rate', { group: '120363999999999999@g.us' }));
    assert.equal(sock.sent.length, 0);
    assert.match(last().detail, /Sync Live Groups/);
  });
  test("bot's own number is ignored unless Test mode is on", async () => {
    await handleMessage(waMessage('PA 2 MT rate chahiye', { fromMe: true }));
    assert.equal(sock.sent.length, 0);
    assert.match(last().detail, /Test mode/);
    db.setSetting('reply_to_own_messages', true);
    await handleMessage(waMessage('MA 2 MT rate chahiye', { fromMe: true }));
    assert.equal(sock.sent.length, 1);
    db.setSetting('reply_to_own_messages', false);
  });
  test('never answers its own quote (no reply loops), even in Test mode', async () => {
    db.setSetting('reply_to_own_messages', true);
    db.setSetting('cooldown_minutes', 0);                         // so only the loop guard can stop the echo
    db.saveTemplate('quote', 'Need {product_name} rate? {quantity} chahiye');   // a reply that itself looks like an enquiry
    await handleMessage(waMessage('AA 3 MT rate chahiye', { fromMe: true }));
    assert.equal(sock.sent.length, 1);
    const quote = sock.sent[0].text;
    const botId = `BOT${sock.sentCount}`;
    await handleMessage(waMessage(quote, { fromMe: true, id: botId }));          // echo by message id
    await handleMessage(waMessage(quote, { fromMe: true }));                     // echo by text
    assert.equal(sock.sent.length, 1, 'the bot replied to its own quote');
    db.resetTemplate('quote');
    db.setSetting('reply_to_own_messages', false);
  });
  test('old messages after a reconnect are ignored', async () => {
    await handleMessage(waMessage('PA 2 MT rate', { from: newSender(), ageSec: 3600 }));
    assert.equal(sock.sent.length, 0);
    assert.match(last().detail, /old message/);
  });
  test('messages that could not be decrypted are reported', async () => {
    await handleMessage(waMessage(null, { from: newSender() }));
    assert.match(last().detail, /could not decrypt/);
  });
  test('chit-chat and seller posts get no reply', async () => {
    const who = newSender();
    await handleMessage(waMessage('Good morning all', { from: who }));
    await handleMessage(waMessage('PA Korea available with us @ 104/kg', { from: who }));
    assert.equal(sock.sent.length, 0);
  });
  test('cooldown: same person, same product within the window → one reply', async () => {
    const who = newSender();
    await handleMessage(waMessage('IPA 20 drums rate', { from: who }));
    await handleMessage(waMessage('IPA 20 drums rate?', { from: who }));
    assert.equal(sock.sent.length, 1);
    assert.match(last().detail, /cooldown/);
  });
  test('per-group cap on replies', async () => {
    db.setSetting('group_max_replies_per_10min', 2);
    const G2 = '120363000000000002@g.us';
    db.upsertLiveGroup({ jid: G2, name: 'Busy', members: 3 }); db.patchGroup(G2, { auto_reply: true });
    for (let i = 0; i < 4; i++) await handleMessage(waMessage('PA 2 MT rate', { group: G2, from: newSender() }));
    assert.equal(sock.sent.length, 2);
    db.setSetting('group_max_replies_per_10min', 15);
  });
  test("sender display names are cleaned before being stored or echoed", async () => {
    await handleMessage(waMessage('MSG 1 ton rate', { from: newSender(), name: '*Buy* now http://evil.example ‮x' }));
    const row = db.listInquiries({ status: 'all' })[0];
    assert.ok(!/http|\*|‮/.test(row.sender_name), row.sender_name);
  });
});

describe('multi-product messages', () => {
  beforeEach(() => { sock.sent.length = 0; db.patchGroup(G, { auto_reply: true }); db.setSetting('cooldown_minutes', 3); });

  test('one combined reply; every product + unknown item saved as one enquiry', async () => {
    const who = newSender();
    await handleMessage(waMessage('Need rates:\n1. PA korea 2 MT\n2. MA china 5 MT\n3. IPA 20 drums\n4. DOP 1 tanker', { from: who, id: 'LIST1' }));
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /Quotation for 3 products/);
    const rows = db.listInquiries({ status: 'all', batch: 'LIST1' });
    assert.equal(rows.length, 4);
    assert.ok(rows.every(r => r.batch_size === 4));
    assert.deepEqual(rows.filter(r => r.chemical_name).map(r => `${r.chemical_name}:${r.quantity}`).sort(),
      ['Isopropyl Alcohol:20 DRUMS', 'Maleic Anhydride:5 MT', 'Phthalic Anhydride:2 MT']);
    assert.equal(rows.find(r => !r.chemical_name).requested_text, 'DOP');
    assert.equal(db.getGroup(G).quotes_sent > 0, true);
  });
  test('repeat of the same list is held back; a list with a new product is answered', async () => {
    const who = newSender();
    await handleMessage(waMessage('Need PA 2 MT, MA 5 MT', { from: who }));
    await handleMessage(waMessage('Need PA 2 MT, MA 5 MT', { from: who }));
    assert.equal(sock.sent.length, 1);
    await handleMessage(waMessage('Need PA 2 MT, MSG 1 ton', { from: who }));
    assert.equal(sock.sent.length, 2);
  });
  test('only unknown products → no quote, recorded as Unmatched', async () => {
    const before = db.inquiryStats().unmatched;
    await handleMessage(waMessage('Need:\n- DOP 1 tanker\n- DBP 2 drums', { from: newSender() }));
    assert.equal(sock.sent.length, 0);
    assert.equal(db.inquiryStats().unmatched, before + 2);
  });
});

describe('owner reply from the Orders screen', () => {
  test('sent to the group, quoting the customer', async () => {
    sock.sent.length = 0;
    const inq = db.listInquiries({ status: 'all' }).find(r => r.chemical_name);
    await sendOwnerMessage(inq, 'Confirmed ✅');
    assert.deepEqual(sock.sent[0], { jid: inq.group_jid, text: 'Confirmed ✅', quoted: true });
  });
});

describe('join-link rotation', () => {
  test('bot not admin → clear error saved on the group', async () => {
    const g = await rotateInvite(G);
    assert.match(g.invite_error, /must be an admin/);
  });
  test('bot is admin → new invite code saved', async () => {
    sock.groupRevokeInvite = async () => 'NEWCODE123';
    const g = await rotateInvite(G);
    assert.equal(g.invite_code, 'NEWCODE123');
    assert.equal(g.invite_error, null);
  });
});

describe('unlink', () => {
  for (const [mode, confirmed] of [['ack', true], ['close', true], ['silent', false]]) {
    test(`WhatsApp ${mode === 'ack' ? 'confirms' : mode === 'close' ? 'confirms by closing' : 'does not answer'}`, async () => {
      link();
      sock = fakeSocket({ unlink: mode }); wa.sock = sock;
      const r = await logoutWhatsApp();
      assert.equal(r.confirmed, confirmed);
      assert.equal(sock.queries[0].content[0].tag, 'remove-companion-device');
      assert.ok(sock.ended, 'connection closed');
      assert.equal(wa.status, 'logged_out');
      assert.equal(db.currentAccount(), '', 'groups hidden after unlink');
      assert.deepEqual(db.listGroups(), []);
      if (!confirmed) assert.ok(r.reason);
    });
  }
  test('not connected → tells the owner to remove it on the phone', async () => {
    wa.sock = null; wa.status = 'connecting';
    const r = await logoutWhatsApp();
    assert.equal(r.confirmed, false);
    assert.match(r.reason, /not connected/);
  });
});
