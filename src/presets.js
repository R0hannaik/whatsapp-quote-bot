// Default reply templates and quick presets. WhatsApp formatting: *bold* _italic_ ~strike~ ```mono```
// Any line containing a variable that resolves to empty is removed automatically.

const DIV = '━━━━━━━━━━━━━━━━';

export const DEFAULT_TEMPLATES = {
  quote: `*{business_name}*
📦 *Product:* {product_name}
{rate_details}
📦 *Packaging:* {packaging}
📍 *Location:* {location}
✅ *Status:* {status}
{requirement}
${DIV}
_Rates subject to day-to-day market changes. For booking confirmation or orders, please connect directly._
*{business_name}* | 📞 {contact_phone}`,

  deal: `*{business_name}* 🤝
Thank you for your interest in *{product_name}*.
{rate_details}
{requirement}
📦 {packaging} | 📍 {location}
${DIV}
_For volume pricing and best-rate discussion, our team will confirm the final price with you personally._
📞 *Call / WhatsApp:* {contact_phone}`,
};

// Multi-product enquiries ("PA 2 MT, MA 5 MT, IPA 20 drums") get ONE message:
// the Multi-Product template wraps {items}, and every product is rendered with the Product Block template.
DEFAULT_TEMPLATES.multi = `*{business_name}* — Quotation for {item_count} products
${DIV}
{items}
{unavailable}
{deal_note}
${DIV}
_Rates subject to day-to-day market changes. For booking confirmation or orders, please connect directly._
*{business_name}* | 📞 {contact_phone}`;
DEFAULT_TEMPLATES.multi_item = `*{n}. {product_name}*
{rate_details}
📦 {packaging} · 📍 {location} · ✅ {status}
{requirement}`;

export const PRESETS = {
  quote: [
    { id: 'minimal', label: '⚡ Minimalist Broker', body: `*{product_name}*
{rate_details}
{packaging} · {location} · {status}
{requirement}
📞 {contact_phone}` },
    { id: 'standard', label: '🏷️ Standard Clean', body: DEFAULT_TEMPLATES.quote },
    { id: 'corporate', label: '📋 Detailed Corporate', body: `*{business_name}* — Price Quotation
${DIV}
*Product:* {product_name}
*Manufacturer / Brand:* {brand}
{rate_details}
*Packaging:* {packaging}
*Dispatch From:* {location}
*Availability:* {status}
{requirement}
*Quoted On:* {date}
${DIV}
_Terms: Ex-godown basis. Taxes extra as applicable. Rates valid for the day and subject to stock confirmation. Orders are confirmed only after written approval from our team._
*{business_name}* | 📞 {contact_phone}` },
  ],
  deal: [
    { id: 'minimal', label: '⚡ Minimalist Broker', body: `*{product_name}* 🤝
{rate_details}
{requirement}
Best rate on call 👉 {contact_phone}` },
    { id: 'standard', label: '🏷️ Standard Clean', body: DEFAULT_TEMPLATES.deal },
    { id: 'corporate', label: '📋 Detailed Corporate', body: `*{business_name}* — Commercial Discussion
${DIV}
Dear {sender_name},
Thank you for your enquiry for *{product_name}*.
{rate_details}
{requirement}
*Packaging:* {packaging} | *Dispatch:* {location}
${DIV}
_Indicative rates above. Volume-based pricing, payment terms and delivery schedule will be finalised by our team directly._
*{business_name}* | 📞 {contact_phone}` },
  ],
};

PRESETS.multi = [
  { id: 'minimal', label: '⚡ Minimalist Broker', body: `*Rates* ({item_count} items)
{items}
{unavailable}
_+ GST as applicable_ · 📞 {contact_phone}`, item: `{n}. *{product_name}* — {rate_short}
     Qty: {quantity}` },
  { id: 'standard', label: '🏷️ Standard Clean', body: DEFAULT_TEMPLATES.multi, item: DEFAULT_TEMPLATES.multi_item },
  { id: 'corporate', label: '📋 Detailed Corporate', body: `*{business_name}* — Price Quotation
${DIV}
Dear {sender_name},
Please find our rates for your requirement of {item_count} products:

{items}
{unavailable}
{deal_note}
*Quoted On:* {date}
${DIV}
_Terms: Ex-godown basis. Taxes extra as applicable. Rates valid for the day and subject to stock confirmation. Orders are confirmed only after written approval from our team._
*{business_name}* | 📞 {contact_phone}`, item: `*{n}. {product_name}*
Manufacturer / Brand: {brand}
{rate_details}
Packaging: {packaging} · Dispatch: {location}
Availability: {status}
{requirement}` },
];

export const TEMPLATE_VARIABLES = [
  { key: 'product_name', hint: 'Chemical name + short code' },
  { key: 'rate_details', hint: 'Rate line or rates by origin' },
  { key: 'packaging', hint: 'Packaging' },
  { key: 'location', hint: 'Stock / dispatch location' },
  { key: 'status', hint: 'Stock status' },
  { key: 'requirement', hint: 'Customer qty line (hidden if none)' },
  { key: 'contact_phone', hint: 'Your phone' },
  { key: 'business_name', hint: 'Your business name' },
  { key: 'brand', hint: 'Manufacturer / brand' },
  { key: 'customer_location', hint: 'Delivery place from message' },
  { key: 'sender_name', hint: 'WhatsApp name of the asker' },
  { key: 'date', hint: "Today's date" },
  { key: 'rate_short', hint: 'One-line rate, e.g. Korea ₹110 · China ₹138 /kg' },
  { key: 'quantity', hint: 'Quantity asked for this product, e.g. 2 MT' },
];

// Extra variables available only in the Multi-Product templates
export const MULTI_VARIABLES = [
  { key: 'items', hint: 'All product blocks (uses the Product Block template)', for: 'multi' },
  { key: 'item_count', hint: 'Number of products quoted', for: 'multi' },
  { key: 'unavailable', hint: 'Items not in your list — "Will check & revert" (hidden if none)', for: 'multi' },
  { key: 'deal_note', hint: 'Shown only when the buyer is negotiating', for: 'multi' },
  { key: 'n', hint: 'Product number 1, 2, 3…', for: 'multi_item' },
];
export const DEAL_NOTE = '🤝 _For volume / best pricing, our team will call you to finalise the rates._';
