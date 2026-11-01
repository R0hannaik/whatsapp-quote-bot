// Decides what to reply to a message. Used both by the live WhatsApp handler and the dashboard "try a message" preview.
import { analyze, buildIndex } from './parser.js';
import { buildVars, render, quotedRateSummary } from './quote.js';
import { listChemicals, getSettings, getTemplates } from './db.js';
import { DEAL_NOTE } from './presets.js';
import { aiMatch } from './llm.js';

let cache = { at: 0, chems: [], index: [] };
function catalogue() {
  if (Date.now() - cache.at > 5000) {
    const chems = listChemicals();
    cache = { at: Date.now(), chems, index: buildIndex(chems) };
  }
  return cache;
}
export const invalidateCatalogue = () => { cache.at = 0; };

/**
 * Work out the reply (or replies) for one incoming message.
 * @param {string} text
 * @param {object} o  { senderName, overrides: {quote?, deal?, multi?, multi_item?}, forceMode, useAi }
 *   forceMode ('quote'|'deal'|'multi') is only used by the dashboard preview to show a particular template.
 * @returns {Promise<{analysis, replies: Array<{kind, intent, text, items: Array<{chem, quantity, quotedRate, matchedBy}>}>,
 *   unavailable: Array<{name, quantity, reason}>, unmatchedReply: string|null}>}
 */
export async function planReplies(text, o = {}) {
  const s = getSettings();
  const { chems, index } = catalogue();
  const analysis = analyze(text, chems, {
    index,
    maxLength: Number(s.max_message_length) || 0,
    dealKeywords: s.deal_keywords,
    ignoreKeywords: s.ignore_keywords,
  });

  if (analysis.isRequest && !analysis.items.length && s.ai_enabled && o.useAi !== false && process.env.ANTHROPIC_API_KEY) {
    const ids = await aiMatch(text, chems, s.ai_model);
    analysis.items = ids.map(id => ({ chem: chems.find(c => c.id === id), alias: null, how: 'ai',
      quantity: analysis.quantity, origins: analysis.origins, brands: analysis.brands })).filter(i => i.chem);
    if (analysis.items.length) analysis.unmatchedWorthy = false;
  }

  const templates = { ...getTemplates(), ...(o.overrides || {}) };
  const replies = [];
  const unavailable = [];
  let unmatchedReply = null;

  if (analysis.isRequest) {
    const max = Math.min(Math.max(Number(s.max_products_per_message) || 10, 1), 25);
    const quoted = [];
    for (const item of analysis.items) {
      if (/out of stock/i.test(item.chem.status || '') && !s.quote_out_of_stock) {
        unavailable.push({ name: item.chem.name, quantity: item.quantity, reason: 'out of stock' });
      } else if (quoted.length < max) quoted.push(item);
    }
    for (const u of analysis.unmatchedItems || []) unavailable.push({ name: u.name, quantity: u.quantity, reason: 'not in list' });

    const ctx = item => ({ ...analysis, alias: item.alias, quantity: item.quantity ?? null,
      origins: item.origins ?? analysis.origins, brands: item.brands ?? analysis.brands });
    const meta = item => ({ chem: item.chem, quantity: item.quantity ?? null, quotedRate: quotedRateSummary(item.chem, ctx(item)), matchedBy: item.how });
    const combine = o.forceMode === 'multi' ||
      (!o.forceMode && s.multi_reply_style !== 'separate' && quoted.length >= 1 && quoted.length + unavailable.length >= 2);

    if (quoted.length && combine) {
      // ONE message for the whole list
      const blocks = quoted.map((item, k) => render(templates.multi_item, buildVars(item.chem, ctx(item), s, { sender_name: o.senderName, n: k + 1 })));
      const vars = {
        ...buildVars(quoted[0].chem, {}, s, { sender_name: o.senderName }),
        items: blocks.join('\n\n'),
        item_count: String(quoted.length),
        unavailable: unavailable.length ? `\n❓ *Will check & revert:* ${unavailable.map(u => u.name + (u.quantity ? ` (${u.quantity.text})` : '') + (u.reason === 'out of stock' ? ' – currently out of stock' : '')).join(', ')}` : '',
        deal_note: analysis.intent === 'deal' ? `\n${DEAL_NOTE}` : '',
      };
      replies.push({ kind: 'multi', intent: analysis.intent, text: render(templates.multi, vars), items: quoted.map(meta) });
    } else {
      // one message per product (single-product enquiries, or "separate" style)
      const mode = o.forceMode === 'quote' || o.forceMode === 'deal' ? o.forceMode : analysis.intent;
      for (const item of quoted) {
        const vars = buildVars(item.chem, ctx(item), s, { sender_name: o.senderName });
        replies.push({ kind: 'single', intent: mode, text: render(templates[mode], vars), items: [meta(item)] });
      }
    }

    if (!quoted.length && (analysis.unmatchedWorthy || unavailable.length) && s.reply_unmatched) {
      unmatchedReply = render(s.unmatched_reply, { contact_phone: s.contact_phone, business_name: s.business_name });
    }
  }
  return { analysis, replies, unavailable, unmatchedReply };
}

/** JSON-safe summary of an analysis for the dashboard. */
export function describe(analysis) {
  return {
    isRequest: analysis.isRequest,
    skipReason: analysis.skipReason,
    intent: analysis.intent,
    chemicals: analysis.items.map(i => ({ id: i.chem.id, name: i.chem.name, alias: i.alias, how: i.how,
      quantity: i.quantity?.text || null, origins: i.origins || [], brands: i.brands || [] })),
    unmatchedItems: (analysis.unmatchedItems || []).map(u => ({ name: u.name, quantity: u.quantity?.text || null })),
    quantity: analysis.quantity?.text || null,
    location: analysis.location,
    origins: analysis.origins,
    brands: analysis.brands,
    unmatchedWorthy: !!analysis.unmatchedWorthy,
  };
}
