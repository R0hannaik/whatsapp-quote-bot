// Optional: when the rule-based parser sees a buy request but can't match a chemical (odd spelling,
// trade name not in aliases), ask Claude to map it to your catalogue. Enabled only when ANTHROPIC_API_KEY
// is set and "AI fallback" is switched on in Settings. Returns chemical ids or [] — never invents prices.

export async function aiMatch(text, chemicals, model = 'claude-haiku-5-5') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  const catalogue = chemicals.filter(c => c.active !== false)
    .map(c => `${c.id}: ${c.name} | aliases: ${(c.alias_list || []).join(', ')}`).join('\n');
  const prompt = `You map WhatsApp chemical-trading messages (English/Hindi/Hinglish, abbreviations, typos) to a product catalogue.
Catalogue (id: name | aliases):
${catalogue}

Message: """${text.slice(0, 600)}"""

Reply with JSON only: {"ids":[<catalogue ids the sender wants to BUY or get a rate for>]}. Use [] if none clearly match or if the sender is offering/selling.`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(t);
    if (!res.ok) { console.warn('[ai] HTTP', res.status, (await res.text()).slice(0, 200)); return []; }
    const data = await res.json();
    const out = (data.content || []).map(b => b.text || '').join('');
    const m = out.match(/\{[\s\S]*\}/);
    const ids = m ? JSON.parse(m[0]).ids : [];
    const valid = new Set(chemicals.map(c => c.id));
    return (Array.isArray(ids) ? ids : []).map(Number).filter(id => valid.has(id));
  } catch (e) {
    console.warn('[ai] match failed:', e.message);
    return [];
  }
}
