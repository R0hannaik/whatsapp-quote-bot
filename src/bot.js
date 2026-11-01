// Decides what to reply to a message. Used both by the live WhatsApp handler and the dashboard "try a message" preview.
import { analyze, buildIndex } from './parser.js';
import { buildVars, render, quotedRateSummary } from './quote.js';
import { listChemicals, getSettings, getTemplates } from './db.js';
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
 * @param {string} text
 * @param {object} o  { senderName, templateOverride: {mode, body}, useAi }
 * @returns {Promise<{analysis, replies: Array<{chem, intent, text, quotedRate}>, unmatchedReply: string|null}>}
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
    analysis.items = ids.map(id => ({ chem: chems.find(c => c.id === id), alias: null, how: 'ai' })).filter(i => i.chem);
    if (analysis.items.length) analysis.unmatchedWorthy = false;
  }

  const templates = getTemplates();
  const replies = [];
  if (analysis.isRequest) {
    for (const item of analysis.items.slice(0, Number(s.max_chemicals_per_message) || 3)) {
      const chem = item.chem;
      if (/out of stock/i.test(chem.status || '') && !s.quote_out_of_stock) continue;
      const mode = analysis.intent;
      const body = o.templateOverride && o.templateOverride.mode === mode ? o.templateOverride.body : templates[mode];
      const vars = buildVars(chem, { ...analysis, alias: item.alias, quantity: item.quantity ?? analysis.quantity }, s, { sender_name: o.senderName });
      replies.push({ chem, intent: mode, quantity: item.quantity ?? analysis.quantity, text: render(body, vars), quotedRate: quotedRateSummary(chem, analysis), matchedBy: item.how });
    }
  }
  const unmatchedReply = analysis.isRequest && !analysis.items.length && analysis.unmatchedWorthy && s.reply_unmatched
    ? render(s.unmatched_reply, { contact_phone: s.contact_phone, business_name: s.business_name }) : null;
  return { analysis, replies, unmatchedReply };
}

/** JSON-safe summary of an analysis for the dashboard. */
export function describe(analysis) {
  return {
    isRequest: analysis.isRequest,
    skipReason: analysis.skipReason,
    intent: analysis.intent,
    chemicals: analysis.items.map(i => ({ id: i.chem.id, name: i.chem.name, alias: i.alias, how: i.how })),
    quantity: analysis.quantity?.text || null,
    location: analysis.location,
    origins: analysis.origins,
    brands: analysis.brands,
    unmatchedWorthy: !!analysis.unmatchedWorthy,
  };
}
