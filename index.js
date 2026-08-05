require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { extractOrderData, generateInvoiceHTML } = require('./order-utils');
const { generateGiftCardHTML } = require('./gift-card-template');
const { buyLabelForOrder, reprintLabelByTracking, quoteRatesForOrder, voidLabelByTracking, buyLabelWithService } = require('./shipping-label');

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  shopify: {
    token: process.env.SHOPIFY_API_TOKEN,
    store: process.env.SHOPIFY_STORE_URL,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET
  },
  printNode: {
    apiKey: process.env.PRINTNODE_API_KEY,
    invoicePrinterId: process.env.PRINTNODE_INVOICE_PRINTER_ID,
    giftCardPrinterId: process.env.PRINTNODE_GIFTCARD_PRINTER_ID,
    labelPrinterId: process.env.PRINTNODE_LABEL_PRINTER_ID
  },
  labelAutoPrint: ['on', 'true', 'yes', '1'].indexOf((process.env.LABEL_AUTO_PRINT || '').trim().toLowerCase()) > -1
};

// Only auto-print a label for real outbound shipments (not in-store, pickup, or local delivery).
var labeledOrderIds = {};
function shouldAutoLabel(order) {
  if (!CONFIG.labelAutoPrint) return false;
  if ((order.financial_status || '') !== 'paid') return false;
  if (isInStoreOrder(order)) return false;
  var sl = order.shipping_lines && order.shipping_lines[0];
  if (!sl || !sl.title) return false;
  var t = sl.title.toLowerCase();
  if (t.indexOf('local delivery') > -1 || t.indexOf('pick up') > -1 || t.indexOf('pickup') > -1) return false;
  return true;
}

// Fire the shipping label once per order (from whichever webhook is active: create OR paid).
async function maybeAutoLabel(order) {
  if (!shouldAutoLabel(order) || labeledOrderIds[order.id]) return;
  labeledOrderIds[order.id] = true;
  try {
    await printShippingLabel(order);
  } catch (labelErr) {
    console.error('Auto-label error for', order.name, '-', labelErr.message);
    try {
      var orderName = order.name || ('#' + order.order_number);
      var html = '<div style="font-family:Arial,sans-serif;padding:40px;border:6px solid #000;margin:30px">' +
        '<div style="font-size:34px;font-weight:800">&#9888; LABEL FAILED &mdash; BUY MANUALLY</div>' +
        '<div style="font-size:26px;margin-top:14px">Order ' + orderName + '</div>' +
        '<div style="font-size:20px;margin-top:18px">' + labelErr.message + '</div></div>';
      var pdf = await htmlToPdfBase64(html);
      await sendToPrintNode(pdf, CONFIG.printNode.invoicePrinterId, 'LABEL FAILED ' + orderName);
    } catch (e2) { console.error('  failure-alert print failed:', e2.message); }
  }
}

console.log('=== Sweet Tooth Printer Starting ===');
console.log('Invoice Printer ID:', CONFIG.printNode.invoicePrinterId || 'NOT SET');
console.log('Gift Card Printer ID:', CONFIG.printNode.giftCardPrinterId || 'NOT SET');
console.log('Shopify Store:', CONFIG.shopify.store || 'NOT SET');
console.log('=====================================');

var recentOrders = [];
var MAX_ORDERS = 250;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/sticker-files', express.static(__dirname + '/sticker-files'));

function verifyShopifyWebhook(req) {
  var hmac = req.get('X-Shopify-Hmac-Sha256');
  var hash = crypto.createHmac('sha256', CONFIG.shopify.webhookSecret).update(req.body, 'utf8').digest('base64');
  return hmac === hash;
}

async function htmlToPdfBase64(html, options) {
  options = options || {};
  var browser = await puppeteerCore.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
  var page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  var pdfOptions = { printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } };
  if (options.width && options.height) {
    pdfOptions.width = options.width;
    pdfOptions.height = options.height;
  } else {
    pdfOptions.format = 'Letter';
  }
  var pdfBuffer = await page.pdf(pdfOptions);
  await browser.close();
  return pdfBuffer.toString('base64');
}

async function giftCardToPdfBase64(html) {
  return htmlToPdfBase64(html, { width: '4.15in', height: '8.5in' });
}

async function sendToPrintNode(pdfBase64, printerId, title, jobOptions) {
  console.log('Sending to PrintNode - Printer:', printerId, 'Title:', title);
  var job = { printerId: parseInt(printerId), title: title, contentType: 'pdf_base64', content: pdfBase64, source: 'Sweet Tooth Order Printer' };
  if (jobOptions) { job.options = jobOptions; }
  var response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(job)
  });
  if (!response.ok) {
    var errorText = await response.text();
    console.log('PrintNode ERROR:', response.status, errorText);
    throw new Error('PrintNode error: ' + response.status);
  }
  var result = await response.json();
  console.log('PrintNode SUCCESS - Job ID:', result);
  return result;
}

// PrintNode reports a printer's live state ("online" when the PC + printer are connected & ready).
async function printerState(printerId) {
  try {
    var r = await fetch('https://api.printnode.com/printers/' + printerId, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64') }
    });
    if (!r.ok) return 'unknown';
    var arr = await r.json();
    var p = Array.isArray(arr) ? arr[0] : arr;
    return (p && p.state) ? p.state : 'unknown';
  } catch (e) { return 'error'; }
}

// Orders whose label was sent while the printer was NOT online (so it may not have come out).
var queuedWhileOffline = {};

function isInStoreOrder(order) {
  var sourceName = (order.source_name || '').toLowerCase();
  return sourceName === 'pos' || sourceName === 'shopify_pos' || sourceName.indexOf('pos') > -1;
}

async function printOrder(order) {
  var orderName = order.name || ('#' + order.order_number);
  console.log('');
  console.log('========== PROCESSING ORDER:', orderName, '==========');
  console.log('Source:', order.source_name);

  try {
    var orderData = extractOrderData(order);
    console.log('Delivery Type:', orderData.deliveryType);
    console.log('Gift Message:', orderData.giftMessage ? orderData.giftMessage.substring(0, 50) + '...' : 'NONE');

    recentOrders.unshift({ order: order, data: orderData, timestamp: new Date() });
    if (recentOrders.length > MAX_ORDERS) recentOrders.pop();

    if (CONFIG.printNode.invoicePrinterId) {
      console.log('Printing invoice...');
      var invoiceHTML = generateInvoiceHTML(orderData);
      var invoicePdf = await htmlToPdfBase64(invoiceHTML);
      await sendToPrintNode(invoicePdf, CONFIG.printNode.invoicePrinterId, 'Invoice ' + orderName);
      console.log('✓ Invoice sent to printer');
    } else {
      console.log('✗ Invoice printer not configured!');
    }

    if (orderData.giftMessage && orderData.giftMessage.trim() && !isInStoreOrder(order)) {
      if (CONFIG.printNode.giftCardPrinterId) {
        console.log('Printing gift card...');
        var giftCardHTML = generateGiftCardHTML(orderData);
        var giftCardPdf = await giftCardToPdfBase64(giftCardHTML);
        await sendToPrintNode(giftCardPdf, CONFIG.printNode.giftCardPrinterId, 'Gift Card ' + orderName);
        console.log('✓ Gift card sent to printer');
      } else {
        console.log('✗ Gift card printer not configured!');
      }
    } else if (isInStoreOrder(order)) {
      console.log('⊘ In-store order — skipping gift card');
    } else {
      console.log('⊘ No gift message — skipping gift card');
    }

    console.log('========== DONE:', orderName, '==========');
    return { success: true };
  } catch (error) {
    console.error('ERROR processing order:', orderName, error.message);
    return { success: false, error: error.message };
  }
}

// ============ SHOPIFY WEBHOOKS ============

app.post('/webhook/orders/create', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.log('Webhook verification failed');
      return res.status(401).send('Unauthorized');
    }
    var order = JSON.parse(req.body);
    console.log('Webhook received: orders/create for', order.name);
    res.status(200).send('OK');
    await printOrder(order);
    await maybeAutoLabel(order);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(200).send('OK');
  }
});

app.post('/webhook/orders/paid', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Unauthorized');
    }
    var order = JSON.parse(req.body);
    console.log('Webhook received: orders/paid for', order.name);
    res.status(200).send('OK');
    var exists = recentOrders.find(function(o) { return o.order.id === order.id; });
    if (!exists) {
      await printOrder(order);
    } else {
      console.log('Order already processed, skipping');
    }
    await maybeAutoLabel(order);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(200).send('OK');
  }
});

// ============ FETCH ORDER FROM SHOPIFY ============

async function fetchOrderFromShopify(orderId) {
  var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + orderId + '.json';
  var response = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error('Shopify API error: ' + response.status);
  var data = await response.json();
  return data.order;
}

async function searchShopifyOrders(query) {
  var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=50&name=' + encodeURIComponent(query);
  var response = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error('Shopify API error: ' + response.status);
  var data = await response.json();
  return data.orders || [];
}

// ============ SHIPPING LABEL (separate flow — Shippo -> PrintNode 4x6) ============
// Buys the label for the service the customer chose and prints it on the label printer.
// Completely separate from invoice/gift-card printing.
async function printShippingLabel(order) {
  var orderName = order.name || ('#' + order.order_number);
  if (!CONFIG.printNode.labelPrinterId) throw new Error('Label printer not configured (PRINTNODE_LABEL_PRINTER_ID)');
  var label = await buyLabelForOrder(order);
  if (label.skipped) {
    console.log('⊘ No label for', orderName, '-', label.reason);
    if (label.needsManual) {
      try {
        var alertHtml = '<div style="font-family:Arial,sans-serif;padding:40px;border:6px solid #000;margin:30px">' +
          '<div style="font-size:34px;font-weight:800">&#9888; BUY LABEL MANUALLY</div>' +
          '<div style="font-size:26px;margin-top:14px">Order ' + orderName + '</div>' +
          '<div style="font-size:20px;margin-top:18px;line-height:1.5">' + label.reason + '<br>' +
          'Service: ' + (label.chosenTitle || '') + '<br>' +
          'Ship to: ' + ((order.shipping_address && (order.shipping_address.city + ', ' + order.shipping_address.province_code)) || '') +
          '</div></div>';
        var alertPdf = await htmlToPdfBase64(alertHtml);
        await sendToPrintNode(alertPdf, CONFIG.printNode.invoicePrinterId, 'MANUAL LABEL ' + orderName);
        console.log('  ↳ printed manual-label alert to invoice printer');
      } catch (e) { console.error('  ↳ alert slip failed:', e.message); }
    }
    return label;
  }
  var pstate = await printerState(CONFIG.printNode.labelPrinterId);
  await sendToPrintNode(label.labelBase64, CONFIG.printNode.labelPrinterId, 'Label ' + orderName);
  if (pstate !== 'online') {
    queuedWhileOffline[orderName] = { tracking: label.tracking, printerState: pstate };
    console.log('  ⚠ label sent but printer was', pstate, '- may NOT have printed. Order', orderName, 'tracking', label.tracking);
  }
  console.log('✓ Label printed for', orderName, '-', label.carrier, label.service, '$' + label.amount, 'track', label.tracking, '(printer:', pstate + ')');
  // Write the tracking back to Shopify so the order shows it + the customer is notified once.
  try {
    await writeTrackingToShopify(order, label);
  } catch (twErr) {
    console.error('  tracking write failed for', orderName, '-', twErr.message);
    try {
      var html = '<div style="font-family:Arial,sans-serif;padding:40px;border:6px solid #000;margin:30px">' +
        '<div style="font-size:32px;font-weight:800">&#9888; ADD TRACKING IN SHOPIFY</div>' +
        '<div style="font-size:26px;margin-top:14px">Order ' + orderName + '</div>' +
        '<div style="font-size:22px;margin-top:16px">Tracking: ' + label.tracking + ' (' + label.carrier + ')<br>' +
        'Label printed OK — but Shopify wasn\'t updated. Mark fulfilled with this tracking.</div></div>';
      var pdf = await htmlToPdfBase64(html);
      await sendToPrintNode(pdf, CONFIG.printNode.invoicePrinterId, 'ADD TRACKING ' + orderName);
    } catch (e3) { console.error('  tracking-alert print failed:', e3.message); }
  }
  return label;
}

// Push the carrier tracking onto the Shopify order (fulfills + notifies the customer once).
async function writeTrackingToShopify(order, label) {
  var foRes = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2025-01/orders/' + order.id + '/fulfillment_orders.json',
    { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
  var fos = (await foRes.json()).fulfillment_orders || [];
  var open = fos.filter(function (f) { return f.status === 'open'; }).map(function (f) { return { fulfillment_order_id: f.id }; });
  if (!open.length) { console.log('  no open fulfillment order for', order.name, '- tracking not written'); return; }
  var body = { fulfillment: {
    notify_customer: true,
    tracking_info: { number: label.tracking, company: label.carrier, url: label.trackingUrl || undefined },
    line_items_by_fulfillment_order: open
  } };
  var res = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2025-01/fulfillments.json',
    { method: 'POST', headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  var j = await res.json();
  if (!res.ok || j.errors) throw new Error(JSON.stringify(j.errors || j));
  console.log('  tracking written to Shopify + customer notified:', label.tracking);
}

// Diagnostic: confirms config + that the app is receiving orders. No secrets exposed.
// ============ SUPPLY-RUN ALERTS (strawberries/apples = store run, B&W cookies/rugelach = Sonny's) ============
// Alerts live until someone clicks Got It, which tags the order st_supplies_ok in Shopify —
// so the ack is shared by every device and survives restarts. \bapples?\b avoids matching "pineapple".
var SUPPLY_RULES = [
  { re: /strawberr/i, emoji: '🍓', what: 'Buy FRESH STRAWBERRIES' },
  { re: /\bapples?\b/i, emoji: '🍎', what: 'Buy FRESH APPLES' },
  { re: /black\s*(and|&|'?n'?)\s*white/i, emoji: '🍪', what: "Pick up from SONNY'S BAKERY" },
  { re: /rug[aeu]la/i, emoji: '🥯', what: "Pick up from SONNY'S BAKERY" }
];

function supplyNeedsForOrder(order) {
  var needs = [];
  (order.line_items || []).forEach(function (li) {
    var t = li.title || li.name || '';
    SUPPLY_RULES.forEach(function (r) {
      if (r.re.test(t)) needs.push({ emoji: r.emoji, what: r.what, item: t, qty: li.quantity || 1 });
    });
  });
  return needs;
}

app.get('/dashboard/supply-alerts', async function (req, res) {
  try {
    var since = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
    var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=50&created_at_min=' + encodeURIComponent(since) +
      '&fields=id,name,tags,line_items,note_attributes,created_at,cancelled_at';
    var r = await fetch(url, { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!r.ok) throw new Error('Shopify ' + r.status);
    var alerts = [];
    (((await r.json()).orders) || []).forEach(function (o) {
      if (o.cancelled_at) return;
      if ((o.tags || '').indexOf('st_supplies_ok') > -1) return;
      var needs = supplyNeedsForOrder(o);
      if (!needs.length) return;
      var dd = null;
      (o.note_attributes || []).forEach(function (na) {
        if (/delivery date/i.test(na.name || '')) dd = na.value;
      });
      alerts.push({ id: o.id, name: o.name, deliveryDate: dd, needs: needs });
    });
    res.json({ alerts: alerts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ SHARED POST-IT NOTES + ARCHIVE (stored as shop metafields — shared, durable) ============
async function shopJsonRead(key) {
  var r = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/metafields.json?namespace=st_dashboard&key=' + key,
    { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
  var m = (((await r.json()) || {}).metafields || [])[0];
  if (!m) return { id: null, data: null };
  try { return { id: m.id, data: JSON.parse(m.value) }; } catch (e) { return { id: m.id, data: null }; }
}

async function shopJsonWrite(key, data, existingId) {
  var body, url, method;
  if (existingId) {
    url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/metafields/' + existingId + '.json';
    method = 'PUT';
    body = { metafield: { id: existingId, type: 'json', value: JSON.stringify(data) } };
  } else {
    url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/metafields.json';
    method = 'POST';
    body = { metafield: { namespace: 'st_dashboard', key: key, type: 'json', value: JSON.stringify(data) } };
  }
  var r = await fetch(url, { method: method, headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Metafield write failed: ' + r.status + ' ' + JSON.stringify(await r.json()));
}

async function archivePush(entry) {
  var a = await shopJsonRead('postit_archive');
  var list = Array.isArray(a.data) ? a.data : [];
  list.unshift(entry);
  if (list.length > 300) list = list.slice(0, 300);
  await shopJsonWrite('postit_archive', list, a.id);
}

app.get('/dashboard/notes', async function (req, res) {
  try {
    var n = await shopJsonRead('postit_notes');
    res.json({ notes: Array.isArray(n.data) ? n.data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard/notes/add', async function (req, res) {
  try {
    var text = String(req.query.text || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'empty note' });
    var n = await shopJsonRead('postit_notes');
    var list = Array.isArray(n.data) ? n.data : [];
    list.unshift({ id: String(Date.now()), text: text, created: new Date().toISOString() });
    if (list.length > 20) list = list.slice(0, 20);
    await shopJsonWrite('postit_notes', list, n.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard/notes/done', async function (req, res) {
  try {
    var id = String(req.query.id || '');
    var n = await shopJsonRead('postit_notes');
    var list = Array.isArray(n.data) ? n.data : [];
    var note = list.filter(function (x) { return x.id === id; })[0];
    if (!note) return res.json({ ok: true });
    await shopJsonWrite('postit_notes', list.filter(function (x) { return x.id !== id; }), n.id);
    await archivePush({ type: 'note', text: note.text, created: note.created, doneAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard/postit-archive', async function (req, res) {
  try {
    var a = await shopJsonRead('postit_archive');
    var list = Array.isArray(a.data) ? a.data : [];
    var html = '<!DOCTYPE html><html><head><title>Post-it Archive — The Sweet Tooth</title>';
    html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>';
    html += '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:72px 24px 36px}';
    html += '.wrap{max-width:720px;margin:0 auto}' + TOPBAR_CSS;
    html += 'h1{font-size:26px;letter-spacing:-.5px;text-align:center;margin-bottom:24px}';
    html += '.entry{background:#fff;border:1px solid #EFEBED;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.04);padding:14px 18px;margin-bottom:10px;font-size:15px;font-weight:600}';
    html += '.entry .meta{color:#9B8A92;font-size:12.5px;font-weight:700;margin-top:5px}';
    html += '.empty{text-align:center;color:#9B8A92;font-size:15px;font-weight:600;margin-top:40px}';
    html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap"><h1>&#128452;&#65039; Post-it Archive</h1>';
    if (!list.length) html += '<div class="empty">Nothing archived yet. Post-its land here when someone clicks Got It / Done.</div>';
    list.slice(0, 100).forEach(function (e) {
      var icon = e.type === 'supply' ? '&#128722;' : '&#128221;';
      var when = e.doneAt ? new Date(e.doneAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      html += '<div class="entry">' + icon + ' ' + escapeHtml(e.text) + '<div class="meta">done ' + escapeHtml(when) + ' ET</div></div>';
    });
    html += '</div></body></html>';
    res.send(html);
  } catch (e) { res.status(500).send('Archive error: ' + escapeHtml(e.message)); }
});

app.get('/dashboard/supply-alerts/ack', async function (req, res) {
  try {
    var id = String(req.query.id || '').replace(/\D/g, '');
    if (!id) return res.status(400).json({ error: 'missing id' });
    var r = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + id + '.json?fields=id,name,tags,line_items,note_attributes',
      { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var o = ((await r.json()) || {}).order;
    if (!o) return res.status(404).json({ error: 'order not found' });
    var tags = (o.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (tags.indexOf('st_supplies_ok') === -1) tags.push('st_supplies_ok');
    var pr = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + id + '.json', {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: { id: parseInt(id, 10), tags: tags.join(', ') } })
    });
    if (!pr.ok) throw new Error('Shopify ' + pr.status);
    try {
      var needs = supplyNeedsForOrder(o).map(function (x) { return x.what + ': ' + x.item + ' ×' + x.qty; }).join(' · ');
      var dd = null;
      (o.note_attributes || []).forEach(function (na) { if (/delivery date/i.test(na.name || '')) dd = na.value; });
      await archivePush({ type: 'supply', text: (o.name || '#' + id) + ' — ' + needs + (dd ? ' (for ' + dd + ')' : ''), doneAt: new Date().toISOString() });
    } catch (ae) { console.error('archive push failed:', ae.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard/label-status', async function (req, res) {
  var tok = process.env.SHIPPO_API_TOKEN || '';
  var canFulfill = null, fulfillScopes = null;
  try {
    var sr = await fetch('https://' + CONFIG.shopify.store + '/admin/oauth/access_scopes.json',
      { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var handles = ((await sr.json()).access_scopes || []).map(function (s) { return s.handle; });
    fulfillScopes = handles.filter(function (h) { return h.indexOf('fulfillment') > -1; });
    canFulfill = fulfillScopes.indexOf('write_merchant_managed_fulfillment_orders') > -1
      || fulfillScopes.indexOf('write_assigned_fulfillment_orders') > -1;
  } catch (e) { canFulfill = 'error: ' + e.message; }
  res.json({
    labelAutoPrint: CONFIG.labelAutoPrint,
    labelPrinterIdSet: !!CONFIG.printNode.labelPrinterId,
    shippoTokenSet: !!tok,
    shippoMode: tok.indexOf('shippo_live_') === 0 ? 'LIVE' : (tok.indexOf('shippo_test_') === 0 ? 'TEST' : 'unknown'),
    canWriteTrackingToShopify: canFulfill,
    fulfillmentScopes: fulfillScopes,
    labelPrinterState: await printerState(CONFIG.printNode.labelPrinterId),
    queuedWhilePrinterOffline: Object.keys(queuedWhileOffline).length ? queuedWhileOffline : 'none',
    ordersSeenInMemory: recentOrders.length,
    recentOrderNames: recentOrders.slice(0, 8).map(function (o) { return o.order.name; }),
    labelsAttempted: Object.keys(labeledOrderIds).length
  });
});

// Deep PrintNode diagnostic: printer + computer state, and recent print jobs with their states.
app.get('/dashboard/printnode-debug', async (req, res) => {
  try {
    var auth = 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64');
    var pr = await fetch('https://api.printnode.com/printers/' + CONFIG.printNode.labelPrinterId, { headers: { Authorization: auth } });
    var parr = await pr.json(); var p = Array.isArray(parr) ? parr[0] : parr;
    var jr = await fetch('https://api.printnode.com/printjobs?limit=15', { headers: { Authorization: auth } });
    var jobs = await jr.json();
    res.json({
      labelPrinter: p ? {
        name: p.name, state: p.state,
        computer: p.computer ? { name: p.computer.name, state: p.computer.state } : null
      } : 'not found',
      recentJobs: (Array.isArray(jobs) ? jobs : []).map(function (j) {
        return { id: j.id, title: j.title, state: j.state, printer: j.printer && j.printer.name, created: j.createTimestamp };
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reprint an ALREADY-BOUGHT label to the label printer (no re-charge). Use this instead of
// print-label when a label was bought but didn't physically print. Pass the order number, e.g. /dashboard/reprint/36226
app.get('/dashboard/reprint/:name', async (req, res) => {
  try {
    var orders = await searchShopifyOrders(req.params.name);
    var order = orders && orders[0];
    if (!order) return res.status(404).send('Order ' + req.params.name + ' not found');
    var trk = null;
    (order.fulfillments || []).forEach(function (f) { if (f.tracking_number) trk = f.tracking_number; });
    if (!trk) return res.status(400).send('No tracking on ' + order.name + ' — no bought label to reprint. Use /dashboard/print-label to buy one.');
    var lab = await reprintLabelByTracking(trk);
    var pstate = await printerState(CONFIG.printNode.labelPrinterId);
    await sendToPrintNode(lab.labelBase64, CONFIG.printNode.labelPrinterId, 'REPRINT ' + order.name);
    if (order.name) delete queuedWhileOffline[order.name];
    res.send('<p style="font:16px sans-serif">Re-sent label <b>' + trk + '</b> for ' + order.name + ' to the printer — <b>no charge</b>.<br>Printer state: <b>' + pstate + '</b>' +
      (pstate !== 'online' ? ' ⚠️ printer looks OFFLINE — it will print once it reconnects.' : ' ✓') + '</p>');
  } catch (e) { res.status(500).send('<p style="font:16px sans-serif;color:#b00">Reprint error: ' + e.message + '</p>'); }
});

// Manual trigger: open in browser to buy+print a label for one order.
app.get('/dashboard/print-label/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var label = await printShippingLabel(order);
    res.send('<p style="font:16px sans-serif">✓ Label printing: ' + label.carrier + ' ' +
      (label.service || '') + ' — $' + label.amount + '<br>Tracking: ' + label.tracking + '</p>');
  } catch (e) {
    res.status(500).send('<p style="font:16px sans-serif;color:#b00">Label error: ' + e.message + '</p>');
  }
});

// ============ HELPER: Always load orders from Shopify + merge with webhook memory ============

async function loadAllRecentOrders() {
  var shopifyOrders = [];
  try {
    var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=50';
    var response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }
    });
    if (response.ok) {
      var data = await response.json();
      shopifyOrders = data.orders || [];
    }
  } catch (e) {
    console.log('Error fetching Shopify orders:', e.message);
  }

  var mergedMap = {};
  for (var i = 0; i < shopifyOrders.length; i++) {
    var od = extractOrderData(shopifyOrders[i]);
    mergedMap[shopifyOrders[i].id] = { order: shopifyOrders[i], data: od, timestamp: new Date(shopifyOrders[i].created_at) };
  }
  for (var j = 0; j < recentOrders.length; j++) {
    var ro = recentOrders[j];
    if (!mergedMap[ro.order.id]) {
      mergedMap[ro.order.id] = ro;
    }
  }

  var merged = Object.values(mergedMap);
  merged.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });

  recentOrders = merged.slice(0, MAX_ORDERS);

  return merged;
}

// ============ DASHBOARD - GIFT CARDS ============

app.get('/dashboard', async (req, res) => {
  try {
    var allOrders = await loadAllRecentOrders();
    var giftOrders = allOrders.filter(function(o) { return o.data.giftMessage && o.data.giftMessage.trim(); });

    var orderCards = '';
    for (var j = 0; j < giftOrders.length; j++) {
      var o = giftOrders[j];
      var msg = o.data.giftMessage.length > 80 ? o.data.giftMessage.substring(0, 80) + '...' : o.data.giftMessage;
      orderCards += '<div class="order-card"><div class="order-num">' + o.data.orderNumber + '</div><div class="order-detail">To: ' + o.data.giftReceiver + '</div><div class="order-detail">From: ' + o.data.giftSender + '</div><div class="order-msg">"' + msg + '"</div><div class="order-actions"><a href="/dashboard/print-custom/' + o.order.id + '" class="btn btn-print">Edit & Print</a></div></div>';
    }

    if (!orderCards) orderCards = '<p style="text-align:center;color:#999;padding:40px;">No gift card orders found. New orders with gift messages will appear here.</p>';

    res.send('<!DOCTYPE html><html><head><title>Gift Card Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.header h1{font-size:24px}.nav-links a{margin-left:12px;padding:8px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600}.nav-links a.secondary{background:#fff;color:#000;border:2px solid #000}.search-bar{margin-bottom:20px}.search-bar form{display:flex;gap:8px}.search-bar input{flex:1;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px}.search-bar input:focus{outline:none;border-color:#000}.order-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.order-card{background:#fff;border:2px solid #eee;border-radius:12px;padding:16px;transition:border-color 0.2s}.order-card:hover{border-color:#000}.order-num{font-size:18px;font-weight:800;margin-bottom:8px}.order-detail{font-size:13px;margin-bottom:4px;color:#333}.order-msg{font-size:12px;font-style:italic;margin:8px 0;padding:8px;background:#f9f9f9;border-radius:6px;color:#555}.order-actions{margin-top:12px}.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}.btn-print{background:#000;color:#fff}.tab-nav{display:flex;gap:0;margin-bottom:20px;align-items:center}.tab{padding:10px 24px;text-decoration:none;font-size:15px;font-weight:700;border-radius:0}.tab:first-child{border-radius:8px 0 0 8px}.tab:last-child{border-radius:0 8px 8px 0}.tab-active{background:#22c55e;color:#fff;border:2px solid #22c55e}.tab-inactive{background:#fff;color:#999;border:2px solid #ddd}.btn-new{margin-left:auto;padding:10px 20px;background:#f59e0b;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700}</style></head><body><div class="tab-nav"><a href="/dashboard/invoices" class="tab tab-inactive">📋 Invoices</a><a href="/dashboard" class="tab tab-active">🎁 Gift Cards</a><a href="/dashboard/gift-card-new" class="btn-new">✨ Create New Card</a><a href="/dashboard/test-card" class="btn-new" style="background:#6366f1;margin-left:8px">🧪 Test Card</a></div><div class="search-bar"><form action="/dashboard/search" method="get"><input type="text" name="q" id="search" placeholder="Search orders..." oninput="filterOrders()"></form></div><div class="order-grid" id="orderGrid">' + orderCards + '</div><script>function filterOrders(){var q=document.getElementById("search").value.toLowerCase();if(!q){document.querySelectorAll(".order-card").forEach(function(c){c.style.display=""});return}var cards=document.querySelectorAll(".order-card");cards.forEach(function(c){c.style.display=c.textContent.toLowerCase().indexOf(q)>-1?"":"none"})}</script></body></html>');
  } catch (error) {
    res.status(500).send('Error loading dashboard: ' + error.message);
  }
});

// ============ DASHBOARD - INVOICES ============

app.get('/dashboard/invoices', async (req, res) => {
  try {
    var allOrders = await loadAllRecentOrders();

    var orderCards = '';
    for (var j = 0; j < allOrders.length; j++) {
      var o = allOrders[j];
      var hasGift = o.data.giftMessage && o.data.giftMessage.trim() ? '<span style="display:inline-block;background:#000;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px">🎁 GIFT</span>' : '';
      orderCards += '<div class="order-card"><div class="order-num">' + o.data.orderNumber + hasGift + '</div><div class="order-detail"><strong>' + o.data.deliveryType.toUpperCase() + '</strong> — ' + o.data.recipient.name + '</div><div class="order-detail">' + o.data.deliveryDate + '</div><div class="order-detail">' + o.data.items.length + ' item(s)</div><div class="order-actions"><a href="/dashboard/invoice-edit/' + o.order.id + '" class="btn btn-edit">✏️ Edit &amp; Print</a> <a href="/dashboard/reprint-invoice/' + o.order.id + '" class="btn btn-print">Reprint</a></div></div>';
    }

    if (!orderCards) orderCards = '<p style="text-align:center;color:#999;padding:40px;">No orders found. Orders will appear here as they come in.</p>';

    res.send('<!DOCTYPE html><html><head><title>Invoice Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.header h1{font-size:24px}.nav-links a{margin-left:12px;padding:8px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600}.nav-links a.secondary{background:#fff;color:#000;border:2px solid #000}.search-bar{margin-bottom:20px}.search-bar form{display:flex;gap:8px}.search-bar input{flex:1;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px}.search-bar input:focus{outline:none;border-color:#000}.order-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.order-card{background:#fff;border:2px solid #eee;border-radius:12px;padding:16px;transition:border-color 0.2s}.order-card:hover{border-color:#000}.order-num{font-size:18px;font-weight:800;margin-bottom:8px}.order-detail{font-size:13px;margin-bottom:4px;color:#333}.order-actions{margin-top:12px;display:flex;gap:8px}.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}.btn-edit{background:#22c55e;color:#fff;border:none}.btn-view{background:#fff;color:#000;border:2px solid #000}.btn-print{background:#000;color:#fff}.tab-nav{display:flex;gap:0;margin-bottom:20px}.tab{padding:10px 24px;text-decoration:none;font-size:15px;font-weight:700;border-radius:0}.tab:first-child{border-radius:8px 0 0 8px}.tab:last-child{border-radius:0 8px 8px 0}.tab-active{background:#22c55e;color:#fff;border:2px solid #22c55e}.tab-inactive{background:#fff;color:#999;border:2px solid #ddd}</style></head><body><div class="tab-nav"><a href="/dashboard/invoices" class="tab tab-active">📋 Invoices</a><a href="/dashboard" class="tab tab-inactive">🎁 Gift Cards</a></div><div class="search-bar"><form action="/dashboard/search" method="get"><input type="text" name="q" id="search" placeholder="Search orders..." oninput="filterOrders()"></form></div><div class="order-grid" id="orderGrid">' + orderCards + '</div><script>function filterOrders(){var q=document.getElementById("search").value.toLowerCase();if(!q){document.querySelectorAll(".order-card").forEach(function(c){c.style.display=""});return}var cards=document.querySelectorAll(".order-card");cards.forEach(function(c){c.style.display=c.textContent.toLowerCase().indexOf(q)>-1?"":"none"})}</script></body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ VIEW INVOICE ============

app.get('/dashboard/invoice-view/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);
    var invoiceHTML = generateInvoiceHTML(orderData);
    res.send('<!DOCTYPE html><html><head><title>Invoice ' + orderData.orderNumber + '</title><style>@media print{.no-print{display:none!important}body{margin:0;padding:0;padding-top:0}@page{margin:0}}.screen-spacer{height:70px}@media print{.screen-spacer{display:none}}</style></head><body><div class="no-print" style="position:fixed;top:20px;left:20px;z-index:1000;display:flex;gap:10px"><a href="/dashboard/invoices" style="background:#000;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600">← Back</a><button onclick="window.print()" style="background:#4CAF50;color:#fff;padding:10px 20px;border-radius:6px;font-family:sans-serif;font-size:14px;font-weight:600;border:none;cursor:pointer">🖨 Print</button></div><div class="screen-spacer"></div>' + invoiceHTML + '</body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});


// ============ EDIT INVOICE ============

app.get('/dashboard/invoice-edit/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);
    var invoiceHTML = generateInvoiceHTML(orderData);

    var recipientName = (orderData.recipient.name || '').replace(/"/g, '&quot;');
    var addr1 = (orderData.recipient.address1 || '').replace(/"/g, '&quot;');
    var addr2 = (orderData.recipient.address2 || '').replace(/"/g, '&quot;');
    var city = (orderData.recipient.city || '').replace(/"/g, '&quot;');
    var province = (orderData.recipient.province || '').replace(/"/g, '&quot;');
    var zip = (orderData.recipient.zip || '').replace(/"/g, '&quot;');
    var deliveryDate = (orderData.deliveryDate || '').replace(/"/g, '&quot;');
    var specialInstructions = (orderData.specialInstructions || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    var giftMessage = (orderData.giftMessage || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    var dtChoices = [['pickup', 'Pickup'], ['local-delivery', 'Local Delivery'], ['shipping', 'Shipping'], ['in-store', 'In Store']];
    var dtOptions = '';
    for (var dti = 0; dti < dtChoices.length; dti++) {
      dtOptions += '<option value="' + dtChoices[dti][0] + '"' + (orderData.deliveryType === dtChoices[dti][0] ? ' selected' : '') + '>' + dtChoices[dti][1] + '</option>';
    }

    res.send('<!DOCTYPE html><html><head><title>Edit Invoice ' + orderData.orderNumber + '</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;display:flex;height:100vh}@media print{.no-print{display:none!important}body{display:block;background:white}.editor-panel{display:none}.preview-wrap{padding:0}}' +
      '.editor-panel{width:360px;min-width:360px;background:#fff;border-right:2px solid #eee;padding:20px;overflow-y:auto;flex-shrink:0}' +
      '.preview-wrap{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;align-items:center}' +
      '.editor-panel h2{font-size:18px;font-weight:800;margin-bottom:4px}.order-sub{font-size:12px;color:#888;margin-bottom:16px}' +
      '.field{margin-bottom:12px}.field label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;color:#555}' +
      '.field input,.field textarea,.field select{width:100%;padding:9px 10px;border:2px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit;background:#fff}.field textarea{height:80px;resize:vertical}.field select{cursor:pointer;font-weight:700}' +
      '.section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#999;margin:16px 0 8px;padding-top:12px;border-top:1px solid #eee}' +
      '.btn-row{display:flex;gap:8px;margin-top:20px}.btn{padding:11px 16px;border-radius:8px;font-size:13px;font-weight:700;border:none;cursor:pointer;text-decoration:none;text-align:center;flex:1}' +
      '.btn-green{background:#22c55e;color:#fff}.btn-black{background:#000;color:#fff}.btn-blue{background:#2563eb;color:#fff}.btn-outline{background:#fff;color:#000;border:2px solid #000}' +
      '</style></head><body>' +
      '<div class="editor-panel no-print">' +
        '<h2>Edit Invoice</h2>' +
        '<div class="order-sub">' + orderData.orderNumber + ' &mdash; ' + orderData.deliveryType.toUpperCase() + '</div>' +
        '<div class="section-label">Recipient</div>' +
        '<div class="field"><label>Name</label><input type="text" id="recipientName" value="' + recipientName + '" oninput="refreshPreview()"></div>' +
        '<div class="field"><label>Address Line 1</label><input type="text" id="addr1" value="' + addr1 + '" oninput="refreshPreview()"></div>' +
        '<div class="field"><label>Address Line 2 / Suite</label><input type="text" id="addr2" value="' + addr2 + '" oninput="refreshPreview()"></div>' +
        '<div class="field"><label>City</label><input type="text" id="city" value="' + city + '" oninput="refreshPreview()"></div>' +
        '<div class="field"><label>State</label><input type="text" id="province" value="' + province + '" oninput="refreshPreview()"></div>' +
        '<div class="field"><label>ZIP</label><input type="text" id="zip" value="' + zip + '" oninput="refreshPreview()"></div>' +
        '<div class="section-label">Delivery</div>' +
        '<div class="field"><label>Delivery Type</label><select id="deliveryType" onchange="refreshPreview()">' + dtOptions + '</select></div>' +
        '<div class="field"><label>Delivery Date</label><input type="text" id="deliveryDate" value="' + deliveryDate + '" oninput="refreshPreview()"></div>' +
        '<div class="section-label">Notes</div>' +
        '<div class="field"><label>Special Instructions</label><textarea id="specialInstructions" oninput="refreshPreview()">' + specialInstructions + '</textarea></div>' +
        '<div class="field"><label>Gift Message</label><textarea id="giftMessage" oninput="refreshPreview()">' + giftMessage + '</textarea></div>' +
        '<div class="btn-row"><button class="btn btn-green" onclick="printToPrinter()">🖨 Send to Printer</button></div>' +
        '<div class="btn-row"><button class="btn btn-blue" onclick="saveEdits()">💾 Save Changes</button></div>' +
        '<div id="saveMsg" style="font-size:12px;text-align:center;margin-top:6px;height:18px;color:#22c55e;font-weight:700"></div>' +
        '<div class="btn-row"><button class="btn btn-black" onclick="window.print()">🖥 Browser Print</button><a href="/dashboard/invoices" class="btn btn-outline">← Back</a></div>' +
      '</div>' +
      '<div class="preview-wrap"><iframe id="previewFrame" style="width:8.5in;height:11in;border:1px solid #ccc;background:white;box-shadow:0 4px 20px rgba(0,0,0,0.15)" src="/dashboard/invoice-view/' + order.id + '?noprint=1"></iframe></div>' +
      '<script>' +
        'var debounceTimer;' +
        'function refreshPreview(){clearTimeout(debounceTimer);debounceTimer=setTimeout(doRefresh,600)}' +
        'function getFormData(){return{' +
          'recipientName:document.getElementById("recipientName").value,' +
          'addr1:document.getElementById("addr1").value,' +
          'addr2:document.getElementById("addr2").value,' +
          'city:document.getElementById("city").value,' +
          'province:document.getElementById("province").value,' +
          'zip:document.getElementById("zip").value,' +
          'deliveryType:document.getElementById("deliveryType").value,' +
          'deliveryDate:document.getElementById("deliveryDate").value,' +
          'specialInstructions:document.getElementById("specialInstructions").value,' +
          'giftMessage:document.getElementById("giftMessage").value' +
        '}}' +
        'function doRefresh(){' +
          'var fd=getFormData();' +
          'var params=new URLSearchParams(fd);' +
          'document.getElementById("previewFrame").src="/dashboard/invoice-preview/' + order.id + '?"+params.toString();' +
        '}' +
        'function saveEdits(){' +
          'var fd=getFormData();' +
          'fetch("/dashboard/invoice-save/' + order.id + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(fd)})' +
          '.then(function(r){return r.json()})' +
          '.then(function(d){' +
            'var msg=document.getElementById("saveMsg");' +
            'if(d.success){msg.textContent="✅ Changes saved!";msg.style.color="#22c55e"}' +
            'else{msg.textContent="❌ Save failed: "+d.error;msg.style.color="#ef4444"}' +
            'setTimeout(function(){msg.textContent=""},3000)' +
          '})' +
          '.catch(function(e){var msg=document.getElementById("saveMsg");msg.textContent="Error: "+e.message;msg.style.color="#ef4444"})' +
        '}' +
        'function printToPrinter(){' +
          'var fd=getFormData();' +
          'fetch("/dashboard/invoice-print-edited/' + order.id + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(fd)})' +
          '.then(function(r){return r.json()})' +
          '.then(function(d){if(d.success){alert("✅ Invoice sent to printer!")}else{alert("❌ "+d.error)}})' +
          '.catch(function(e){alert("Error: "+e.message)})' +
        '}' +
      '</script>' +
    '</body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ INVOICE PREVIEW WITH EDITS (for iframe) ============

app.get('/dashboard/invoice-preview/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);

    // Apply overrides from query params
    if (req.query.recipientName !== undefined) orderData.recipient.name = req.query.recipientName;
    if (req.query.addr1 !== undefined) orderData.recipient.address1 = req.query.addr1;
    if (req.query.addr2 !== undefined) orderData.recipient.address2 = req.query.addr2;
    if (req.query.city !== undefined) orderData.recipient.city = req.query.city;
    if (req.query.province !== undefined) orderData.recipient.province = req.query.province;
    if (req.query.zip !== undefined) orderData.recipient.zip = req.query.zip;
    if (req.query.deliveryType) orderData.deliveryType = req.query.deliveryType;
    if (req.query.deliveryDate !== undefined) orderData.deliveryDate = req.query.deliveryDate;
    if (req.query.specialInstructions !== undefined) orderData.specialInstructions = req.query.specialInstructions;
    if (req.query.giftMessage !== undefined) orderData.giftMessage = req.query.giftMessage;

    var invoiceHTML = generateInvoiceHTML(orderData);
    res.send('<!DOCTYPE html><html><head><style>@media print{body{margin:0;padding:0}@page{margin:0}}</style></head><body>' + invoiceHTML + '</body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ PRINT EDITED INVOICE VIA PRINTNODE ============

app.post('/dashboard/invoice-print-edited/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);
    var body = req.body;

    // Apply edits
    if (body.recipientName !== undefined) orderData.recipient.name = body.recipientName;
    if (body.addr1 !== undefined) orderData.recipient.address1 = body.addr1;
    if (body.addr2 !== undefined) orderData.recipient.address2 = body.addr2;
    if (body.city !== undefined) orderData.recipient.city = body.city;
    if (body.province !== undefined) orderData.recipient.province = body.province;
    if (body.zip !== undefined) orderData.recipient.zip = body.zip;
    if (body.deliveryType) orderData.deliveryType = body.deliveryType;
    if (body.deliveryDate !== undefined) orderData.deliveryDate = body.deliveryDate;
    if (body.specialInstructions !== undefined) orderData.specialInstructions = body.specialInstructions;
    if (body.giftMessage !== undefined) orderData.giftMessage = body.giftMessage;

    var invoiceHTML = generateInvoiceHTML(orderData);
    var pdfBase64 = await htmlToPdfBase64(invoiceHTML);
    await sendToPrintNode(pdfBase64, CONFIG.printNode.invoicePrinterId, 'Edited Invoice ' + orderData.orderNumber);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ REPRINT INVOICE VIA PRINTNODE ============

app.get('/dashboard/reprint-invoice/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);
    var invoiceHTML = generateInvoiceHTML(orderData);
    var pdfBase64 = await htmlToPdfBase64(invoiceHTML);
    await sendToPrintNode(pdfBase64, CONFIG.printNode.invoicePrinterId, 'Reprint Invoice ' + orderData.orderNumber);
    res.redirect('/dashboard/invoices');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ GIFT CARD EDITOR & PRINT ============

app.get('/dashboard/print-custom/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);
    var giftMsg = (orderData.giftMessage || '').substring(0, 300);
    var msgLen = giftMsg.length;
    var recipName = (orderData.giftReceiver || orderData.recipient.name || '').replace(/"/g,'&quot;');
    var addr1Val = (orderData.recipient.address1 || '').replace(/"/g,'&quot;');
    var addr2Val = (orderData.recipient.city ? orderData.recipient.city+', '+orderData.recipient.province+' '+orderData.recipient.zip : '').replace(/"/g,'&quot;');
    var senderVal = (orderData.giftSender || '').replace(/"/g,'&quot;');
    var prevName = (orderData.giftReceiver || orderData.recipient.name || '');
    var prevAddr1 = (orderData.recipient.address1 || '');
    var prevAddr2 = (orderData.recipient.city ? orderData.recipient.city+', '+orderData.recipient.province+' '+orderData.recipient.zip : '');
    var prevMsg = giftMsg.replace(/</g,'&lt;');
    var prevSender = (orderData.giftSender || '');

    var html = '<!DOCTYPE html><html><head>';
    html += '<title>Edit Gift Card '+orderData.orderNumber+'</title><meta name="viewport" content="width=device-width,initial-scale=1">';
    html += '<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Dancing+Script:wght@400;700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&family=Great+Vibes&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Raleway:ital,wght@0,400;0,700;1,400;1,700&family=Pacifico&family=EB+Garamond:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">';
    html += '<style>';
    html += '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;display:flex;height:100vh}';
    html += '.editor-panel{width:400px;background:#fff;border-right:2px solid #eee;padding:20px;overflow-y:auto}.preview-panel{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}';
    html += 'h2{font-size:20px;margin-bottom:4px}.sub{font-size:12px;color:#888;margin-bottom:16px}.field{margin-bottom:13px}.field label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;color:#333}.field input,.field textarea{width:100%;padding:9px 10px;border:2px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit}.field textarea{height:90px;resize:vertical}.char-count{font-size:11px;text-align:right;margin-top:2px}.char-count.warn{color:red;font-weight:700}.slider-row{display:flex;align-items:center;gap:8px}.slider-row input[type=range]{flex:1}.slider-val{font-size:12px;font-weight:700;min-width:40px;text-align:right}.btn-row{display:flex;gap:8px;margin-top:12px}.btn{padding:11px 16px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;border:none;cursor:pointer;text-align:center;flex:1;display:flex;align-items:center;justify-content:center}.btn-primary{background:#000;color:#fff}.btn-secondary{background:#fff;color:#000;border:2px solid #000}.card-preview{width:299px;height:612px;background:#fff;border:2px solid #000;position:relative;overflow:hidden}.top-section-preview{position:absolute;left:0;right:0;text-align:center;padding:0 40px}.msg-section-preview{position:absolute;left:0;right:0;text-align:center;padding:0 40px}';
    html += '.fmt-section{margin-bottom:14px}.fmt-label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;color:#333}.fmt-row{display:flex;gap:8px;align-items:center}.fmt-select{width:100%;padding:8px 10px;border:2px solid #ddd;border-radius:6px;font-size:13px;background:#fff;cursor:pointer}.fmt-select:focus{outline:none;border-color:#000}.fmt-size-row{display:flex;align-items:center;gap:8px}.fmt-size-row input[type=range]{flex:1}.fmt-size-val{font-size:13px;font-weight:700;min-width:36px;text-align:right;color:#000}.fmt-toggle-group{display:flex;gap:6px}.fmt-toggle{padding:7px 16px;border:2px solid #ddd;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;background:#fff;color:#555;transition:all 0.15s;line-height:1}.fmt-toggle.active{background:#000;color:#fff;border-color:#000}.fmt-toggle:hover:not(.active){border-color:#999;color:#000}.fmt-divider{border:none;border-top:1px solid #eee;margin:14px 0}';
    html += '@media print{.no-print{display:none!important}body{margin:0;padding:0;background:white;display:block}.editor-panel{display:none}.preview-panel{display:block;padding:0}.card-preview{border:none;width:4.15in;height:8.5in;margin:0;padding:0}@page{size:4.15in 8.5in;margin:0}}';
    html += '</style></head><body>';
    html += '<div class="editor-panel no-print">';
    html += '<h2>Edit Gift Card</h2><div class="sub">'+orderData.orderNumber+'</div>';
    html += '<div class="fmt-section"><span class="fmt-label">Message Font</span><select id="fmtFont" class="fmt-select" onchange="updatePreview()"><option value="Montserrat" style="font-family:Montserrat">Montserrat</option><option value="Playfair Display" style="font-family:Playfair Display">Playfair Display</option><option value="Dancing Script" style="font-family:Dancing Script">Dancing Script</option><option value="Lato" style="font-family:Lato">Lato</option><option value="Cormorant Garamond" style="font-family:Cormorant Garamond">Cormorant Garamond</option><option value="Great Vibes" style="font-family:Great Vibes">Great Vibes</option><option value="Libre Baskerville" style="font-family:Libre Baskerville">Libre Baskerville</option><option value="Raleway" style="font-family:Raleway">Raleway</option><option value="Pacifico" style="font-family:Pacifico">Pacifico</option><option value="EB Garamond" style="font-family:EB Garamond">EB Garamond</option></select></div><div class="fmt-section"><span class="fmt-label">Font Size</span><div class="fmt-size-row"><input type="range" id="fmtSize" min="7" max="18" value="10" step="0.5" oninput="updatePreview()"><span class="fmt-size-val" id="fmtSizeVal">10pt</span></div></div><div class="fmt-section"><span class="fmt-label">Style</span><div class="fmt-toggle-group"><button class="fmt-toggle active" id="toggleBold" data-fmt="bold" onclick="toggleFmt(this.dataset.fmt)"><b>B</b></button><button class="fmt-toggle" id="toggleItalic" data-fmt="italic" onclick="toggleFmt(this.dataset.fmt)"><i>I</i></button></div></div><hr class="fmt-divider">';
    html += '<div class="field"><label>Recipient Name</label><input type="text" id="recipientName" value="'+recipName+'" oninput="updatePreview()"></div>';
    html += '<div class="field"><label>Address Line 1</label><input type="text" id="address1" value="'+addr1Val+'" oninput="updatePreview()"></div>';
    html += '<div class="field"><label>City, State ZIP</label><input type="text" id="address2" value="'+addr2Val+'" oninput="updatePreview()"></div>';
    html += '<div class="field"><label>Gift Message <span id="charCount" class="char-count">'+msgLen+'/300</span></label><textarea id="giftMessage" maxlength="300" oninput="updatePreview()">'+giftMsg.replace(/</g,'&lt;')+'</textarea></div>';
    html += '<div class="field"><label>Sender Name</label><input type="text" id="senderName" value="'+senderVal+'" oninput="updatePreview()"></div>';
    html += '<hr style="margin:12px 0;border:1px solid #eee">';
    html += '<div class="field"><label>Name/Address Position</label><div class="slider-row"><input type="range" id="topPos" min="0" max="150" value="11" oninput="updatePreview()"><span class="slider-val" id="topPosVal">0.15in</span></div></div>';
    html += '<div class="field"><label>Message Position</label><div class="slider-row"><input type="range" id="msgPos" min="280" max="400" value="310" oninput="updatePreview()"><span class="slider-val" id="msgPosVal">4.30in</span></div></div>';
    html += '<div class="btn-row"><button class="btn btn-primary" onclick="printCard()">🖨 Print to Printer</button></div>';
    html += '<div class="btn-row"><button class="btn btn-secondary" onclick="window.print()">🖥 Browser Print</button><a href="/dashboard" class="btn btn-secondary">← Back</a></div>';
    html += '</div>';
    html += '<div class="preview-panel"><p style="font-size:12px;color:#999;margin-bottom:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Live Preview</p>';
    html += '<div class="card-preview" id="cardPreview">';
    html += '<div class="top-section-preview" id="topSection" style="top:0.15in"><div id="prevName" style="font-family:Montserrat,sans-serif;font-size:11.9pt;font-weight:400;margin-bottom:12px">'+prevName+'</div><div id="prevAddr" style="font-family:Montserrat,sans-serif;font-size:9.35pt;font-weight:400;line-height:1.4">'+prevAddr1+(prevAddr2?'<br>'+prevAddr2:'')+'</div></div>';
    html += '<div class="msg-section-preview" id="msgSection" style="top:4.30in"><div id="prevMsg" style="font-family:Montserrat,sans-serif;font-size:10pt;font-weight:700;line-height:1.5">'+prevMsg.replace(/\n/g,'<br>')+'</div><div id="prevSender" style="margin-top:12px;font-family:Montserrat,sans-serif;font-size:10pt;font-weight:700">'+prevSender+'</div></div>';
    html += '<div style="position:absolute;top:74%;left:17%;font-family:Arial,sans-serif;font-size:5pt;color:#888">'+orderData.orderNumber+'</div>';
    html += '</div></div>';
    html += '<script>';
    html += 'var fmtBold=true,fmtItalic=false;';
    html += 'function toggleFmt(t){if(t==="bold"){fmtBold=!fmtBold;document.getElementById("toggleBold").className="fmt-toggle"+(fmtBold?" active":"")}else{fmtItalic=!fmtItalic;document.getElementById("toggleItalic").className="fmt-toggle"+(fmtItalic?" active":"")}updatePreview()}';
    html += 'function getFmtFont(){return document.getElementById("fmtFont").value}';
    html += 'function getFmtSize(){var v=parseFloat(document.getElementById("fmtSize").value);document.getElementById("fmtSizeVal").textContent=v+"pt";return v+"pt"}';
    html += 'function updatePreview(){';
    html += 'var name=document.getElementById("recipientName").value;';
    html += 'var a1=document.getElementById("address1").value;';
    html += 'var a2=document.getElementById("address2").value;';
    html += 'var msg=document.getElementById("giftMessage").value;';
    html += 'var sender=document.getElementById("senderName").value;';
    html += 'var topPx=parseInt(document.getElementById("topPos").value);';
    html += 'var msgPx=parseInt(document.getElementById("msgPos").value);';
    html += 'var topIn=(topPx/72).toFixed(2);var msgIn=(msgPx/72).toFixed(2);';
    html += 'document.getElementById("topPosVal").textContent=topIn+"in";';
    html += 'document.getElementById("msgPosVal").textContent=msgIn+"in";';
    html += 'document.getElementById("topSection").style.top=topIn+"in";';
    html += 'document.getElementById("msgSection").style.top=msgIn+"in";';
    html += 'document.getElementById("prevName").textContent=name;';
    html += 'document.getElementById("prevAddr").innerHTML=a1+(a2?"<br>"+a2:"");';
    html += 'var len=msg.length;var cc=document.getElementById("charCount");cc.textContent=len+"/300";cc.className=len>280?"char-count warn":"char-count";';
    html += 'var fs=getFmtSize();var font=getFmtFont();';
    html += 'var msgEl=document.getElementById("prevMsg");msgEl.style.fontFamily=font+",sans-serif";msgEl.style.fontSize=fs;msgEl.style.fontWeight=fmtBold?"700":"400";msgEl.style.fontStyle=fmtItalic?"italic":"normal";msgEl.style.lineHeight="1.5";msgEl.innerHTML=msg.replace(/\\n/g,"<br>");';
    html += 'var sEl=document.getElementById("prevSender");sEl.textContent=sender;sEl.style.fontFamily=font+",sans-serif";sEl.style.fontSize=fs;sEl.style.fontWeight=fmtBold?"700":"400";sEl.style.fontStyle=fmtItalic?"italic":"normal";';
    html += '}';
    html += 'function printCard(){';
    html += 'var fs=getFmtSize();var font=getFmtFont();';
    html += 'var fd=new FormData();';
    html += 'fd.append("recipientName",document.getElementById("recipientName").value);';
    html += 'fd.append("address1",document.getElementById("address1").value);';
    html += 'fd.append("address2",document.getElementById("address2").value);';
    html += 'fd.append("giftMessage",document.getElementById("giftMessage").value);';
    html += 'fd.append("senderName",document.getElementById("senderName").value);';
    html += 'fd.append("topPosition",(parseInt(document.getElementById("topPos").value)/72).toFixed(2)+"in");';
    html += 'fd.append("messagePosition",(parseInt(document.getElementById("msgPos").value)/72).toFixed(2)+"in");';
    html += 'fd.append("messageFontSize",fs);';
    html += 'fd.append("messageFontFamily",font);';
    html += 'fd.append("messageFontWeight",fmtBold?"700":"400");';
    html += 'fd.append("messageFontStyle",fmtItalic?"italic":"normal");';
    html += 'var params=new URLSearchParams(fd);';
    html += 'fetch("/dashboard/send-gift-card-print/'+order.id+'",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params.toString()}).then(function(r){return r.json()}).then(function(d){if(d.success){alert("✅ Gift card sent to printer!")}else{alert("❌ Print failed: "+d.error)}}).catch(function(e){alert("Error: "+e.message)})';
    html += '}';
    html += '</' + 'script>';
    html += '</body></html>';
    res.send(html);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});


// ============ SEND GIFT CARD TO PRINTNODE (from editor) ============

app.post('/dashboard/send-gift-card-print/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);

    var customData = {
      giftReceiver: req.body.recipientName || orderData.giftReceiver,
      giftMessage: (req.body.giftMessage || orderData.giftMessage || '').substring(0, 300),
      giftSender: req.body.senderName || orderData.giftSender,
      orderNumber: orderData.orderNumber,
      recipient: {
        name: req.body.recipientName || orderData.recipient.name,
        address1: req.body.address1 || orderData.recipient.address1,
        address2: '',
        city: '',
        province: '',
        zip: ''
      },
      topPosition: req.body.topPosition || '0.15in',
      messagePosition: req.body.messagePosition || '4.30in',
      messageFontSize: req.body.messageFontSize || null,
      messageFontFamily: req.body.messageFontFamily || null,
      messageFontWeight: req.body.messageFontWeight || null,
      messageFontStyle: req.body.messageFontStyle || null
    };

    var addr2 = req.body.address2 || '';
    var cityMatch = addr2.match(/^(.+),\s*(\w{2})\s+(\d{5}(-\d{4})?)$/);
    if (cityMatch) {
      customData.recipient.city = cityMatch[1];
      customData.recipient.province = cityMatch[2];
      customData.recipient.zip = cityMatch[3];
    } else {
      customData.recipient.city = addr2;
    }

    var giftCardHTML = generateGiftCardHTML(customData);
    var pdfBase64 = await giftCardToPdfBase64(giftCardHTML);
    await sendToPrintNode(pdfBase64, CONFIG.printNode.giftCardPrinterId, 'Gift Card ' + orderData.orderNumber);

    res.json({ success: true });
  } catch (error) {
    console.error('Gift card print error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============ LEGACY CUSTOM PRINT ROUTE (browser print) ============

app.post('/dashboard/print-custom-submit', async (req, res) => {
  try {
    var customData = {
      giftReceiver: req.body.recipientName || '',
      giftMessage: (req.body.giftMessage || '').substring(0, 300),
      giftSender: req.body.senderName || '',
      orderNumber: req.body.orderNumber || '',
      recipient: {
        name: req.body.recipientName || '',
        address1: req.body.address1 || '',
        address2: '',
        city: '',
        province: '',
        zip: ''
      },
      topPosition: req.body.topPosition || '0.15in',
      messagePosition: req.body.messagePosition || '4.30in',
      messageFontSize: req.body.messageFontSize || null,
      messageFontFamily: req.body.messageFontFamily || null,
      messageFontWeight: req.body.messageFontWeight || null,
      messageFontStyle: req.body.messageFontStyle || null
    };

    var addr2 = req.body.address2 || '';
    var cityMatch = addr2.match(/^(.+),\s*(\w{2})\s+(\d{5}(-\d{4})?)$/);
    if (cityMatch) {
      customData.recipient.city = cityMatch[1];
      customData.recipient.province = cityMatch[2];
      customData.recipient.zip = cityMatch[3];
    } else {
      customData.recipient.city = addr2;
    }

    var giftCardHTML = generateGiftCardHTML(customData);
    res.send('<!DOCTYPE html><html><head><title> </title><style>@media print{.no-print{display:none!important}body{margin:0;padding:0}@page{size:4.15in 8.5in;margin:0}}</style></head><body><div class="no-print" style="position:fixed;top:20px;display:flex;gap:10px;left:50%;transform:translateX(-50%);z-index:1000"><a href="/dashboard" style="background:#000;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600">← Back</a><button onclick="window.print()" style="background:#4CAF50;color:#fff;padding:10px 20px;border-radius:6px;font-family:sans-serif;font-size:14px;font-weight:600;border:none;cursor:pointer">🖨 Print</button></div>' + giftCardHTML + '</body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ SAVE INVOICE EDITS TO SHOPIFY ============

app.post('/dashboard/invoice-save/:orderId', async (req, res) => {
  try {
    var body = req.body;
    var noteLines = [];
    if (body.specialInstructions) noteLines.push('Special Instructions: ' + body.specialInstructions);
    if (body.giftMessage) noteLines.push('Gift Message: ' + body.giftMessage);
    if (body.deliveryDate) noteLines.push('Delivery Date: ' + body.deliveryDate);

    var updatePayload = { order: { id: parseInt(req.params.orderId) } };
    if (body.recipientName || body.addr1 || body.city) {
      updatePayload.order.shipping_address = {};
      if (body.recipientName) updatePayload.order.shipping_address.name = body.recipientName;
      if (body.addr1) updatePayload.order.shipping_address.address1 = body.addr1;
      if (body.addr2) updatePayload.order.shipping_address.address2 = body.addr2;
      if (body.city) updatePayload.order.shipping_address.city = body.city;
      if (body.province) updatePayload.order.shipping_address.province = body.province;
      if (body.zip) updatePayload.order.shipping_address.zip = body.zip;
    }
    if (noteLines.length > 0) updatePayload.order.note = noteLines.join('\n');

    if (body.deliveryType) {
      var dtLabelMap = { 'pickup': 'Pickup', 'local-delivery': 'Local Delivery', 'shipping': 'Shipping', 'in-store': 'In Store' };
      var dtLabel = dtLabelMap[body.deliveryType] || body.deliveryType;
      var existingOrder = await fetchOrderFromShopify(req.params.orderId);
      var attrs = (existingOrder.note_attributes || []).filter(function (a) {
        return (a.name || '').toLowerCase().replace(/[\s_\-]+/g, '') !== 'deliverymethod';
      });
      attrs.push({ name: 'Delivery Method', value: dtLabel });
      updatePayload.order.note_attributes = attrs;
    }

    var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json';
    var response = await fetch(url, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(updatePayload)
    });
    if (!response.ok) {
      var errText = await response.text();
      return res.json({ success: false, error: 'Shopify error ' + response.status + ': ' + errText });
    }
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ CREATE NEW GIFT CARD (no order needed) ============

app.get('/dashboard/gift-card-new', async (req, res) => {
  var fontLink = 'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Dancing+Script:wght@400;700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&family=Great+Vibes&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Raleway:ital,wght@0,400;0,700;1,400;1,700&family=Pacifico&family=EB+Garamond:ital,wght@0,400;0,700;1,400;1,700&display=swap';

  var html = '<!DOCTYPE html><html><head>';
  html += '<title>Create Gift Card</title><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<link href="' + fontLink + '" rel="stylesheet">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f1f3;display:flex;height:100vh;color:#111}';
  html += '.editor-panel{width:430px;background:#fff;border-right:1px solid #e5e7eb;padding:24px;overflow-y:auto}.preview-panel{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}';
  html += 'h2{font-size:21px;margin-bottom:3px;letter-spacing:-.3px}.sub{font-size:12.5px;color:#9ca3af;margin-bottom:20px}';
  html += '.group{background:#fafbfc;border:1px solid #ebedf0;border-radius:12px;padding:16px;margin-bottom:16px}.group-title{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;margin-bottom:14px}.badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#111;color:#fff;font-size:11px;font-weight:700}.zone{margin-left:auto;font-size:10px;font-weight:600;text-transform:none;letter-spacing:.2px;color:#16a34a;background:#ecfdf3;padding:2px 9px;border-radius:20px}';
  html += '.field{margin-bottom:12px}.field label{display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;color:#374151}.field input,.field textarea,.fmt-select{width:100%;padding:10px 11px;border:1.5px solid #e2e5ea;border-radius:8px;font-size:13.5px;font-family:inherit;background:#fff;transition:border-color .15s}.field input:focus,.field textarea:focus,.fmt-select:focus{outline:none;border-color:#111}.field textarea{height:84px;resize:vertical}.fmt-select{cursor:pointer}.opt{font-size:10px;font-weight:600;color:#b6bcc6;text-transform:none;letter-spacing:0}.char-count{font-size:11px;font-weight:600;color:#9ca3af}.char-count.warn{color:#ef4444}';
  html += '.sub-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#9ca3af;margin:14px 0 9px}.ctrl{display:flex;align-items:center;gap:12px;margin-bottom:11px}.ctrl-label{font-size:12.5px;font-weight:600;color:#374151;width:96px;flex-shrink:0}.ctrl input[type=range]{flex:1;accent-color:#111;height:4px}.ctrl-val{font-size:12px;font-weight:700;width:56px;text-align:right;color:#111;flex-shrink:0}';
  html += '.toggles{display:flex;gap:5px}.tg{width:34px;height:32px;display:flex;align-items:center;justify-content:center;border:1.5px solid #e2e5ea;border-radius:7px;font-size:14px;font-weight:700;cursor:pointer;background:#fff;color:#6b7280;transition:all .12s}.tg.active{background:#111;color:#fff;border-color:#111}.tg:hover:not(.active){border-color:#9ca3af;color:#111}.hint{font-size:11px;color:#9ca3af;margin-top:2px;line-height:1.45}';
  html += '.btn-row{display:flex;gap:8px;margin-top:14px}.btn{padding:12px 16px;border-radius:9px;font-size:13.5px;font-weight:700;text-decoration:none;border:none;cursor:pointer;text-align:center;flex:1;display:flex;align-items:center;justify-content:center}.btn-green{background:#22c55e;color:#fff}.btn-primary{background:#111;color:#fff}.btn-secondary{background:#fff;color:#111;border:1.5px solid #d1d5db}';
  html += '.pv-label{font-size:11px;color:#9ca3af;margin-bottom:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px}.card-preview{width:299px;height:612px;background:#fff;border:1px solid #d1d5db;box-shadow:0 8px 30px rgba(0,0,0,.12);position:relative;overflow:hidden}.top-section-preview,.msg-section-preview{position:absolute;left:0;right:0;text-align:center;padding:0 40px}.fold-line{position:absolute;top:50%;left:0;right:0;border-top:1px dashed #d1d5db;pointer-events:none}.fold-tag{position:absolute;top:50%;right:6px;transform:translateY(-50%);font-size:8px;font-weight:700;letter-spacing:.5px;color:#cbd0d8;background:#fff;padding:0 4px;text-transform:uppercase}';
  html += '@media print{.no-print{display:none!important}body{margin:0;padding:0;background:white;display:block}.preview-panel{display:block;padding:0}.card-preview{border:none;box-shadow:none;width:4.15in;height:8.5in;margin:0;padding:0}.fold-line,.fold-tag{display:none}@page{size:4.15in 8.5in;margin:0}}';
  html += '</style></head><body>';

  html += '<div class="editor-panel no-print">';
  html += '<h2>✨ Create Gift Card</h2><div class="sub">No order needed — fill in, preview, and print.</div>';

  html += '<div class="group">';
  html += '<div class="group-title"><span class="badge">1</span>Recipient<span class="zone">top of card</span></div>';
  html += '<div class="field"><label>Recipient Name</label><input type="text" id="recipientName" placeholder="e.g. Sarah Cohen" oninput="updatePreview()"></div>';
  html += '<div class="field"><label>Address Line 1 <span class="opt">optional</span></label><input type="text" id="address1" placeholder="123 Main St" oninput="updatePreview()"></div>';
  html += '<div class="field"><label>City, State ZIP <span class="opt">optional</span></label><input type="text" id="address2" placeholder="Miami, FL 33179" oninput="updatePreview()"></div>';
  html += '<div class="sub-label">Text size</div>';
  html += '<div class="ctrl"><span class="ctrl-label">Name</span><input type="range" id="nameSize" min="8" max="40" value="11.9" step="0.5" oninput="updatePreview()"><span class="ctrl-val" id="nameSizeVal">11.9pt</span></div>';
  html += '<div class="ctrl"><span class="ctrl-label">Address</span><input type="range" id="addrSize" min="6" max="40" value="9.35" step="0.5" oninput="updatePreview()"><span class="ctrl-val" id="addrSizeVal">9.35pt</span></div>';
  html += '</div>';

  html += '<div class="group">';
  html += '<div class="group-title"><span class="badge">2</span>Message<span class="zone">bottom half</span></div>';
  html += '<div class="field"><label>Gift Message <span id="charCount" class="char-count">0/300</span></label><textarea id="giftMessage" maxlength="300" placeholder="Write the gift message here..." oninput="updatePreview()"></textarea></div>';
  html += '<div class="field"><label>Sender Name</label><input type="text" id="senderName" placeholder="e.g. The Smith Family" oninput="updatePreview()"></div>';
  html += '<div class="field"><label>Font</label><select id="fmtFont" class="fmt-select" onchange="updatePreview()"><option value="Montserrat" style="font-family:Montserrat">Montserrat</option><option value="Playfair Display" style="font-family:Playfair Display">Playfair Display</option><option value="Dancing Script" style="font-family:Dancing Script">Dancing Script</option><option value="Lato" style="font-family:Lato">Lato</option><option value="Cormorant Garamond" style="font-family:Cormorant Garamond">Cormorant Garamond</option><option value="Great Vibes" style="font-family:Great Vibes">Great Vibes</option><option value="Libre Baskerville" style="font-family:Libre Baskerville">Libre Baskerville</option><option value="Raleway" style="font-family:Raleway">Raleway</option><option value="Pacifico" style="font-family:Pacifico">Pacifico</option><option value="EB Garamond" style="font-family:EB Garamond">EB Garamond</option></select></div>';
  html += '<div class="ctrl"><span class="ctrl-label">Size</span><input type="range" id="fmtSize" min="7" max="50" value="10" step="0.5" oninput="updatePreview()"><span class="ctrl-val" id="fmtSizeVal">10pt</span></div>';
  html += '<div class="ctrl"><span class="ctrl-label">Style &amp; align</span><div class="toggles"><button class="tg active" id="toggleBold" data-fmt="bold" onclick="toggleFmt(this.dataset.fmt)"><b>B</b></button><button class="tg" id="toggleItalic" data-fmt="italic" onclick="toggleFmt(this.dataset.fmt)"><i>I</i></button></div><div class="toggles" style="margin-left:auto"><button class="tg" id="toggleAlignLeft" onclick="setAlign(\'left\')">L</button><button class="tg active" id="toggleAlignCenter" onclick="setAlign(\'center\')">C</button><button class="tg" id="toggleAlignRight" onclick="setAlign(\'right\')">R</button></div></div>';
  html += '<div class="ctrl"><span class="ctrl-label">Line spacing</span><input type="range" id="lineSpacing" min="1" max="2.5" value="1.5" step="0.1" oninput="updatePreview()"><span class="ctrl-val" id="lineSpacingVal">1.5</span></div>';
  html += '<div class="ctrl"><span class="ctrl-label">Vertical position</span><input type="range" id="msgPos" min="4.25" max="6.5" value="4.30" step="0.05" oninput="updatePreview()"><span class="ctrl-val" id="msgPosVal">4.30in</span></div>';
  html += '<div class="hint">Drag left to raise the message toward the center fold — it stops at the fold so it never crosses onto the top half.</div>';
  html += '<div class="hint" id="overflowWarn" style="color:#ef4444;font-weight:600;display:none">⚠ Message is too tall for the space — it will be cut off when printed. Lower the font size, line spacing, or raise the position.</div>';
  html += '</div>';

  html += '<div class="field"><label>Order # <span class="opt">optional — for matching</span></label><input type="text" id="orderNumber" placeholder="e.g. #12345" oninput="updatePreview()"></div>';

  html += '<div class="btn-row"><button class="btn btn-green" onclick="printToPrinter()">🖨 Print to Printer</button></div>';
  html += '<div class="btn-row"><button class="btn btn-primary" onclick="window.print()">🖥 Browser Print</button><a href="/dashboard" class="btn btn-secondary">← Back</a></div>';
  html += '</div>';

  html += '<div class="preview-panel">';
  html += '<p class="pv-label">Live Preview · folds in half</p>';
  html += '<div class="card-preview" id="cardPreview">';
  html += '<div class="fold-line"></div><span class="fold-tag">fold</span>';
  html += '<div class="top-section-preview" id="topSection" style="top:1.76%"><div id="prevName" style="font-family:Montserrat,sans-serif;font-size:11.9pt;font-weight:400;margin-bottom:12px;color:#bbb;font-style:italic">Recipient name</div><div id="prevAddr" style="font-family:Montserrat,sans-serif;font-size:9.35pt;font-weight:400;line-height:1.4;color:#ccc"></div></div>';
  html += '<div class="msg-section-preview" id="msgSection" style="top:50.59%"><div id="prevMsg" style="font-family:Montserrat,sans-serif;font-size:10pt;font-weight:700;line-height:1.5;color:#ccc;font-style:italic">Gift message will appear here...</div><div id="prevSender" style="margin-top:12px;font-family:Montserrat,sans-serif;font-size:10pt;font-weight:700;color:#ccc"></div></div>';
  html += '<div id="prevOrderCode" style="position:absolute;top:74%;left:17%;font-family:Arial,sans-serif;font-size:5pt;color:#888"></div>';
  html += '</div></div>';

  html += '<script>';
  html += 'var fmtBold=true,fmtItalic=false,fmtAlign="center";';
  html += 'function toggleFmt(t){if(t==="bold"){fmtBold=!fmtBold;document.getElementById("toggleBold").className="tg"+(fmtBold?" active":"")}else{fmtItalic=!fmtItalic;document.getElementById("toggleItalic").className="tg"+(fmtItalic?" active":"")}updatePreview()}';
  html += 'function setAlign(a){fmtAlign=a;document.getElementById("toggleAlignLeft").className="tg"+(a==="left"?" active":"");document.getElementById("toggleAlignCenter").className="tg"+(a==="center"?" active":"");document.getElementById("toggleAlignRight").className="tg"+(a==="right"?" active":"");updatePreview()}';
  html += 'function updatePreview(){';
  html += 'var orderNum=document.getElementById("orderNumber").value;';
  html += 'var name=document.getElementById("recipientName").value;';
  html += 'var a1=document.getElementById("address1").value;';
  html += 'var a2=document.getElementById("address2").value;';
  html += 'var msg=document.getElementById("giftMessage").value;';
  html += 'var sender=document.getElementById("senderName").value;';
  html += 'var len=msg.length;var cc=document.getElementById("charCount");cc.textContent=len+"/300";cc.className=len>280?"char-count warn":"char-count";';
  html += 'var fszNum=parseFloat(document.getElementById("fmtSize").value);var fs=fszNum+"pt";document.getElementById("fmtSizeVal").textContent=fszNum+"pt";var font=document.getElementById("fmtFont").value;';
  html += 'var nameSz=parseFloat(document.getElementById("nameSize").value);document.getElementById("nameSizeVal").textContent=nameSz+"pt";';
  html += 'var addrSz=parseFloat(document.getElementById("addrSize").value);document.getElementById("addrSizeVal").textContent=addrSz+"pt";';
  html += 'var lineSp=parseFloat(document.getElementById("lineSpacing").value);document.getElementById("lineSpacingVal").textContent=lineSp;';
  html += 'var msgPos=parseFloat(document.getElementById("msgPos").value);document.getElementById("msgPosVal").textContent=msgPos.toFixed(2)+"in";';
  html += 'var msgTopPx=msgPos/8.5*612;document.getElementById("msgSection").style.top=(msgPos/8.5*100)+"%";';
  html += 'var nameEl=document.getElementById("prevName");nameEl.style.fontSize=nameSz+"pt";if(name){nameEl.textContent=name;nameEl.style.color="#000";nameEl.style.fontStyle="normal"}else{nameEl.textContent="Recipient name";nameEl.style.color="#bbb";nameEl.style.fontStyle="italic"}';
  html += 'var addrEl=document.getElementById("prevAddr");addrEl.style.fontSize=addrSz+"pt";addrEl.innerHTML=a1?(a1+(a2?"<br>"+a2:"")):(a2||"");addrEl.style.color=a1||a2?"#000":"#ccc";';
  html += 'document.getElementById("msgSection").style.textAlign=fmtAlign;';
  html += 'var msgEl=document.getElementById("prevMsg");msgEl.style.fontFamily=font+",sans-serif";msgEl.style.fontSize=fs;msgEl.style.fontWeight=fmtBold?"700":"400";msgEl.style.fontStyle=fmtItalic?"italic":"normal";msgEl.style.lineHeight=lineSp;';
  html += 'if(msg){msgEl.innerHTML=msg.replace(/\\n/g,"<br>");msgEl.style.color="#000"}else{msgEl.textContent="Gift message will appear here...";msgEl.style.color="#ccc"}';
  html += 'var sEl=document.getElementById("prevSender");sEl.textContent=sender;sEl.style.fontFamily=font+",sans-serif";sEl.style.fontSize=fs;sEl.style.fontWeight=fmtBold?"700":"400";sEl.style.fontStyle=fmtItalic?"italic":"normal";sEl.style.color=sender?"#000":"#ccc";';
  html += 'document.getElementById("prevOrderCode").textContent=orderNum;';
  html += 'var availPx=612-msgTopPx-12;var over=document.getElementById("msgSection").offsetHeight>availPx;document.getElementById("fmtSizeVal").style.color=over?"#ef4444":"#111";document.getElementById("overflowWarn").style.display=over?"block":"none";';
  html += '}';
  html += 'function printToPrinter(){';
  html += 'var fs=parseFloat(document.getElementById("fmtSize").value)+"pt";var font=document.getElementById("fmtFont").value;';
  html += 'var nameSz=parseFloat(document.getElementById("nameSize").value);var addrSz=parseFloat(document.getElementById("addrSize").value);var lineSp=parseFloat(document.getElementById("lineSpacing").value);var msgPos=parseFloat(document.getElementById("msgPos").value);';
  html += 'var params=new URLSearchParams({orderNumber:document.getElementById("orderNumber").value,recipientName:document.getElementById("recipientName").value,address1:document.getElementById("address1").value,address2:document.getElementById("address2").value,giftMessage:document.getElementById("giftMessage").value,senderName:document.getElementById("senderName").value,topPosition:"0.15in",messagePosition:msgPos.toFixed(2)+"in",messageFontSize:fs,messageFontFamily:font,messageFontWeight:fmtBold?"700":"400",messageFontStyle:fmtItalic?"italic":"normal",messageLineHeight:lineSp,messageAlign:fmtAlign,nameFontSize:nameSz+"pt",addressFontSize:addrSz+"pt"});';
  html += 'fetch("/dashboard/send-new-gift-card",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params.toString()}).then(function(r){return r.json()}).then(function(d){if(d.success){alert("✅ Gift card sent to printer!")}else{alert("❌ Print failed: "+d.error)}}).catch(function(e){alert("Error: "+e.message)})';
  html += '}';
  html += 'updatePreview();';
  html += '</' + 'script>';
  html += '</body></html>';
  res.send(html);
});


// ============ PRINT NEW GIFT CARD (no order) VIA PRINTNODE ============

app.post('/dashboard/send-new-gift-card', async (req, res) => {
  try {
    var customData = {
      giftReceiver: req.body.recipientName || '',
      giftMessage: (req.body.giftMessage || '').substring(0, 300),
      giftSender: req.body.senderName || '',
      orderNumber: req.body.orderNumber || '',
      recipient: {
        name: req.body.recipientName || '',
        address1: req.body.address1 || '',
        address2: '',
        city: '',
        province: '',
        zip: ''
      },
      topPosition: req.body.topPosition || '0.15in',
      messagePosition: req.body.messagePosition || '4.30in',
      messageFontSize: req.body.messageFontSize || '',
      messageFontFamily: req.body.messageFontFamily || 'Montserrat',
      messageFontWeight: req.body.messageFontWeight || '700',
      messageFontStyle: req.body.messageFontStyle || 'normal',
      messageLineHeight: req.body.messageLineHeight || '',
      messageAlign: req.body.messageAlign || 'center',
      nameFontSize: req.body.nameFontSize || '11.9pt',
      addressFontSize: req.body.addressFontSize || '9.35pt'
    };

    var addr2 = req.body.address2 || '';
    var cityMatch = addr2.match(/^(.+),\s*(\w{2})\s+(\d{5}(-\d{4})?)$/);
    if (cityMatch) {
      customData.recipient.city = cityMatch[1];
      customData.recipient.province = cityMatch[2];
      customData.recipient.zip = cityMatch[3];
    } else {
      customData.recipient.city = addr2;
    }

    var { generateGiftCardHTML } = require('./gift-card-template');
    var giftCardHTML = generateGiftCardHTML(customData);
    var pdfBase64 = await giftCardToPdfBase64(giftCardHTML);
    await sendToPrintNode(pdfBase64, CONFIG.printNode.giftCardPrinterId, 'Custom Gift Card - ' + (customData.giftReceiver || 'No Name'));
    res.json({ success: true });
  } catch (error) {
    console.error('New gift card print error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============ TEST CARD (prints a sample through the REAL auto-print path) ============

app.get('/dashboard/test-card', function (req, res) {
  var html = '<!DOCTYPE html><html><head><title>Test Card</title><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f1f3;padding:40px;max-width:560px;margin:0 auto;color:#111}';
  html += 'h2{font-size:21px;margin-bottom:4px}.sub{font-size:13px;color:#888;margin-bottom:22px;line-height:1.5}';
  html += 'label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 5px;color:#374151}';
  html += 'input,textarea{width:100%;padding:10px 11px;border:1.5px solid #e2e5ea;border-radius:8px;font-size:14px;font-family:inherit}textarea{height:80px;resize:vertical}';
  html += '.btn{display:inline-block;margin-top:18px;padding:13px 20px;border-radius:9px;font-size:14px;font-weight:700;border:none;cursor:pointer;background:#22c55e;color:#fff}';
  html += '.btn.secondary{background:#fff;color:#111;border:1.5px solid #d1d5db;margin-left:8px}a{color:#111}</style></head><body>';
  html += '<h2>🧪 Print a Test Card</h2>';
  html += '<div class="sub">This prints a sample gift card through the <strong>exact same path a real order uses</strong> — same automatic font sizing, message position, and top-left order code. Use it to check the layout without waiting for an order.</div>';
  html += '<label>Recipient Name</label><input id="name" value="Jessica Sample">';
  html += '<label>Address</label><input id="addr" value="747 NE 193rd St, Miami, FL 33179">';
  html += '<label>Gift Message</label><textarea id="msg">Thank you for an amazing trip!</textarea>';
  html += '<label>Sender</label><input id="sender" value="Errol and Claudia Feldman">';
  html += '<label>Order # (for the top-left code)</label><input id="order" value="#35993">';
  html += '<div><button class="btn" onclick="go()">🖨 Print Test Card</button><a class="btn secondary" href="/dashboard">← Back</a></div>';
  html += '<script>function go(){var p=new URLSearchParams({name:document.getElementById("name").value,addr:document.getElementById("addr").value,msg:document.getElementById("msg").value,sender:document.getElementById("sender").value,order:document.getElementById("order").value});fetch("/dashboard/test-card",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p.toString()}).then(function(r){return r.json()}).then(function(d){alert(d.success?"✅ Test card sent to the gift card printer!":"❌ "+d.error)}).catch(function(e){alert("Error: "+e.message)})}</' + 'script></body></html>';
  res.send(html);
});

app.post('/dashboard/test-card', async (req, res) => {
  try {
    var addr = (req.body.addr || '').trim();
    var cityMatch = addr.match(/^(.+?),\s*(.+),\s*(\w{2})\s+(\d{5}(-\d{4})?)$/);
    var recipient = { name: req.body.name || '', address1: addr, address2: '', city: '', province: '', zip: '' };
    if (cityMatch) {
      recipient.address1 = cityMatch[1];
      recipient.city = cityMatch[2];
      recipient.province = cityMatch[3];
      recipient.zip = cityMatch[4];
    }
    // Build the data exactly like a real order would (no font/position overrides),
    // so the template's automatic sizing and default position are used.
    var sample = {
      giftReceiver: req.body.name || 'Test Recipient',
      giftMessage: (req.body.msg || '').substring(0, 300),
      giftSender: req.body.sender || '',
      orderNumber: req.body.order || '#TEST',
      recipient: recipient
    };
    var giftCardHTML = generateGiftCardHTML(sample);
    var pdfBase64 = await giftCardToPdfBase64(giftCardHTML);
    await sendToPrintNode(pdfBase64, CONFIG.printNode.giftCardPrinterId, 'TEST Gift Card');
    res.json({ success: true });
  } catch (error) {
    console.error('Test card print error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============ SEARCH ============

app.get('/dashboard/search', async (req, res) => {
  try {
    var q = req.query.q || '';
    if (!q) return res.redirect('/dashboard/invoices');

    var allResults = [];

    if (q.match(/^#?\d+$/)) {
      var orders = await searchShopifyOrders(q.replace('#', ''));
      for (var i = 0; i < orders.length; i++) {
        allResults.push({ order: orders[i], data: extractOrderData(orders[i]), timestamp: new Date(orders[i].created_at) });
      }
    } else {
      var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=250';
      var response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        var data = await response.json();
        var orders = data.orders || [];
        var qLower = q.toLowerCase();
        for (var i = 0; i < orders.length; i++) {
          var od = extractOrderData(orders[i]);
          var customerName = ((orders[i].customer || {}).first_name || '') + ' ' + ((orders[i].customer || {}).last_name || '');
          var recipientName = od.recipient.name || '';
          var giftReceiver = od.giftReceiver || '';
          var giftSender = od.giftSender || '';
          var orderNum = od.orderNumber || '';
          if (customerName.toLowerCase().indexOf(qLower) > -1 ||
              recipientName.toLowerCase().indexOf(qLower) > -1 ||
              giftReceiver.toLowerCase().indexOf(qLower) > -1 ||
              giftSender.toLowerCase().indexOf(qLower) > -1 ||
              orderNum.toLowerCase().indexOf(qLower) > -1) {
            allResults.push({ order: orders[i], data: od, timestamp: new Date(orders[i].created_at) });
          }
        }
      }
    }

    var qLower2 = q.toLowerCase();
    for (var k = 0; k < recentOrders.length; k++) {
      var ro = recentOrders[k];
      var d = ro.data;
      var alreadyFound = allResults.find(function(r) { return r.order.id === ro.order.id; });
      if (!alreadyFound) {
        if ((d.orderNumber && d.orderNumber.toLowerCase().indexOf(qLower2) > -1) ||
          (d.recipient.name && d.recipient.name.toLowerCase().indexOf(qLower2) > -1) ||
          (d.giftReceiver && d.giftReceiver.toLowerCase().indexOf(qLower2) > -1) ||
          (d.giftSender && d.giftSender.toLowerCase().indexOf(qLower2) > -1)) {
          allResults.push(ro);
        }
      }
    }

    var orderCards = '';
    for (var j = 0; j < allResults.length; j++) {
      var r = allResults[j];
      var hasGift = r.data.giftMessage && r.data.giftMessage.trim() ? '<span style="display:inline-block;background:#000;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px">🎁 GIFT</span>' : '';
      orderCards += '<div class="order-card"><div class="order-num">' + r.data.orderNumber + hasGift + '</div><div class="order-detail"><strong>' + r.data.deliveryType.toUpperCase() + '</strong> — ' + r.data.recipient.name + '</div><div class="order-detail">' + r.data.deliveryDate + '</div><div class="order-detail">' + r.data.items.length + ' item(s)</div><div class="order-actions"><a href="/dashboard/invoice-view/' + r.order.id + '" class="btn btn-view">View Invoice</a> <a href="/dashboard/reprint-invoice/' + r.order.id + '" class="btn btn-print">Reprint</a>' + (r.data.giftMessage ? ' <a href="/dashboard/print-custom/' + r.order.id + '" class="btn btn-print" style="background:#4CAF50">Edit Gift Card</a>' : '') + '</div></div>';
    }

    if (!orderCards) orderCards = '<p style="text-align:center;color:#999;padding:40px;">No results found for "' + q + '". Try an order number or customer name.</p>';

    res.send('<!DOCTYPE html><html><head><title>Search: ' + q + '</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.header h1{font-size:24px}.nav-links a{margin-left:12px;padding:8px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600}.nav-links a.secondary{background:#fff;color:#000;border:2px solid #000}.search-bar{margin-bottom:20px}.search-bar form{display:flex;gap:8px}.search-bar input{flex:1;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px}.search-bar input:focus{outline:none;border-color:#000}.order-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.order-card{background:#fff;border:2px solid #eee;border-radius:12px;padding:16px;transition:border-color 0.2s}.order-card:hover{border-color:#000}.order-num{font-size:18px;font-weight:800;margin-bottom:8px}.order-detail{font-size:13px;margin-bottom:4px;color:#333}.order-actions{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}.btn-edit{background:#22c55e;color:#fff;border:none}.btn-view{background:#fff;color:#000;border:2px solid #000}.btn-print{background:#000;color:#fff}.tab-nav{display:flex;gap:0;margin-bottom:20px}.tab{padding:10px 24px;text-decoration:none;font-size:15px;font-weight:700;border-radius:0}.tab:first-child{border-radius:8px 0 0 8px}.tab:last-child{border-radius:0 8px 8px 0}.tab-active{background:#22c55e;color:#fff;border:2px solid #22c55e}.tab-inactive{background:#fff;color:#999;border:2px solid #ddd}</style></head><body><div class="header"><h1>🔍 Search: "' + q + '" (' + allResults.length + ' results)</h1><div class="nav-links"><a href="/dashboard/invoices" class="secondary">← Back to Invoices</a><a href="/dashboard" class="secondary">Gift Cards</a></div></div><div class="search-bar"><form action="/dashboard/search" method="get"><input type="text" name="q" placeholder="Search orders..." value="' + q.replace(/"/g, '&quot;') + '"></form></div><div class="order-grid">' + orderCards + '</div></body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ DEBUG ENDPOINT ============

app.get('/debug/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);
    res.json({
      orderNumber: orderData.orderNumber,
      source: order.source_name,
      deliveryType: orderData.deliveryType,
      recipient: orderData.recipient,
      giver: orderData.giver,
      giftMessage: orderData.giftMessage,
      giftReceiver: orderData.giftReceiver,
      giftSender: orderData.giftSender,
      specialInstructions: orderData.specialInstructions,
      items: orderData.items,
      occasion: orderData.occasion,
      babyGender: orderData.babyGender,
      noteAttributes: order.note_attributes,
      printers: {
        invoice: CONFIG.printNode.invoicePrinterId || 'NOT SET',
        giftCard: CONFIG.printNode.giftCardPrinterId || 'NOT SET'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ API STATUS ============

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    ordersInMemory: recentOrders.length,
    printers: {
      invoice: CONFIG.printNode.invoicePrinterId ? 'configured' : 'NOT SET',
      giftCard: CONFIG.printNode.giftCardPrinterId ? 'configured' : 'NOT SET'
    },
    shopify: CONFIG.shopify.store ? 'configured' : 'NOT SET'
  });
});

// ============ EMPLOYEE DASHBOARD (HOME) ============

// Feather-style line icons (24x24 viewBox, stroke follows CSS color).
var DASH_ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  filePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  penTool: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'
};

// Sticky top bar shown on every dashboard page — wordmark always goes home.
var TOPBAR_HTML = '<header class="topbar"><a class="homebtn" href="/">&#127968; HOME</a><a href="/">The Sweet Tooth &mdash; Employee Dashboard</a></header>';
var TOPBAR_CSS = '.topbar{position:fixed;top:0;left:0;right:0;height:52px;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.07);display:flex;align-items:center;padding:0 22px;z-index:100}' +
  '.topbar a{font-size:16.5px;font-weight:800;letter-spacing:-.3px;color:#2A2A2A;text-decoration:none;padding-bottom:1px}' +
  '.topbar a.homebtn{display:inline-flex;align-items:center;gap:7px;background:#2A2A2A;color:#fff;font-size:13.5px;font-weight:800;padding:9px 18px;border-radius:11px;margin-right:16px;padding-bottom:9px}';

function dashTile(label, href, opts) {
  opts = opts || {};
  var html = '<a class="tile" href="' + (href || '#') + '"';
  // Every tile opens a new tab so the dashboard is never lost (staff kept getting stranded).
  html += ' target="_blank" rel="noopener"';
  if (opts.kw) html += ' data-kw="' + escapeHtml((label + ' ' + opts.kw).toLowerCase()) + '"';
  html += '>';
  if (opts.emoji) {
    html += '<span class="emoji">' + opts.emoji + '</span>';
  } else if (opts.icon && DASH_ICONS[opts.icon]) {
    html += '<span class="icon-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + DASH_ICONS[opts.icon] + '</svg></span>';
  }
  html += '<span class="label">' + label + (opts.sub ? '<br><span class="sublabel">' + opts.sub + '</span>' : '') + '</span></a>';
  return html;
}

function dashPage(title, subtitle, tilesHtml, backHref, notice, rawBody, noH1) {
  var html = '<!DOCTYPE html><html><head><title>' + title + ' — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#3D3D3D;min-height:100vh;display:flex;padding:72px 24px 36px}';
  html += '.wrap{width:100%;max-width:1080px;margin:auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:31px;letter-spacing:-.5px;text-align:center;color:#3D3D3D}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 0}';
  html += '.subtitle{color:#9B8A92;font-size:15px;text-align:center;margin-top:10px}';
  html += '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:18px;margin-top:34px;justify-content:center}';
  html += '.tile{position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;min-height:118px;background:#fff;border:1px solid #EFEBED;border-radius:18px;padding:16px 16px;text-decoration:none;color:#2A2A2A;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.05);transition:transform .12s,box-shadow .12s}';
  html += '.tile:before{content:"";position:absolute;top:0;left:0;right:0;height:4px;background:#F7B5CD;opacity:0;transition:opacity .12s}';
  html += '.tile:hover{transform:translateY(-4px);box-shadow:0 14px 30px rgba(0,0,0,.12)}';
  html += '.tile:hover:before{opacity:1}';
  html += '.icon-badge{color:#2A2A2A;display:flex;align-items:center;justify-content:center;flex-shrink:0}';
  html += '.icon-badge svg{width:34px;height:34px}';
  html += '.tile .label{font-weight:750;font-size:17.5px;letter-spacing:-.2px;line-height:1.35}';
  html += '.tile .emoji{font-size:36px;line-height:1}';
  html += '.tile .sublabel{font-size:12.5px;font-weight:700;color:#9B8A92;letter-spacing:0}';
  html += '.tile.dim{opacity:.18}';
  html += '.sec{font-size:13.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:#9B8A92;margin:22px 0 0;padding-bottom:7px;border-bottom:2px solid #F3EDF0}';
  html += '.sec:first-of-type{margin-top:20px}';
  html += '.sec + .grid{margin-top:13px}';
  html += '.duo{display:flex;gap:18px;align-items:flex-start}.duo .half{flex:1;min-width:0}';
  html += '@media (max-width:760px){.duo{flex-direction:column;align-items:stretch}}';
  html += '.postit{position:relative;max-width:430px;margin:6px auto 0;background:#FEF3B4;border-radius:3px 16px 3px 16px;box-shadow:0 4px 14px rgba(0,0,0,.10);padding:22px 18px 12px;font-size:14px;font-weight:600;line-height:1.5;transform:rotate(-1.2deg);color:#5C5335}';
  html += '.postit .hide{position:absolute;top:7px;right:11px;font-size:12px;font-weight:700;color:#A89B66;text-decoration:none;cursor:pointer}';
  html += '.postit.supply{background:#FFE1C9;color:#5C4326;transform:rotate(.8deg);margin-top:12px}';
  html += '.postit.supply .got{display:inline-block;margin-top:10px;padding:9px 16px;border:none;border-radius:10px;background:#2A2A2A;color:#fff;font-weight:800;font-size:13.5px;cursor:pointer}';
  html += '.postit.supply .dd{font-weight:800;color:#B0521E}';
  html += '.notesbar{display:flex;justify-content:flex-end;gap:18px;margin-top:8px}';
  html += '.notesbar a{font-size:13px;font-weight:800;color:#9B8A92;text-decoration:none}.notesbar a:hover{color:#2A2A2A}';
  html += '.actionbar{display:flex;gap:12px;margin-top:16px}';
  html += '.askai.light{background:#fff;color:#2A2A2A;border:1.5px solid #E8E2E5}';
  html += '.askai.dim{opacity:.18}';
  html += '.searchwrap{flex:1;display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid #E8E2E5;border-radius:16px;padding:4px 8px 4px 18px;box-shadow:0 2px 10px rgba(0,0,0,.05)}';
  html += '.searchwrap:focus-within{border-color:#C9BFC4}';
  html += '.searchwrap .mag{font-size:19px}';
  html += '.searchwrap input{flex:1;border:none;background:transparent;font-size:17.5px;padding:14px 0;min-width:0}.searchwrap input:focus{outline:none}';
  html += '.micbtn{border:none;background:#FAF7F8;border-radius:12px;font-size:21px;padding:9px 13px;cursor:pointer;line-height:1}.micbtn.listening{background:#F7B5CD}';
  html += '.askai{flex-shrink:0;display:flex;align-items:center;gap:9px;background:#2A2A2A;color:#fff;border-radius:16px;padding:0 24px;font-weight:800;font-size:15.5px;text-decoration:none}';
  html += '@media (max-width:760px){.actionbar{flex-direction:column}.askai{padding:15px;justify-content:center}}';
  html += '.search-miss{display:none;text-align:center;color:#9B8A92;font-size:15px;font-weight:600;margin-top:26px}';
  html += '@media (max-width:760px){body{padding:88px 18px 36px}.grid{gap:16px;margin-top:32px}.tile{min-height:150px}h1{font-size:26px}}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  if (!noH1) html += '<h1>' + title + '</h1>';
  if (subtitle) html += '<p class="subtitle">' + subtitle + '</p>';
  if (notice) html += '<div style="margin-top:28px;background:#fff;border:1px solid #EFEBED;border-top:5px solid #F7B5CD;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.05);padding:20px 24px;text-align:center;font-size:16.5px;font-weight:700;line-height:1.55">' + notice + '</div>';
  html += rawBody ? tilesHtml : '<div class="grid">' + tilesHtml + '</div>';
  html += '</div></body></html>';
  return html;
}

app.get('/', (req, res) => {
  // Grouped sections: like tiles with like. data-kw powers the search box (label + synonyms).
  var body = '';
  // Post-it reminder for #36229 — small, dismissible per device for the day, auto-expires Fri Jul 31.
  var nowET2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (nowET2 < new Date('2026-07-31T00:00:00')) {
    body += '<div class="postit" id="postit"><a class="hide" id="postit-hide">hide for today &#10005;</a>' +
      '&#128204; <b>#36229 ships THURSDAY July 30</b> &mdash; overnight label is already printed, keep it with the paperwork.</div>';
    body += '<script>(function(){var p=document.getElementById("postit"),h=document.getElementById("postit-hide");' +
      'var today=new Date().toDateString();if(localStorage.getItem("postit-hidden")===today)p.style.display="none";' +
      'h.addEventListener("click",function(){localStorage.setItem("postit-hidden",today);p.style.display="none"});})();</script>';
  }
  body += '<div class="notesbar"><a href="#" id="addnote">&#10133; Add a post-it</a><a href="/dashboard/postit-archive" target="_blank" rel="noopener">&#128452;&#65039; Post-it Archive</a></div>';
  body += '<div id="custom-notes"></div>';
  body += '<div id="supply-alerts"></div>';
  // Shared notes: stored in a Shopify shop metafield — same for every device, survive restarts.
  body += '<script>(function(){var nbox=document.getElementById("custom-notes");';
  body += 'function renderNotes(d){nbox.innerHTML="";(d.notes||[]).slice(0,8).forEach(function(a){';
  body += 'var n=document.createElement("div");n.className="postit";n.style.marginTop="12px";';
  body += 'var t=document.createElement("div");t.textContent="\\uD83D\\uDCDD "+a.text;n.appendChild(t);';
  body += 'var m=document.createElement("div");m.style.cssText="font-size:12px;color:#A89B66;margin-top:4px;font-weight:700";';
  body += 'm.textContent=new Date(a.created).toLocaleDateString("en-US",{month:"short",day:"numeric"});n.appendChild(m);';
  body += 'var g=document.createElement("button");g.className="got";g.style.cssText="display:inline-block;margin-top:8px;padding:8px 15px;border:none;border-radius:10px;background:#2A2A2A;color:#fff;font-weight:800;font-size:13px;cursor:pointer";g.textContent="\\u2713 Done";';
  body += 'g.addEventListener("click",function(){if(!confirm("Mark this note done? It moves to the archive."))return;g.disabled=true;';
  body += 'fetch("/dashboard/notes/done?id="+a.id).then(function(r){return r.json()}).then(function(j){if(j.ok)n.remove();else g.disabled=false}).catch(function(){g.disabled=false})});';
  body += 'n.appendChild(g);nbox.appendChild(n)})}';
  body += 'function loadNotes(){fetch("/dashboard/notes").then(function(r){return r.json()}).then(renderNotes).catch(function(){})}';
  body += 'document.getElementById("addnote").addEventListener("click",function(e){e.preventDefault();';
  body += 'var t=prompt("What should the post-it say? (everyone will see it)");if(!t||!t.trim())return;';
  body += 'fetch("/dashboard/notes/add?text="+encodeURIComponent(t.trim())).then(function(r){return r.json()}).then(function(j){if(j.ok)loadNotes();else alert("Could not save the note")}).catch(function(){alert("Could not save the note")})});';
  body += 'loadNotes();setInterval(loadNotes,60000)})();</script>';
  // Supply-run post-its: poll every 60s; Got It tags the order in Shopify so it clears everywhere.
  body += '<script>(function(){var box=document.getElementById("supply-alerts");';
  body += 'function render(d){box.innerHTML="";(d.alerts||[]).slice(0,6).forEach(function(a){';
  body += 'var n=document.createElement("div");n.className="postit supply";';
  body += 'var h=document.createElement("div");var b=document.createElement("b");b.textContent="\\uD83D\\uDED2 "+a.name+" needs a store run";h.appendChild(b);';
  body += 'if(a.deliveryDate){var s=document.createElement("span");s.className="dd";s.textContent="  \\u2014 for "+a.deliveryDate;h.appendChild(s)}n.appendChild(h);';
  body += 'a.needs.forEach(function(x){var l=document.createElement("div");l.textContent=x.emoji+" "+x.what+" \\u2014 "+x.item+" \\u00d7"+x.qty;n.appendChild(l)});';
  body += 'var g=document.createElement("button");g.className="got";g.textContent="\\u2713 Got it \\u2014 items are covered";';
  body += 'g.addEventListener("click",function(){if(!confirm("Confirm: the items for "+a.name+" are bought / picked up?"))return;';
  body += 'g.disabled=true;fetch("/dashboard/supply-alerts/ack?id="+a.id).then(function(r){return r.json()}).then(function(j){if(j.ok)n.remove();else{g.disabled=false;alert("Could not save \\u2014 try again")}}).catch(function(){g.disabled=false;alert("Could not save \\u2014 try again")})});';
  body += 'n.appendChild(g);box.appendChild(n)})}';
  body += 'function load(){fetch("/dashboard/supply-alerts").then(function(r){return r.json()}).then(render).catch(function(){})}';
  body += 'load();setInterval(load,60000)})();</script>';

  body += '<div class="actionbar">';
  body += '<div class="searchwrap"><span class="mag">&#128269;</span>';
  body += '<input id="dashq" type="text" placeholder="Search &mdash; type here (order, label, gift&hellip;)">';
  body += '<button class="micbtn" id="dashmic" type="button" title="Talk instead of typing">&#127908;</button></div>';
  body += '<a class="askai light" href="/order-lookup" target="_blank" rel="noopener" data-kw="order lookup customer find status tracking track delivered delivery reschedule schedule where phone zip local help refund">&#128269; Order Lookup</a>';
  body += '<a class="askai" href="https://admin.shopify.com/store/thesweettoothfl" target="_blank" rel="noopener" data-kw="ask shopify ai sidekick help question how expert answer">&#10024; Ask Shopify AI</a>';
  body += '</div>';

  body += '<h2 class="sec">&#128424;&#65039; Invoices &amp; Gift Cards</h2><div class="grid">';
  body += dashTile('Edit or Reprint Invoice', '/dashboard/invoices', { emoji: '&#128424;&#65039;', newTab: true, kw: 'invoice receipt reprint print edit' });
  body += dashTile('Edit or Reprint Gift Card Message', '/dashboard', { emoji: '&#128140;', newTab: true, kw: 'gift card message edit reprint note' });
  body += dashTile('Create New Gift Card Message', '/dashboard/gift-card-new', { emoji: '&#127873;', newTab: true, kw: 'gift card message new create note' });
  body += dashTile('Sugar Paper Designer', 'https://sweet-tooth-layout-studio.netlify.app/', { emoji: '&#127912;', newTab: true, kw: 'sugar paper designer design edible image photo picture oreo' });
  body += dashTile('Stickers &amp; Labels', '/stickers', { emoji: '&#128278;', kw: 'sticker stickers label labels niimbot munbyn print gluten free dairy parve frozen hot chocolate pralines dubai hang tag mucho gusto munch circle pink basket guide making printable' });
  body += '</div>';

  body += '<div class="duo"><div class="half">';
  body += '<h2 class="sec">&#127978; Shop</h2><div class="grid">';
  body += dashTile('Supplies', '/supplies', { emoji: '&#128722;', kw: 'supplies buy boxes restock amazon uline order request vendor' });
  body += dashTile('Check Email', 'https://mail.google.com/mail/u/0/#inbox', { emoji: '&#128231;', newTab: true, kw: 'email mail inbox gmail check' });
  body += '</div></div><div class="half">';
  body += '<h2 class="sec">&#128666; Shipping</h2><div class="grid">';
  body += dashTile('Reprint Shipping Label', '/reprint-label', { emoji: '&#128230;', kw: 'label reprint print shipping ups didnt print again' });
  body += dashTile('Change Shipping Speed', '/switch-shipping', { emoji: '&#9889;', kw: 'shipping speed overnight faster upgrade next day second air switch express change slower' });
  body += dashTile('Create New Shipping Label', 'https://ship.shipstation.com/rates', { emoji: '&#128178;', newTab: true, sub: 'ShipStation', kw: 'shipping rates rate quote cost shipstation calculator how much price estimate create new label' });
  body += '</div></div></div>';

  body += '<h2 class="sec">&#128717;&#65039; Orders &amp; Customers</h2><div class="grid">';
  body += dashTile('Create a Draft Order', '/draft-order', { emoji: '&#129534;', kw: 'draft order phone charge pay payment custom quick sell collect money' });
  body += dashTile('Create a Discount Code', '/create-discount', { emoji: '&#127991;&#65039;', kw: 'discount code coupon promo percent off sorry deal' });
  body += '</div>';

  body += '<div class="search-miss" id="dashmiss">No tile for that &mdash; for Shopify questions, use Sidekick (the &#10024; icon) inside Shopify admin, or ask Mikey.</div>';

  body += '<script>(function(){var q=document.getElementById("dashq"),miss=document.getElementById("dashmiss");';
  body += 'var tiles=[].slice.call(document.querySelectorAll("[data-kw]"));';
  body += 'var secs=[].slice.call(document.querySelectorAll(".sec"));';
  body += 'q.addEventListener("input",function(){var v=q.value.trim().toLowerCase();var any=false;';
  body += 'tiles.forEach(function(t){var hit=!v||v.split(/\\s+/).every(function(w){return t.getAttribute("data-kw").indexOf(w)>-1});';
  body += 't.classList.toggle("dim",!hit);if(hit)any=true});';
  body += 'miss.style.display=(v&&!any)?"block":"none"});';
  // Voice search: Chrome's built-in speech recognition. Mic button hides if unsupported.
  body += 'var mic=document.getElementById("dashmic");var SR=window.SpeechRecognition||window.webkitSpeechRecognition;';
  body += 'if(!SR){mic.style.display="none"}else{mic.addEventListener("click",function(){var r=new SR();r.lang="en-US";';
  body += 'mic.classList.add("listening");mic.textContent="\\uD83D\\uDD34";';
  body += 'r.onresult=function(e){q.value=e.results[0][0].transcript;q.dispatchEvent(new Event("input"))};';
  body += 'r.onend=function(){mic.classList.remove("listening");mic.textContent="\\uD83C\\uDFA4"};';
  body += 'r.onerror=r.onend;r.start()})}';
  body += '})();</script>';

  res.send(dashPage('The Sweet Tooth — Employee Dashboard', null, body, null, null, true, true));
});

app.get('/supplies', (req, res) => {
  var tiles = '';
  tiles += dashTile('Buy Supplies', '/supplies/buy', { icon: 'cart' });
  tiles += dashTile('Request Supplies', 'https://script.google.com/macros/s/AKfycbxsgmwcpeCHOQE4XahyyMly3OyJ0qD506j0N3jyrZrJyOjuKQuLUrJn8oOXL-wrh4U3/exec', { newTab: true, icon: 'hand' });
  res.send(dashPage('Supplies', null, tiles, '/'));
});

app.get('/supplies/buy', (req, res) => {
  var body = '';
  body += '<h2 class="sec">&#127857; Food &amp; General</h2><div class="grid">';
  body += dashTile('Amazon', 'https://www.amazon.com', { newTab: true, emoji: '&#128230;' });
  body += dashTile('Restaurant Depot', 'https://www.restaurantdepot.com', { newTab: true, emoji: '&#127978;' });
  body += dashTile('Instacart (Costco)', 'https://www.instacart.com/store/costco/storefront', { newTab: true, emoji: '&#128717;&#65039;' });
  body += dashTile('Sam&#39;s Club', 'https://www.samsclub.com', { newTab: true, emoji: '&#128722;' });
  body += dashTile('Linnea&#39;s', 'https://linneasinc.com', { newTab: true, emoji: '&#127850;' });
  body += dashTile('Hialeah Products', 'https://www.newurbanfarms.com/', { newTab: true, emoji: '&#129746;' });
  body += dashTile('WebstaurantStore', 'https://www.webstaurantstore.com/myaccount/orders', { newTab: true, emoji: '&#127869;&#65039;' });
  body += '</div>';

  body += '<h2 class="sec">&#129530; Baskets, Boxes &amp; Packaging</h2><div class="grid">';
  body += dashTile('United Baskets', 'http://www.unitedbasketco.com/', { newTab: true, emoji: '&#129530;' });
  body += dashTile('Longhorn Imports (assorted baskets)', 'https://www.longhornimports.com/', { newTab: true, emoji: '&#127806;' });
  body += dashTile('Maryland Plastics (plastic trays)', 'https://www.marylandplastics.com/', { newTab: true, emoji: '&#127860;&#65039;' });
  body += dashTile('A Specialty Box (chocolate boxes)', 'https://aspecialtybox.com/', { newTab: true, emoji: '&#127873;' });
  body += dashTile('Nashville Wraps (Sweet Tooth bags)', 'https://www.nashvillewraps.com/', { newTab: true, emoji: '&#128717;&#65039;' });
  body += dashTile('Sweet Tooth Branded Ribbon (Etsy)', 'https://www.etsy.com/shop/GlobalHomeStudio', { newTab: true, emoji: '&#127872;' });
  body += dashTile('Crinkle Paper (shred)', 'https://crinklepaper.com/', { newTab: true, emoji: '&#127744;' });
  body += dashTile('Uline (ice packs)', 'https://www.uline.com/MyAccount/MyUline', { newTab: true, emoji: '&#129482;' });
  body += '</div>';

  res.send(dashPage('Buy Supplies', 'Restaurant Depot membership #: 1016417192', body, '/supplies', null, true));
});

// ============ ORDER LOOKUP ============

// Local delivery fees by ZIP — copied verbatim from the driver app's src/constants.ts
// (DELIVERY_FEES). If prices change there, update here too.
var DELIVERY_FEES = {
  "33004": 25, "33131": 25, "33196": 65,
  "33008": 20, "33132": 25, "33301": 25,
  "33009": 20, "33133": 25, "33302": 30,
  "33010": 25, "33134": 25, "33304": 25,
  "33011": 25, "33135": 25, "33305": 30,
  "33012": 25, "33136": 25, "33306": 30,
  "33013": 25, "33137": 20, "33307": 30,
  "33014": 25, "33138": 20, "33308": 30,
  "33015": 25, "33139": 25, "33309": 30,
  "33016": 25, "33140": 20, "33311": 30,
  "33018": 25, "33141": 20, "33312": 25,
  "33019": 20, "33142": 25, "33313": 30,
  "33020": 20, "33143": 30, "33314": 25,
  "33021": 20, "33144": 30, "33315": 25,
  "33022": 20, "33145": 25, "33316": 25,
  "33023": 20, "33146": 25, "33317": 30,
  "33024": 20, "33147": 20, "33319": 35,
  "33025": 20, "33149": 30, "33320": 35,
  "33026": 25, "33150": 20, "33321": 30,
  "33027": 25, "33154": 20, "33322": 30,
  "33028": 25, "33155": 30, "33323": 25,
  "33029": 30, "33156": 35, "33324": 30,
  "33030": 65, "33157": 50, "33325": 30,
  "33031": 65, "33158": 40, "33326": 30,
  "33032": 65, "33159": 30, "33327": 25,
  "33033": 65, "33160": 15, "33328": 25,
  "33034": 65, "33161": 20, "33330": 30,
  "33035": 65, "33162": 15, "33331": 30,
  "33039": 65, "33165": 35, "33332": 30,
  "33054": 20, "33166": 30, "33334": 30,
  "33055": 20, "33167": 20, "33351": 25,
  "33056": 20, "33168": 20, "33394": 65,
  "33060": 30, "33169": 20, "33426": 50,
  "33062": 30, "33170": 65, "33428": 50,
  "33063": 35, "33172": 30, "33431": 50,
  "33064": 35, "33173": 35, "33432": 50,
  "33065": 40, "33175": 35, "33433": 50,
  "33066": 35, "33176": 35, "33434": 65,
  "33067": 40, "33177": 65, "33435": 65,
  "33068": 35, "33178": 30, "33436": 65,
  "33069": 30, "33179": 15, "33437": 40,
  "33071": 35, "33180": 15, "33441": 40,
  "33073": 40, "33181": 20, "33442": 55,
  "33076": 40, "33182": 35, "33444": 55,
  "33101": 25, "33183": 40, "33445": 65,
  "33109": 40, "33184": 35, "33446": 65,
  "33122": 30, "33185": 40, "33472": 65,
  "33124": 25, "33186": 40, "33473": 55,
  "33125": 25, "33187": 65, "33484": 50,
  "33126": 30, "33189": 65, "33486": 55,
  "33127": 20, "33190": 65, "33487": 55,
  "33128": 25, "33192": 40, "33496": 55,
  "33129": 25, "33193": 40, "33498": 30,
  "33130": 25, "33194": 40
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Parse the driver app's st_* stamps off the order tags.
function parseDeliveryTags(order) {
  var out = {};
  (order.tags || '').split(',').forEach(function (raw) {
    var t = raw.trim();
    if (t.indexOf('st_status:') === 0) out.status = t.slice(10);
    if (t.indexOf('st_drivername:') === 0) out.driver = t.slice(14);
    if (t.indexOf('st_deliverydate:') === 0) out.deliveryDate = t.slice(16);
    if (t.indexOf('st_completed:') === 0) out.completed = t.slice(13);
  });
  return out;
}

// st_completed timestamps store the time with dashes (2026-07-03T20-43-55.073Z) -> real ISO.
function formatStCompleted(raw) {
  try {
    var parts = raw.split('T');
    var iso = parts[0] + 'T' + parts[1].replace(/^(\d{2})-(\d{2})-/, '$1:$2:');
    var d = new Date(iso);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return raw; }
}

function lookupShell(inner, q) {
  var html = '<!DOCTYPE html><html><head><title>Order Lookup — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:96px 24px 44px}';
  html += '.wrap{max-width:760px;margin:0 auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:29px;letter-spacing:-.5px;text-align:center}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 0}';
  html += '.searchbar{display:flex;gap:10px;margin:30px 0}';
  html += '.searchbar input{flex:1;padding:16px 18px;border:1.5px solid #E8E2E5;border-radius:14px;font-size:18px;background:#fff}.searchbar input:focus{outline:none;border-color:#F7B5CD}';
  html += '.searchbar button{padding:16px 28px;border:none;border-radius:14px;background:#2A2A2A;color:#fff;font-size:16px;font-weight:700;cursor:pointer}';
  html += '.card{background:#fff;border:1px solid #EFEBED;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.05);padding:22px 24px;margin-bottom:18px}';
  html += '.card h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#9B8A92;margin-bottom:12px}';
  html += '.row{display:flex;justify-content:space-between;gap:14px;padding:7px 0;font-size:15.5px}.row .k{color:#9B8A92;flex-shrink:0}.row .v{font-weight:600;text-align:right}';
  html += '.status-banner{border-radius:20px;padding:20px 24px;margin-bottom:18px;font-size:19px;font-weight:800;text-align:center;background:#fff;border:1px solid #EFEBED;box-shadow:0 2px 10px rgba(0,0,0,.05)}';
  html += '.status-banner .sub{display:block;font-size:14.5px;font-weight:600;color:#9B8A92;margin-top:6px}';
  html += '.status-banner.delivered{border-top:5px solid #F7B5CD}';
  html += '.item{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid #F5F1F3;font-size:15.5px}.item:last-child{border-bottom:none}.item .qty{font-weight:800}';
  html += '.trackbtn{display:inline-block;margin-top:10px;padding:13px 24px;background:#2A2A2A;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px}';
  html += '.muted{color:#9B8A92;font-size:15px}';
  html += '.err{background:#fff;border:1px solid #EFEBED;border-radius:20px;padding:26px;text-align:center;font-size:16.5px;font-weight:600}';
  html += '.toolout{margin-top:12px;font-size:22px;font-weight:800;text-align:center}';
  html += '.toolout .miss{font-size:15px;font-weight:600;color:#9B8A92}';
  html += '.phone-row{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid #F5F1F3;font-size:15.5px}.phone-row:last-child{border-bottom:none}';
  html += '.phone-row a{font-weight:800;color:#2A2A2A;text-decoration:none}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>Order Lookup</h1>';
  html += '<form class="searchbar" action="/order-lookup" method="get">';
  html += '<input type="text" name="q" placeholder="Order number, customer name, email, or phone" value="' + escapeHtml(q || '') + '" autofocus>';
  html += '<button type="submit">Look Up</button></form>';
  html += inner;

  // --- Quick tools: zip fee, UPS tracking, phones ---
  html += '<div class="card"><h2>Local Delivery Price by ZIP</h2>';
  html += '<div class="searchbar" style="margin:0"><input type="text" id="zipin" inputmode="numeric" maxlength="5" placeholder="ZIP code, like 33140"><button type="button" onclick="zipFee()">Get Price</button></div>';
  html += '<div class="toolout" id="zipout"></div></div>';

  html += '<div class="card"><h2>UPS Tracking</h2>';
  html += '<div class="searchbar" style="margin:0"><input type="text" id="upsin" placeholder="Paste a UPS tracking number"><button type="button" onclick="upsTrack()">Track on UPS</button></div></div>';

  html += '<div class="card"><h2>Phone Numbers</h2>';
  html += '<div class="phone-row"><span>UPS</span><a href="tel:18007425877">1-800-742-5877</a></div>';
  html += '<div class="phone-row"><span>Bernard (our UPS driver)</span><a href="tel:9545942577">(954) 594-2577</a></div></div>';

  html += '<script>';
  html += 'var FEES=' + JSON.stringify(DELIVERY_FEES) + ';';
  html += 'function zipFee(){var z=(document.getElementById("zipin").value||"").replace(/\\D/g,"").slice(0,5);var o=document.getElementById("zipout");';
  html += 'if(z.length<5){o.innerHTML=\'<span class="miss">Type a 5-digit ZIP code.</span>\';return}';
  html += 'if(FEES[z]!=null){o.textContent="$"+FEES[z]}else{o.innerHTML=\'<span class="miss">\'+z+\' is not in our local delivery table.</span>\'}}';
  html += 'document.getElementById("zipin").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();zipFee()}});';
  html += 'function upsTrack(){var n=(document.getElementById("upsin").value||"").trim();if(!n)return;window.open("https://www.ups.com/track?loc=en_US&tracknum="+encodeURIComponent(n),"_blank")}';
  html += 'document.getElementById("upsin").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();upsTrack()}});';
  html += '</script>';
  html += '</div></body></html>';
  return html;
}

app.get('/order-lookup', async (req, res) => {
  var q = (req.query.q || '').trim();
  if (!q) return res.send(lookupShell('', ''));

  try {
    var clean = q.replace(/[^0-9]/g, '');
    var hasLetters = /[a-zA-Z@]/.test(q);
    var order = null;

    if (!hasLetters && clean.length >= 4 && clean.length <= 6) {
      // Looks like an order number.
      var orders = await searchShopifyOrders('#' + clean);
      order = orders.filter(function (o) { return String(o.order_number) === clean || o.name === '#' + clean; })[0] || orders[0];
      if (!order) return res.send(lookupShell('<div class="err">No order found for &quot;' + escapeHtml(q) + '&quot;. Double-check the number.</div>', q));
    } else {
      // Customer search: name, email, or phone across recent orders.
      var needle = q.toLowerCase();
      var phoneNeedle = clean.length >= 7 ? clean : null;
      if (!hasLetters && !phoneNeedle) return res.send(lookupShell('<div class="err">Type an order number (like 36051), a customer name, an email, or a phone number.</div>', q));
      var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=250&fields=name,order_number,created_at,total_price,email,phone,customer,shipping_address';
      var r = await fetch(url, { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
      if (!r.ok) throw new Error('Shopify API error: ' + r.status);
      var digits = function (s) { return String(s || '').replace(/\D/g, ''); };
      var matches = ((await r.json()).orders || []).filter(function (o) {
        var c = o.customer || {};
        var sa = o.shipping_address || {};
        var names = (((c.first_name || '') + ' ' + (c.last_name || '')) + '|' + (sa.name || '')).toLowerCase();
        if (hasLetters && (names.indexOf(needle) > -1 || String(o.email || '').toLowerCase().indexOf(needle) > -1)) return true;
        if (phoneNeedle && (digits(o.phone).indexOf(phoneNeedle) > -1 || digits(c.phone).indexOf(phoneNeedle) > -1 || digits(sa.phone).indexOf(phoneNeedle) > -1)) return true;
        return false;
      });
      if (!matches.length) return res.send(lookupShell('<div class="err">No orders found for &quot;' + escapeHtml(q) + '&quot; in the last 250 orders. Try another spelling, or the order number.</div>', q));
      if (matches.length > 1) {
        var list = '<div class="card"><h2>' + matches.length + ' orders match &quot;' + escapeHtml(q) + '&quot; — pick one</h2>';
        matches.slice(0, 20).forEach(function (o) {
          var c2 = o.customer || {};
          var who = ((c2.first_name || '') + ' ' + (c2.last_name || '')).trim() || (o.shipping_address && o.shipping_address.name) || '';
          var when = new Date(o.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
          list += '<div class="phone-row"><span>' + escapeHtml(o.name) + ' &middot; ' + escapeHtml(who) + ' <span class="muted">' + when + ' &middot; $' + escapeHtml(o.total_price) + '</span></span><a href="/order-lookup?q=' + o.order_number + '">Open &rarr;</a></div>';
        });
        if (matches.length > 20) list += '<div class="muted" style="margin-top:10px">Showing the newest 20.</div>';
        list += '</div>';
        return res.send(lookupShell(list, q));
      }
      // Exactly one match — refetch with full details.
      var full = await searchShopifyOrders('#' + matches[0].order_number);
      order = full.filter(function (o) { return o.order_number === matches[0].order_number; })[0];
      if (!order) return res.send(lookupShell('<div class="err">Found ' + escapeHtml(matches[0].name) + ' but could not load it. Try the number directly.</div>', q));
    }

    var st = parseDeliveryTags(order);
    var method = (order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].title) || '';
    var mLow = method.toLowerCase();
    var isLocal = mLow.indexOf('local delivery') > -1;
    var isPickup = mLow.indexOf('pick') > -1;
    var trackings = (order.fulfillments || []).filter(function (f) { return f.tracking_number; });

    var inner = '';

    // --- Status banner ---
    var banner = '', sub = '', delivered = false;
    if (st.status === 'DELIVERED') {
      delivered = true;
      banner = '&#10004; DELIVERED';
      sub = (st.completed ? formatStCompleted(st.completed) : '') + (st.driver ? ' &middot; by ' + escapeHtml(st.driver) : '');
    } else if (isLocal) {
      banner = 'NOT DELIVERED YET';
      sub = st.deliveryDate ? 'Local delivery scheduled for ' + escapeHtml(st.deliveryDate) : 'Local delivery — no date set yet';
      if (st.status) sub += ' &middot; status: ' + escapeHtml(st.status);
    } else if (isPickup) {
      banner = 'PICK UP ORDER';
      sub = order.fulfillment_status === 'fulfilled' ? 'Marked fulfilled' : 'Waiting for customer pickup';
    } else if (trackings.length) {
      banner = 'SHIPPED';
      sub = 'Tracking below' + (order.fulfillment_status ? ' &middot; Shopify: ' + escapeHtml(order.fulfillment_status) : '');
    } else {
      banner = 'NOT SHIPPED / NOT DELIVERED YET';
      sub = method ? escapeHtml(method) : 'No shipping method on this order';
    }
    inner += '<div class="status-banner' + (delivered ? ' delivered' : '') + '">' + banner + '<span class="sub">' + sub + '</span></div>';

    // --- Order details ---
    var c = order.customer || {};
    var custName = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || (order.shipping_address && order.shipping_address.name) || '—';
    inner += '<div class="card"><h2>Order ' + escapeHtml(order.name) + '</h2>';
    inner += '<div class="row"><span class="k">Placed</span><span class="v">' + new Date(order.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span></div>';
    inner += '<div class="row"><span class="k">Customer</span><span class="v">' + escapeHtml(custName) + '</span></div>';
    if (order.email) inner += '<div class="row"><span class="k">Email</span><span class="v">' + escapeHtml(order.email) + '</span></div>';
    if (order.phone || c.phone) inner += '<div class="row"><span class="k">Phone</span><span class="v">' + escapeHtml(order.phone || c.phone) + '</span></div>';
    inner += '<div class="row"><span class="k">Payment</span><span class="v">' + escapeHtml((order.financial_status || '—').toUpperCase()) + ' &middot; $' + escapeHtml(order.total_price) + '</span></div>';
    if (method) inner += '<div class="row"><span class="k">Method</span><span class="v">' + escapeHtml(method) + '</span></div>';
    inner += '</div>';

    // --- Items (tips never shown — same rule as invoices) ---
    inner += '<div class="card"><h2>Items</h2>';
    (order.line_items || []).forEach(function (li) {
      if ((li.title || '').toLowerCase().indexOf('tip') > -1) return;
      inner += '<div class="item"><span><span class="qty">' + li.quantity + '&times;</span> ' + escapeHtml(li.title) + '</span><span>$' + escapeHtml(li.price) + '</span></div>';
    });
    inner += '</div>';

    // --- Address ---
    var a = order.shipping_address;
    if (a) {
      inner += '<div class="card"><h2>' + (isLocal ? 'Deliver To' : (isPickup ? 'Customer' : 'Ship To')) + '</h2>';
      inner += '<div style="font-size:15.5px;line-height:1.65">' + escapeHtml(a.name || '') + '<br>' + escapeHtml(a.address1 || '');
      if (a.address2) inner += ', ' + escapeHtml(a.address2);
      inner += '<br>' + escapeHtml(a.city || '') + ', ' + escapeHtml(a.province_code || '') + ' ' + escapeHtml(a.zip || '');
      if (a.phone) inner += '<br>&#9742; ' + escapeHtml(a.phone);
      inner += '</div></div>';
    }

    // --- UPS tracking ---
    if (trackings.length) {
      inner += '<div class="card"><h2>UPS Tracking</h2>';
      trackings.forEach(function (f) {
        var num = f.tracking_number;
        var url = (f.tracking_urls && f.tracking_urls[0]) || f.tracking_url || ('https://www.ups.com/track?loc=en_US&tracknum=' + encodeURIComponent(num));
        inner += '<div class="row"><span class="k">' + escapeHtml(f.tracking_company || 'Carrier') + '</span><span class="v">' + escapeHtml(num) + '</span></div>';
        inner += '<a class="trackbtn" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Track on UPS</a>';
      });
      inner += '</div>';
    } else if (!isLocal && !isPickup) {
      inner += '<div class="card"><h2>UPS Tracking</h2><div class="muted">No tracking number on this order yet.</div></div>';
    }

    // --- Local delivery info ---
    if (isLocal) {
      inner += '<div class="card"><h2>Local Delivery</h2>';
      inner += '<div class="row"><span class="k">Delivery date</span><span class="v">' + (st.deliveryDate ? escapeHtml(st.deliveryDate) : '—') + '</span></div>';
      inner += '<div class="row"><span class="k">Driver</span><span class="v">' + (st.driver ? escapeHtml(st.driver) : '—') + '</span></div>';
      inner += '<div class="row"><span class="k">Delivered at</span><span class="v">' + (st.completed ? formatStCompleted(st.completed) : 'Not delivered yet') + '</span></div>';
      inner += '</div>';
    }

    res.send(lookupShell(inner, q));
  } catch (err) {
    console.error('order-lookup error:', err.message);
    res.send(lookupShell('<div class="err">Something went wrong looking that up: ' + escapeHtml(err.message) + '</div>', q));
  }
});

// ============ CREATE A DRAFT ORDER ============

// Diagnostic: does this app's token have draft-order permission?
app.get('/draft-order/scope-check', async (req, res) => {
  try {
    var r = await fetch('https://' + CONFIG.shopify.store + '/admin/oauth/access_scopes.json',
      { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var handles = ((await r.json()).access_scopes || []).map(function (s) { return s.handle; });
    res.json({ canCreateDraftOrders: handles.indexOf('write_draft_orders') > -1, draftScopes: handles.filter(function (h) { return h.indexOf('draft') > -1; }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Product search for the picker (server-side substring filter on active products).
app.get('/draft-order/products', async (req, res) => {
  try {
    var q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ products: [] });
    var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/products.json?status=active&limit=250&fields=id,title,variants';
    var r = await fetch(url, { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!r.ok) throw new Error('Shopify API error: ' + r.status);
    var products = ((await r.json()).products || []).filter(function (p) {
      return (p.title || '').toLowerCase().indexOf(q) > -1;
    }).slice(0, 12).map(function (p) {
      return {
        title: p.title,
        variants: (p.variants || []).map(function (v) {
          return { id: v.id, title: v.title === 'Default Title' ? '' : v.title, price: v.price };
        })
      };
    });
    res.json({ products: products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create the draft order in Shopify.
app.post('/draft-order/create', async (req, res) => {
  try {
    var items = req.body.items || [];
    if (!items.length) return res.status(400).json({ error: 'No items on the order.' });
    var lineItems = items.map(function (it) {
      var qty = Math.max(1, parseInt(it.qty, 10) || 1);
      if (it.variantId) return { variant_id: it.variantId, quantity: qty };
      // requires_shipping keeps Shopify from dropping a custom shipping/delivery line.
      return { title: String(it.title || 'Custom item'), price: String(parseFloat(it.price) || 0), quantity: qty, requires_shipping: true };
    });
    var draft = { line_items: lineItems, tags: 'st_dashboard' };
    if (req.body.email) draft.email = String(req.body.email).trim();
    if (req.body.note) draft.note = String(req.body.note).trim();

    var ship = req.body.shipping || {};
    var shipPrice = parseFloat(ship.price);
    if (!isNaN(shipPrice) && shipPrice >= 0 && (ship.price !== '' && ship.price != null)) {
      draft.shipping_line = { title: String(ship.title || 'Shipping / Delivery'), price: shipPrice.toFixed(2), custom: true };
    }

    var disc = req.body.discount || {};
    var discVal = parseFloat(disc.value);
    if (!isNaN(discVal) && discVal > 0) {
      var subtotal = items.reduce(function (s, it) {
        return s + (parseFloat(it.price) || 0) * Math.max(1, parseInt(it.qty, 10) || 1);
      }, 0);
      var isPct = disc.type === 'percent';
      var amount = isPct ? subtotal * discVal / 100 : discVal;
      draft.applied_discount = {
        title: String(disc.reason || 'Discount'),
        description: String(disc.reason || 'Discount'),
        value_type: isPct ? 'percentage' : 'fixed_amount',
        value: String(discVal),
        amount: amount.toFixed(2)
      };
    }
    var r = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/draft_orders.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_order: draft })
    });
    var j = await r.json();
    if (!r.ok || j.errors) throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : (j.errors || 'Shopify error ' + r.status));
    var d = j.draft_order;
    res.json({
      ok: true,
      id: d.id,
      name: d.name,
      total: d.total_price,
      hasEmail: !!d.email,
      adminUrl: 'https://admin.shopify.com/store/' + CONFIG.shopify.store.replace('.myshopify.com', '') + '/draft_orders/' + d.id,
      invoiceUrl: d.invoice_url || null
    });
  } catch (e) {
    console.error('draft-order create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Email the Shopify invoice (pay link) to the customer on the draft.
app.post('/draft-order/send-invoice', async (req, res) => {
  try {
    var id = String(req.body.id || '').replace(/\D/g, '');
    if (!id) return res.status(400).json({ error: 'Missing draft order id.' });
    var r = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/draft_orders/' + id + '/send_invoice.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_order_invoice: {} })
    });
    var j = await r.json();
    if (!r.ok || j.errors) throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : (j.errors || 'Shopify error ' + r.status));
    res.json({ ok: true, to: (j.draft_order_invoice && j.draft_order_invoice.to) || null });
  } catch (e) {
    console.error('send-invoice error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/draft-order', (req, res) => {
  var html = '<!DOCTYPE html><html><head><title>Create a Draft Order — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:96px 24px 44px}';
  html += '.wrap{max-width:760px;margin:0 auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:29px;letter-spacing:-.5px;text-align:center}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 30px}';
  html += '.card{background:#fff;border:1px solid #EFEBED;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.05);padding:22px 24px;margin-bottom:18px}';
  html += '.card h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#9B8A92;margin-bottom:14px}';
  html += 'input{padding:13px 15px;border:1.5px solid #E8E2E5;border-radius:12px;font-size:16px;background:#fff;width:100%}input:focus{outline:none;border-color:#F7B5CD}';
  html += '.inline{display:flex;gap:10px}.inline input.qty{width:86px;flex-shrink:0}.inline input.price{width:120px;flex-shrink:0}';
  html += '.btn{padding:13px 22px;border:none;border-radius:12px;background:#2A2A2A;color:#fff;font-size:15px;font-weight:700;cursor:pointer;flex-shrink:0}';
  html += '.btn:disabled{opacity:.4;cursor:default}';
  html += '.btn-big{width:100%;padding:18px;font-size:18px;border-radius:14px;margin-top:4px}';
  html += '.result{margin-top:10px}';
  html += '.hit{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 4px;border-bottom:1px solid #F5F1F3;font-size:15px}.hit:last-child{border-bottom:none}';
  html += '.hit .add{padding:8px 16px;font-size:13.5px;border-radius:9px}';
  html += '.cart-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #F5F1F3;font-size:15.5px}.cart-row:last-child{border-bottom:none}';
  html += '.cart-row .t{flex:1;font-weight:600}.cart-row input.q{width:70px;padding:8px;text-align:center}.cart-row .p{width:90px;text-align:right;font-weight:700}';
  html += '.cart-row .x{background:none;border:none;color:#C94F7C;font-size:20px;font-weight:800;cursor:pointer;padding:4px 8px}';
  html += '.total-row{display:flex;justify-content:space-between;font-size:17px;font-weight:800;padding-top:14px}';
  html += '.muted{color:#9B8A92;font-size:14.5px}';
  html += '.success{border-top:5px solid #F7B5CD;text-align:center;padding:30px 24px}';
  html += '.success .big{font-size:22px;font-weight:800;margin-bottom:6px}';
  html += '.success a{display:inline-block;margin:14px 6px 0;padding:14px 24px;background:#2A2A2A;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px}';
  html += '.errbox{background:#fff;border:1.5px solid #C94F7C;border-radius:14px;padding:14px 18px;margin-bottom:18px;font-weight:600;display:none}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>Create a Draft Order</h1>';
  html += '<div id="errbox" class="errbox"></div>';
  html += '<div id="form-area">';

  html += '<div class="card"><h2>Add From the Store</h2>';
  html += '<div class="inline"><input type="text" id="psearch" placeholder="Search products, like &quot;pretzel&quot;"><button class="btn" onclick="searchProducts()">Search</button></div>';
  html += '<div class="result" id="presults"></div></div>';

  html += '<div class="card"><h2>Quick Add — Manual Item</h2>';
  html += '<div class="inline"><input type="text" id="mtitle" placeholder="Item name, like &quot;Menu item&quot;"><input class="qty" type="number" id="mqty" min="1" value="1" placeholder="Qty"><input class="price" type="number" id="mprice" min="0" step="0.01" placeholder="$ each"><button class="btn" onclick="addManual()">Add</button></div>';
  html += '<div class="muted" style="margin-top:10px">Example: 30 &times; $8 &rarr; type the name, qty 30, price 8.</div></div>';

  html += '<div class="card"><h2>Order Items</h2><div id="cart"><div class="muted">Nothing added yet.</div></div><div class="total-row" id="totalrow" style="display:none"><span>Total</span><span id="total"></span></div></div>';

  html += '<div class="card"><h2>Shipping or Delivery (optional)</h2>';
  html += '<div class="inline"><input type="text" id="shiptitle" placeholder="Name it, like &quot;Local Delivery&quot; or &quot;UPS 2nd Day&quot;"><input class="price" type="number" id="shipprice" min="0" step="0.01" placeholder="$ price"></div>';
  html += '<div class="muted" style="margin-top:10px">Tip: get the local price from the ZIP box on Order Lookup.</div></div>';

  html += '<div class="card"><h2>Discount (optional)</h2>';
  html += '<div class="inline" style="flex-wrap:wrap"><input class="price" type="number" id="discval" min="0" step="0.01" placeholder="Amount"><select id="disctype" style="width:120px;flex-shrink:0;padding:13px 10px;border:1.5px solid #E8E2E5;border-radius:12px;font-size:15px;background:#fff"><option value="fixed">$ off</option><option value="percent">% off</option></select><input type="text" id="discreason" style="min-width:220px;flex:1" placeholder="Reason, like &quot;Manager comp&quot;"></div></div>';

  html += '<div class="card"><h2>Customer (optional)</h2>';
  html += '<div class="inline"><input type="email" id="cemail" placeholder="Customer email (needed to email the invoice)"></div>';
  html += '<div style="margin-top:10px"><input type="text" id="cnote" placeholder="Note on the order"></div></div>';

  html += '<button class="btn btn-big" id="createbtn" onclick="createDraft()">Create Draft Order in Shopify</button>';
  html += '<div class="muted" style="text-align:center;margin:12px 0 40px">This makes a DRAFT — nothing is charged and no invoice prints.</div>';
  html += '</div>';
  html += '<div id="done"></div>';

  html += '<script>';
  html += 'var cart = [];';
  html += 'function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML}';
  html += 'function showErr(m){var b=document.getElementById("errbox");b.textContent=m;b.style.display=m?"block":"none";if(m)window.scrollTo(0,0)}';
  html += 'function renderCart(){var el=document.getElementById("cart");if(!cart.length){el.innerHTML=\'<div class="muted">Nothing added yet.</div>\';document.getElementById("totalrow").style.display="none";return}';
  html += 'var h="";cart.forEach(function(it,i){h+=\'<div class="cart-row"><span class="t">\'+esc(it.title)+\'</span><input class="q" type="number" min="1" value="\'+it.qty+\'" onchange="setQty(\'+i+\',this.value)"><span class="p">$\'+(it.price*it.qty).toFixed(2)+\'</span><button class="x" onclick="removeItem(\'+i+\')" title="Remove">&times;</button></div>\'});';
  html += 'el.innerHTML=h;var tot=cart.reduce(function(s,it){return s+it.price*it.qty},0);document.getElementById("total").textContent="$"+tot.toFixed(2);document.getElementById("totalrow").style.display="flex"}';
  html += 'function setQty(i,v){cart[i].qty=Math.max(1,parseInt(v,10)||1);renderCart()}';
  html += 'function removeItem(i){cart.splice(i,1);renderCart()}';
  html += 'function addManual(){var t=document.getElementById("mtitle").value.trim();var q=Math.max(1,parseInt(document.getElementById("mqty").value,10)||1);var p=parseFloat(document.getElementById("mprice").value);';
  html += 'if(!t){showErr("Type a name for the manual item.");return}if(isNaN(p)||p<0){showErr("Type a price for the manual item.");return}showErr("");';
  html += 'cart.push({title:t,qty:q,price:p});document.getElementById("mtitle").value="";document.getElementById("mqty").value=1;document.getElementById("mprice").value="";renderCart()}';
  html += 'async function searchProducts(){var q=document.getElementById("psearch").value.trim();var out=document.getElementById("presults");if(q.length<2){out.innerHTML=\'<div class="muted" style="padding-top:8px">Type at least 2 letters.</div>\';return}';
  html += 'out.innerHTML=\'<div class="muted" style="padding-top:8px">Searching&hellip;</div>\';';
  html += 'try{var r=await fetch("/draft-order/products?q="+encodeURIComponent(q));var j=await r.json();if(j.error)throw new Error(j.error);';
  html += 'if(!j.products.length){out.innerHTML=\'<div class="muted" style="padding-top:8px">No products found.</div>\';return}';
  html += 'var h="";j.products.forEach(function(p){p.variants.forEach(function(v){var label=p.title+(v.title?" — "+v.title:"");';
  html += 'h+=\'<div class="hit"><span>\'+esc(label)+\' <span class="muted">$\'+esc(v.price)+\'</span></span><button class="btn add" onclick=\\\'addVariant(\'+JSON.stringify(JSON.stringify({id:v.id,label:label,price:v.price}))+\')\\\'>Add</button></div>\'})});';
  html += 'out.innerHTML=h}catch(e){out.innerHTML="";showErr("Product search failed: "+e.message)}}';
  html += 'function addVariant(json){var v=JSON.parse(json);showErr("");cart.push({title:v.label,qty:1,price:parseFloat(v.price)||0,variantId:v.id});renderCart()}';
  html += 'document.getElementById("psearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();searchProducts()}});';
  html += 'async function createDraft(){if(!cart.length){showErr("Add at least one item first.");return}showErr("");var btn=document.getElementById("createbtn");btn.disabled=true;btn.textContent="Creating\\u2026";';
  html += 'try{var payload={items:cart,email:document.getElementById("cemail").value.trim(),note:document.getElementById("cnote").value.trim(),';
  html += 'shipping:{title:document.getElementById("shiptitle").value.trim(),price:document.getElementById("shipprice").value},';
  html += 'discount:{value:document.getElementById("discval").value,type:document.getElementById("disctype").value,reason:document.getElementById("discreason").value.trim()}};';
  html += 'var r=await fetch("/draft-order/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});';
  html += 'var j=await r.json();if(!r.ok||j.error)throw new Error(j.error||"Server error");';
  html += 'document.getElementById("form-area").style.display="none";';
  html += 'var d=document.getElementById("done");d.innerHTML=\'<div class="card success"><div class="big">&#10004; Draft \'+esc(j.name)+\' created</div><div class="muted">Total $\'+esc(j.total)+\' &middot; sitting in Shopify as a draft</div><a href="\'+esc(j.adminUrl)+\'" target="_blank" rel="noopener">Open in Shopify</a>\'+(j.invoiceUrl?\'<a href="\'+esc(j.invoiceUrl)+\'" target="_blank" rel="noopener">Customer Pay Link</a>\':"")+(j.hasEmail?\'<a href="#" id="sendinv" onclick="sendInvoice(\'+j.id+\');return false">Email Invoice to Customer</a>\':\'<div class="muted" style="margin-top:12px">No email on this draft &mdash; add one next time to email the invoice from here.</div>\')+\'<br><a href="/draft-order" style="background:#fff;color:#2A2A2A;border:1.5px solid #E8E2E5">Start Another</a></div>\';}';
  html += 'catch(e){showErr("Could not create the draft order: "+e.message);btn.disabled=false;btn.textContent="Create Draft Order in Shopify"}}';
  html += 'async function sendInvoice(id){var b=document.getElementById("sendinv");b.textContent="Sending\\u2026";';
  html += 'try{var r=await fetch("/draft-order/send-invoice",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})});var j=await r.json();';
  html += 'if(!r.ok||j.error)throw new Error(j.error||"Server error");b.textContent="\\u2714 Invoice emailed"+(j.to?" to "+j.to:"");b.onclick=function(){return false}}';
  html += 'catch(e){b.textContent="Email Invoice to Customer";showErr("Could not email the invoice: "+e.message)}}';
  html += '</script>';
  html += '</div></body></html>';
  res.send(html);
});

// ============ REPRINT SHIPPING LABEL (one-click employee page) ============
// Re-sends a label that was ALREADY bought in Shippo. It never buys, so it can't double-charge.
function reprintShell(inner, q, pstate) {
  var online = pstate === 'online';
  var html = '<!DOCTYPE html><html><head><title>Reprint Shipping Label — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:96px 24px 44px}';
  html += '.wrap{max-width:640px;margin:0 auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:29px;letter-spacing:-.5px;text-align:center}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 0}';
  html += '.pill{display:flex;align-items:center;justify-content:center;gap:9px;font-size:14.5px;font-weight:700;background:#fff;border:1px solid #EFEBED;border-radius:14px;padding:12px 16px;margin:28px 0 0}';
  html += '.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}.dot.ok{background:#2E9E5B}.dot.bad{background:#C4423A}';
  html += '.searchbar{display:flex;gap:10px;margin:16px 0 18px}';
  html += '.searchbar input{flex:1;padding:16px 18px;border:1.5px solid #E8E2E5;border-radius:14px;font-size:18px;background:#fff}.searchbar input:focus{outline:none;border-color:#F7B5CD}';
  html += '.searchbar button{padding:16px 28px;border:none;border-radius:14px;background:#2A2A2A;color:#fff;font-size:16px;font-weight:700;cursor:pointer}';
  html += '.note{background:#fff;border:1px solid #EFEBED;border-radius:20px;padding:24px;text-align:center;font-size:16px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.05);margin-bottom:18px}';
  html += '.note.good{border-top:5px solid #F7B5CD}';
  html += '.note .big{font-size:21px;font-weight:800;margin-bottom:8px}';
  html += '.note .muted{color:#9B8A92;font-size:14.5px;font-weight:600;margin-top:10px;line-height:1.5}';
  html += '.hint{color:#9B8A92;font-size:14.5px;text-align:center;line-height:1.6}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>Reprint Shipping Label</h1>';
  html += '<div class="pill"><span class="dot ' + (online ? 'ok' : 'bad') + '"></span>' +
    (online ? 'Label printer is online' : 'Label printer is ' + escapeHtml(pstate) + ' &mdash; it will print when it reconnects') + '</div>';
  html += '<form class="searchbar" action="/reprint-label" method="get">';
  html += '<input type="text" name="order" inputmode="numeric" placeholder="Order number, like 36226" value="' + escapeHtml(q || '') + '" autofocus>';
  html += '<button type="submit">Reprint Label</button></form>';
  html += inner;
  html += '<div class="hint">This reprints the label that was already bought for the order.<br>It never buys a new one, so it can&#39;t charge you twice.</div>';
  html += '</div></body></html>';
  return html;
}

// Read-only rate quote for an order (JSON). Never buys a label, never charges anything.
app.get('/dashboard/rate-quote/:name', async (req, res) => {
  try {
    var clean = String(req.params.name).replace(/[^0-9]/g, '');
    var orders = await searchShopifyOrders('#' + clean);
    var order = (orders || []).filter(function (o) { return String(o.order_number) === clean; })[0];
    if (!order) return res.status(404).json({ error: 'Order ' + clean + ' not found' });
    var rates = await quoteRatesForOrder(order);
    rates.sort(function (a, b) { return parseFloat(a.amount) - parseFloat(b.amount); });
    res.json({ order: order.name, rates: rates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/reprint-label', async (req, res) => {
  var q = (req.query.order || '').trim();
  var pstate = await printerState(CONFIG.printNode.labelPrinterId);
  if (!q) return res.send(reprintShell('', '', pstate));
  try {
    var clean = q.replace(/[^0-9]/g, '');
    if (!clean) return res.send(reprintShell('<div class="note">Type an order number, like 36226.</div>', q, pstate));

    var orders = await searchShopifyOrders('#' + clean);
    var order = (orders || []).filter(function (o) { return String(o.order_number) === clean || o.name === '#' + clean; })[0];
    if (!order) return res.send(reprintShell('<div class="note"><div class="big">Order not found</div>Nothing matches &quot;' + escapeHtml(q) + '&quot;. Double-check the number.</div>', q, pstate));

    var trk = null;
    (order.fulfillments || []).forEach(function (f) { if (f.tracking_number) trk = f.tracking_number; });
    if (!trk) {
      return res.send(reprintShell('<div class="note"><div class="big">No label to reprint</div>' + escapeHtml(order.name) +
        ' doesn&#39;t have a shipping label yet.<div class="muted">Nothing was printed and nothing was charged. Buy the label the usual way first.</div></div>', q, pstate));
    }

    var lab = await reprintLabelByTracking(trk);
    await sendToPrintNode(lab.labelBase64, CONFIG.printNode.labelPrinterId, 'REPRINT ' + order.name);
    delete queuedWhileOffline[order.name];

    res.send(reprintShell('<div class="note good"><div class="big">&#10004; Label sent to the printer</div>' +
      escapeHtml(order.name) + ' &middot; ' + escapeHtml(trk) +
      '<div class="muted">No charge &mdash; this is the label that was already bought.' +
      (pstate === 'online' ? '' : '<br>The printer is ' + escapeHtml(pstate) + ' right now, so it will come out once it reconnects.') +
      '</div></div>', q, pstate));
  } catch (e) {
    res.send(reprintShell('<div class="note"><div class="big">Couldn&#39;t reprint</div>' + escapeHtml(e.message) +
      '<div class="muted">Nothing was charged.</div></div>', q, pstate));
  }
});

// ============ CHANGE SHIPPING SPEED (void old label -> buy new service -> print -> fix tracking) ============
function switchShell(inner, q) {
  var html = '<!DOCTYPE html><html><head><title>Change Shipping Speed — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:96px 24px 44px}';
  html += '.wrap{max-width:640px;margin:0 auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:29px;letter-spacing:-.5px;text-align:center}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 0}';
  html += '.searchbar{display:flex;gap:10px;margin:28px 0 18px}';
  html += '.searchbar input{flex:1;padding:16px 18px;border:1.5px solid #E8E2E5;border-radius:14px;font-size:18px;background:#fff}.searchbar input:focus{outline:none;border-color:#F7B5CD}';
  html += '.searchbar button{padding:16px 28px;border:none;border-radius:14px;background:#2A2A2A;color:#fff;font-size:16px;font-weight:700;cursor:pointer}';
  html += '.card{background:#fff;border:1px solid #EFEBED;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.05);padding:22px 24px;margin-bottom:18px}';
  html += '.card h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#9B8A92;margin-bottom:12px}';
  html += '.rate-row{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid #F5F1F3;font-size:15.5px}.rate-row:last-child{border-bottom:none}';
  html += '.rate-row .svc{font-weight:700}.rate-row .eta{color:#9B8A92;font-size:13.5px;font-weight:600}';
  html += '.rate-row a{flex-shrink:0;padding:10px 18px;background:#2A2A2A;color:#fff;border-radius:10px;text-decoration:none;font-weight:800;font-size:14.5px}';
  html += '.note{background:#fff;border:1px solid #EFEBED;border-radius:20px;padding:24px;text-align:center;font-size:16px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.05);margin-bottom:18px}';
  html += '.note.good{border-top:5px solid #F7B5CD}';
  html += '.note .big{font-size:21px;font-weight:800;margin-bottom:8px}';
  html += '.note .muted{color:#9B8A92;font-size:14.5px;font-weight:600;margin-top:10px;line-height:1.5}';
  html += '.steps{text-align:left;font-size:15px;font-weight:600;line-height:2}';
  html += '.hint{color:#9B8A92;font-size:14.5px;text-align:center;line-height:1.6}';
  html += '.owe-inline{color:#C4423A;font-weight:800;font-size:13.5px}';
  html += '.owe{background:#fff;border:1px solid #EFEBED;border-top:6px solid #C4423A;border-radius:20px;padding:26px 24px;margin-bottom:18px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.05)}';
  html += '.owe-title{font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#C4423A}';
  html += '.owe .amt{font-size:46px;font-weight:800;color:#C4423A;margin:8px 0 2px}';
  html += '.owe-sub{color:#6B5B62;font-size:14.5px;font-weight:600;line-height:1.6;margin:10px 0 18px}';
  html += '.paybtn{display:inline-block;padding:14px 26px;background:#C4423A;color:#fff;border-radius:12px;text-decoration:none;font-weight:800;font-size:15.5px}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>Change Shipping Speed</h1>';
  html += '<form class="searchbar" action="/switch-shipping" method="get">';
  html += '<input type="text" name="order" inputmode="numeric" placeholder="Order number, like 36229" value="' + escapeHtml(q || '') + '" autofocus>';
  html += '<button type="submit">Show Prices</button></form>';
  html += inner;
  html += '<div class="hint">Picking a new speed refunds the old unused label and buys the new one.<br>The customer is emailed their new tracking number automatically.</div>';
  html += '</div></body></html>';
  return html;
}

// What the customer owes for an upgrade: (new label cost - what they paid at checkout) + 10%.
// Never negative — a cheaper label just means no extra charge (we don't refund the difference here).
function upgradeCharge(newAmount, customerPaid) {
  var diff = parseFloat(newAmount) - parseFloat(customerPaid || 0);
  if (!(diff > 0.009)) return 0;
  return Math.round(diff * 1.10 * 100) / 100;
}

// Update the tracking number on an order's EXISTING fulfillment (order already fulfilled once).
async function updateTrackingOnFulfillment(order, label) {
  var f = (order.fulfillments || []).filter(function (x) { return x.status === 'success'; }).pop();
  if (!f) throw new Error('No fulfillment on ' + order.name + ' to update');
  var res = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2025-01/fulfillments/' + f.id + '/update_tracking.json', {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fulfillment: {
      notify_customer: true,
      tracking_info: { number: label.tracking, company: label.carrier, url: label.trackingUrl || undefined }
    } })
  });
  var j = await res.json();
  if (!res.ok || j.errors) throw new Error(JSON.stringify(j.errors || j));
}

app.get('/switch-shipping', async (req, res) => {
  var q = (req.query.order || '').trim();
  if (!q) return res.send(switchShell('', ''));
  try {
    var clean = q.replace(/[^0-9]/g, '');
    if (!clean) return res.send(switchShell('<div class="note">Type an order number, like 36229.</div>', q));
    var orders = await searchShopifyOrders('#' + clean);
    var order = (orders || []).filter(function (o) { return String(o.order_number) === clean; })[0];
    if (!order) return res.send(switchShell('<div class="note"><div class="big">Order not found</div>Nothing matches &quot;' + escapeHtml(q) + '&quot;.</div>', q));

    var trk = null;
    (order.fulfillments || []).forEach(function (f) { if (f.tracking_number) trk = f.tracking_number; });

    // ---- EXECUTE (came from a Switch button; guard against refresh double-buys) ----
    if (req.query.token && req.query.confirm === '1') {
      if ((req.query.from || 'none') !== (trk || 'none')) {
        return res.send(switchShell('<div class="note"><div class="big">Already switched</div>This order&#39;s label has changed since that page was loaded. Look it up again to see the current state.</div>', q));
      }
      var steps = '';
      var voidNote = '';
      if (trk) {
        var v = await voidLabelByTracking(trk);
        voidNote = '&#10004; Old label ' + escapeHtml(trk) + ' refund requested (' + escapeHtml(v.status || 'submitted') + (v.amount ? ', $' + escapeHtml(v.amount) + ' coming back' : '') + ')<br>';
      }
      var lab = await buyLabelWithService(order, req.query.token);
      steps += voidNote;
      steps += '&#10004; New label bought: ' + escapeHtml(lab.carrier + ' ' + lab.service) + ' &mdash; $' + escapeHtml(lab.amount) + '<br>';
      var pstate = await printerState(CONFIG.printNode.labelPrinterId);
      await sendToPrintNode(lab.labelBase64, CONFIG.printNode.labelPrinterId, 'SWITCH ' + order.name);
      steps += '&#10004; Sent to the label printer' + (pstate === 'online' ? '' : ' (printer is ' + escapeHtml(pstate) + ' &mdash; prints when it reconnects)') + '<br>';
      try {
        await updateTrackingOnFulfillment(order, lab);
        steps += '&#10004; Customer emailed the new tracking: ' + escapeHtml(lab.tracking);
      } catch (te) {
        steps += '&#9888; Could not update Shopify tracking automatically (' + escapeHtml(te.message) + ') &mdash; new tracking is ' + escapeHtml(lab.tracking) + ', update the order by hand.';
      }
      // Stamp a note on the order so nobody is confused by the original checkout shipping line.
      try {
        var when = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
        var noteLine = 'SHIPPING SWITCHED ' + when + ': now ' + lab.carrier + ' ' + lab.service + ' — tracking ' + lab.tracking +
          (trk ? ' (old label ' + trk + ' voided in Shippo)' : '') + '. Checkout line still shows the original service; that is just what the customer paid.';
        await fetch('https://' + CONFIG.shopify.store + '/admin/api/2025-01/orders/' + order.id + '.json', {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { id: order.id, note: (order.note ? order.note + '\n\n' : '') + noteLine } })
        });
        steps += '<br>&#10004; Note stamped on the order';
      } catch (ne) { /* note is nice-to-have; don't fail the switch over it */ }
      // --- What the customer owes (big, red, unmissable) ---
      var paidNow = parseFloat((order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].price) || 0);
      var oweNow = upgradeCharge(lab.amount, paidNow);
      var oweHtml;
      if (oweNow > 0) {
        oweHtml = '<div class="owe"><div class="owe-title">&#128222; Call the customer &mdash; they owe</div>' +
          '<div class="amt">$' + oweNow.toFixed(2) + '</div>' +
          '<div class="owe-sub">The Shippo refund was for <b>our</b> label cost &mdash; the customer has NOT been charged or refunded anything.<br>' +
          'They paid $' + paidNow.toFixed(2) + ' for shipping at checkout; the new ' + escapeHtml(lab.service) + ' label is $' + escapeHtml(lab.amount) + ' + 10%.</div>' +
          '<a class="paybtn" href="/switch-shipping/collect?order=' + encodeURIComponent(clean) + '&amount=' + oweNow.toFixed(2) + '&svc=' + encodeURIComponent(lab.service) + '" ' +
          'onclick="return confirm(\'Create a $' + oweNow.toFixed(2) + ' upgrade invoice for ' + escapeHtml(order.name) + ' in Shopify? (Nothing is emailed yet.)\')">Create $' + oweNow.toFixed(2) + ' invoice in Shopify</a></div>';
      } else {
        oweHtml = '<div class="note"><div class="big">No extra charge to the customer</div>They already paid $' + paidNow.toFixed(2) + ' for shipping, which covers the new $' + escapeHtml(lab.amount) + ' label.</div>';
      }
      return res.send(switchShell('<div class="note good"><div class="big">&#10004; ' + escapeHtml(order.name) + ' switched</div><div class="steps">' + steps + '</div></div>' + oweHtml, q));
    }

    // ---- SHOW current label + rate options ----
    var cur = (order.shipping_lines && order.shipping_lines[0]) || {};
    var inner = '<div class="card"><h2>' + escapeHtml(order.name) + ' &mdash; current shipping</h2>';
    inner += '<div class="rate-row"><span><span class="svc">' + escapeHtml(cur.title || 'Unknown') + '</span><br><span class="eta">Customer paid $' + escapeHtml(cur.price || '0') + (trk ? ' &middot; label ' + escapeHtml(trk) : ' &middot; no label bought yet') + '</span></span></div></div>';

    var paid = parseFloat((order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].price) || 0);
    var rates = await quoteRatesForOrder(order);
    rates.sort(function (a, b) { return parseFloat(a.amount) - parseFloat(b.amount); });
    inner += '<div class="card"><h2>Switch to</h2>';
    rates.forEach(function (r) {
      var eta = r.estimatedDays ? (r.estimatedDays + ' day' + (r.estimatedDays > 1 ? 's' : '')) : '';
      var owe = upgradeCharge(r.amount, paid);
      var oweTxt = owe > 0
        ? '<span class="owe-inline">customer owes +$' + owe.toFixed(2) + '</span>'
        : '<span class="eta">no extra charge</span>';
      inner += '<div class="rate-row"><span><span class="svc">' + escapeHtml(r.carrier + ' ' + r.service) + '</span><br><span class="eta">$' + escapeHtml(r.amount) + (eta ? ' &middot; ' + eta : '') + ' &middot; </span>' + oweTxt + '</span>';
      inner += '<a href="/switch-shipping?order=' + encodeURIComponent(clean) + '&token=' + encodeURIComponent(r.token) + '&from=' + encodeURIComponent(trk || 'none') + '&confirm=1" onclick="return confirm(\'Switch ' + escapeHtml(order.name) + ' to ' + escapeHtml(r.carrier + ' ' + r.service) + '? Customer owes ' + (owe > 0 ? '$' + owe.toFixed(2) + ' extra' : 'nothing extra') + '.' + (trk ? ' Our old label will be refunded by Shippo.' : '') + '\')">Switch</a></div>';
    });
    inner += '</div>';
    res.send(switchShell(inner, q));
  } catch (e) {
    res.send(switchShell('<div class="note"><div class="big">Couldn&#39;t switch</div>' + escapeHtml(e.message) + '</div>', q));
  }
});

// Create a Shopify draft order for the upgrade difference and email the customer the pay link.
// Guarded so a page refresh can't create or email a second invoice.
var upgradeInvoicesSent = {};
app.get('/switch-shipping/collect', async (req, res) => {
  try {
    var clean = String(req.query.order || '').replace(/[^0-9]/g, '');
    var amount = parseFloat(req.query.amount);
    var svc = String(req.query.svc || 'faster shipping');
    if (!clean || isNaN(amount) || amount <= 0) return res.send(switchShell('<div class="note">Bad invoice link &mdash; look the order up again.</div>', clean));
    var key = clean + ':' + amount.toFixed(2);
    if (upgradeInvoicesSent[key]) {
      return res.send(switchShell('<div class="note"><div class="big">Already invoiced</div>A $' + amount.toFixed(2) + ' pay link for #' + escapeHtml(clean) + ' was already emailed.<div class="muted"><a href="' + upgradeInvoicesSent[key] + '" target="_blank" rel="noopener">Open the draft in Shopify</a></div></div>', clean));
    }
    var orders = await searchShopifyOrders('#' + clean);
    var order = (orders || []).filter(function (o) { return String(o.order_number) === clean; })[0];
    if (!order) return res.send(switchShell('<div class="note"><div class="big">Order not found</div>Nothing matches #' + escapeHtml(clean) + '.</div>', clean));

    var draft = {
      line_items: [{
        title: 'Shipping upgrade to ' + svc + ' — order ' + order.name,
        price: amount.toFixed(2),
        quantity: 1,
        requires_shipping: false
      }],
      note: 'Shipping speed upgrade for order ' + order.name + ' (difference + 10%). Created from the Change Shipping Speed dashboard.',
      tags: 'st_dashboard, shipping-upgrade'
    };
    if (order.email) draft.email = order.email;
    var r = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/draft_orders.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_order: draft })
    });
    var j = await r.json();
    if (!r.ok || j.errors) throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : (j.errors || 'Shopify error ' + r.status));
    var d = j.draft_order;
    var adminUrl = 'https://admin.shopify.com/store/' + CONFIG.shopify.store.replace('.myshopify.com', '') + '/draft_orders/' + d.id;
    upgradeInvoicesSent[key] = adminUrl;

    var inner = '<div class="note good"><div class="big">&#10004; Invoice ' + escapeHtml(d.name) + ' created &mdash; $' + amount.toFixed(2) + '</div>' +
      'Now collect it one of two ways:' +
      '<div class="muted" style="margin:16px 0 6px"><b>Over the phone:</b> open it in Shopify and use <i>Collect payment &rarr; Enter credit card</i>.</div>' +
      '<a class="paybtn" style="background:#2A2A2A" href="' + adminUrl + '" target="_blank" rel="noopener">Open in Shopify (phone payment)</a>' +
      '<div class="muted" style="margin:18px 0 6px"><b>Or by email:</b> send them Shopify&#39;s pay link &mdash; when they pay, it completes automatically.</div>' +
      (order.email
        ? '<a class="paybtn" href="/switch-shipping/email-invoice?draft=' + d.id + '&order=' + encodeURIComponent(clean) + '" onclick="return confirm(\'Email the $' + amount.toFixed(2) + ' pay link to ' + escapeHtml(order.email) + '?\')">Email pay link to ' + escapeHtml(order.email) + '</a>'
        : '<div class="muted">No email on this order &mdash; phone payment only.</div>') +
      '</div>';
    res.send(switchShell(inner, clean));
  } catch (e) {
    res.send(switchShell('<div class="note"><div class="big">Couldn&#39;t create the invoice</div>' + escapeHtml(e.message) + '</div>', String(req.query.order || '')));
  }
});

// Email the pay link for a draft created above. Separate click so phone-payment drafts never email.
var invoiceEmailsSent = {};
app.get('/switch-shipping/email-invoice', async (req, res) => {
  try {
    var did = String(req.query.draft || '').replace(/\D/g, '');
    var clean = String(req.query.order || '').replace(/[^0-9]/g, '');
    if (!did) return res.send(switchShell('<div class="note">Bad email link.</div>', clean));
    if (invoiceEmailsSent[did]) return res.send(switchShell('<div class="note"><div class="big">Already emailed</div>The pay link for this invoice was already sent to ' + escapeHtml(invoiceEmailsSent[did]) + '.</div>', clean));
    var si = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/draft_orders/' + did + '/send_invoice.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_order_invoice: {} })
    });
    var sj = await si.json();
    if (!si.ok || sj.errors) throw new Error(JSON.stringify(sj.errors || sj));
    var to = (sj.draft_order_invoice && sj.draft_order_invoice.to) || 'the customer';
    invoiceEmailsSent[did] = to;
    res.send(switchShell('<div class="note good"><div class="big">&#10004; Pay link emailed</div>Sent to ' + escapeHtml(to) + '. When they pay, the invoice completes in Shopify automatically.</div>', clean));
  } catch (e) {
    res.send(switchShell('<div class="note"><div class="big">Email failed</div>' + escapeHtml(e.message) + '<div class="muted">Open the draft in Shopify and send the invoice from there.</div></div>', String(req.query.order || '')));
  }
});

// ============ CREATE A DISCOUNT CODE (Shopify price rule + code, employee-friendly) ============
function discountShell(inner, vals) {
  vals = vals || {};
  var html = '<!DOCTYPE html><html><head><title>Create a Discount Code — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:96px 24px 44px}';
  html += '.wrap{max-width:640px;margin:0 auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:29px;letter-spacing:-.5px;text-align:center}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 0}';
  html += '.card{background:#fff;border:1px solid #EFEBED;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.05);padding:24px;margin:28px 0 18px}';
  html += '.field{margin-bottom:16px}.field label{display:block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#9B8A92;margin-bottom:6px}';
  html += '.field input,.field select{width:100%;padding:14px 16px;border:1.5px solid #E8E2E5;border-radius:12px;font-size:17px;background:#fff}.field input:focus,.field select:focus{outline:none;border-color:#F7B5CD}';
  html += '.row2{display:flex;gap:12px}.row2 .field{flex:1}';
  html += '.gobtn{width:100%;padding:16px;border:none;border-radius:14px;background:#2A2A2A;color:#fff;font-size:16.5px;font-weight:800;cursor:pointer}';
  html += '.note{background:#fff;border:1px solid #EFEBED;border-radius:20px;padding:24px;text-align:center;font-size:16px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.05);margin-bottom:18px}';
  html += '.note.good{border-top:5px solid #F7B5CD}';
  html += '.note .big{font-size:21px;font-weight:800;margin-bottom:8px}';
  html += '.note .code{font-size:34px;font-weight:800;letter-spacing:2px;background:#FAF7F8;border:1.5px dashed #E8C7D3;border-radius:12px;padding:14px;margin:12px 0}';
  html += '.note .muted{color:#9B8A92;font-size:14.5px;font-weight:600;margin-top:10px;line-height:1.5}';
  html += '.hint{color:#9B8A92;font-size:14.5px;text-align:center;line-height:1.6}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>Create a Discount Code</h1>';
  html += inner;
  html += '<div class="card"><form action="/create-discount" method="get" onsubmit="return checkDisc(this)">';
  html += '<div class="field"><label>Code (leave blank to auto-generate)</label><input type="text" name="code" placeholder="e.g. SORRY20" value="' + escapeHtml(vals.code || '') + '" style="text-transform:uppercase"></div>';
  html += '<div class="field"><label>Reason for this discount (required)</label><input type="text" name="reason" placeholder="e.g. melted bar on order 36150, offered 20% on next order" required></div>';
  html += '<div class="row2">';
  html += '<div class="field"><label>Type</label><select name="type"><option value="percentage">% off</option><option value="fixed_amount">$ off</option></select></div>';
  html += '<div class="field"><label>Amount</label><input type="number" name="value" step="0.01" min="0.01" placeholder="e.g. 20" required></div>';
  html += '</div>';
  html += '<div class="row2">';
  html += '<div class="field"><label>Minimum order $ (optional)</label><input type="number" name="min" step="0.01" min="0" placeholder="none"></div>';
  html += '<div class="field"><label>Expires (optional)</label><input type="date" name="ends"></div>';
  html += '</div>';
  html += '<input type="hidden" name="create" value="1">';
  html += '<button class="gobtn" type="submit">Create Discount Code</button>';
  html += '</form></div>';
  html += '<div class="hint">Creates a real code in Shopify (all products, all customers, unlimited uses unless it expires).<br>Manage or delete codes anytime in Shopify &rarr; Discounts.</div>';
  html += '<script>function checkDisc(f){var v=parseFloat(f.value.value);if(!(v>0)){alert("Enter the discount amount.");return false}';
  html += 'if(!f.reason.value.trim()||f.reason.value.trim().length<5){alert("Please give a real reason for the discount \\u2014 a few words about why.");return false}';
  html += 'if(f.type.value==="percentage"&&v>100){alert("Percent can\\u2019t be over 100.");return false}';
  html += 'var c=(f.code.value||"auto-generated").toUpperCase();return confirm("Create code "+c+" for "+(f.type.value==="percentage"?v+"% off":"$"+v.toFixed(2)+" off")+"?")}</script>';
  html += '</div></body></html>';
  return html;
}

var discountCodesMade = {};
app.get('/create-discount', async (req, res) => {
  if (req.query.create !== '1') return res.send(discountShell(''));
  try {
    var type = req.query.type === 'fixed_amount' ? 'fixed_amount' : 'percentage';
    var value = parseFloat(req.query.value);
    if (!(value > 0) || (type === 'percentage' && value > 100)) return res.send(discountShell('<div class="note">Enter a valid amount.</div>'));
    var reason = String(req.query.reason || '').trim();
    if (reason.length < 5) return res.send(discountShell('<div class="note"><div class="big">Reason required</div>Say why this discount is being given &mdash; a few words is fine. Nothing was created.</div>'));
    var code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!code) code = 'SWEET-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    if (discountCodesMade[code]) {
      return res.send(discountShell('<div class="note"><div class="big">Already created</div>' + escapeHtml(code) + ' was just created &mdash; it&#39;s live. Make a different code if you need another.</div>'));
    }
    var rule = {
      title: code + ' — ' + reason.slice(0, 120),
      target_type: 'line_item', target_selection: 'all', allocation_method: 'across',
      customer_selection: 'all',
      value_type: type,
      value: '-' + value.toFixed(2),
      starts_at: new Date().toISOString()
    };
    var min = parseFloat(req.query.min);
    if (min > 0) rule.prerequisite_subtotal_range = { greater_than_or_equal_to: min.toFixed(2) };
    if (req.query.ends) rule.ends_at = req.query.ends + 'T23:59:59-04:00';
    var r = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/price_rules.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ price_rule: rule })
    });
    var j = await r.json();
    if (!r.ok || j.errors) throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : (j.errors || 'Shopify error ' + r.status));
    var pr = j.price_rule;
    var cr = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/price_rules/' + pr.id + '/discount_codes.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discount_code: { code: code } })
    });
    var cj = await cr.json();
    if (!cr.ok || cj.errors) throw new Error('Rule created but the code failed: ' + JSON.stringify(cj.errors || cj));
    discountCodesMade[code] = true;

    var what = type === 'percentage' ? value + '% off' : '$' + value.toFixed(2) + ' off';
    res.send(discountShell('<div class="note good"><div class="big">&#10004; Code is live</div>' +
      '<div class="code">' + escapeHtml(code) + '</div>' + escapeHtml(what) +
      (min > 0 ? ' &middot; orders $' + min.toFixed(2) + '+' : '') +
      (req.query.ends ? ' &middot; expires ' + escapeHtml(req.query.ends) : ' &middot; never expires') +
      '<div class="muted">Give this code to the customer &mdash; it works at checkout right now.<br><a href="https://admin.shopify.com/store/' + CONFIG.shopify.store.replace('.myshopify.com', '') + '/discounts" target="_blank" rel="noopener">Manage in Shopify &rarr; Discounts</a></div></div>'));
  } catch (e) {
    res.send(discountShell('<div class="note"><div class="big">Couldn&#39;t create it</div>' + escapeHtml(e.message) + '</div>'));
  }
});

// ============ STICKERS & LABELS (one place for every sticker file + how to print or order) ============
var STICKERS = [
  { file: 'gluten-free-treats.png', name: 'Gluten-Free Treats', how: 'niimbot' },
  { file: 'pecan-pralines.png', name: 'Pecan Pralines', how: 'niimbot' },
  { file: 'frozen-hot-chocolate.png', name: 'Frozen Hot Chocolate', how: 'niimbot' },
  { file: 'dubai-zero-series.png', name: 'Dubai Chocolate Zero Series', how: 'order' },
  { file: 'dairy-rectangle.png', name: 'DAIRY (gold rectangle)', how: 'order' },
  { file: 'parve-oval.png', name: 'PARVE (oval)', how: 'order' },
  { file: 'parve-rectangle.png', name: 'PARVE (gold rectangle)', how: 'order' }
];
var STICKERS_MISSING = ['Mucho Gusto Munch', 'Chocolate Chunks', 'Gift message cards', 'Hang tags'];

app.get('/stickers', function (req, res) {
  var html = '<!DOCTYPE html><html><head><title>Stickers &amp; Labels — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#2A2A2A;min-height:100vh;padding:72px 24px 36px}';
  html += '.wrap{max-width:960px;margin:0 auto}' + TOPBAR_CSS;
  html += 'h1{font-size:26px;letter-spacing:-.5px;text-align:center;margin-bottom:8px}';
  html += '.sub{text-align:center;color:#9B8A92;font-size:14.5px;font-weight:600;margin-bottom:26px}';
  html += '.sec{font-size:13.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:#9B8A92;margin:26px 0 12px;padding-bottom:7px;border-bottom:2px solid #F3EDF0}';
  html += '.howto{background:#fff;border:1px solid #EFEBED;border-left:5px solid #F7B5CD;border-radius:14px;padding:16px 20px;font-size:14.5px;font-weight:600;line-height:1.7;margin-bottom:16px}';
  html += '.sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}';
  html += '.scard{background:#fff;border:1px solid #EFEBED;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,.05);padding:14px;text-align:center}';
  html += '.scard img{width:100%;height:150px;object-fit:contain;background:#FAF7F8;border-radius:10px}';
  html += '.scard .nm{font-weight:800;font-size:14.5px;margin:10px 0 8px;line-height:1.3}';
  html += '.scard a{display:inline-block;padding:9px 16px;background:#2A2A2A;color:#fff;border-radius:10px;text-decoration:none;font-weight:800;font-size:13px}';
  html += '.miss{background:#fff;border:1px dashed #D9CFD4;border-radius:14px;padding:16px 20px;font-size:14.5px;font-weight:600;color:#9B8A92;line-height:1.7}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>&#128278; Stickers &amp; Labels</h1>';
  html += '<div class="sub">Every sticker file in one place &mdash; no more digging through Canva, email, and Google Drive.</div>';

  html += '<div class="sec">&#128424;&#65039; Print in store &mdash; label printers</div>';
  html += '<div class="howto"><b>&#127852; Pink 2&quot; round stickers (the ones below) &mdash; MUNBYN printer:</b> 1&#65039;&#8419; Load the <b>2-inch pink circle</b> roll into the Munbyn printer. &nbsp;2&#65039;&#8419; Open the free <b>Munbyn Print app</b> on the phone (it connects by Bluetooth). &nbsp;3&#65039;&#8419; Download the sticker below to the phone, import it in the app, and print. The printer is inkless &mdash; it prints black on the pink sticker.<br><br>' +
    '<b>&#9898; White stickers (all other store labels) &mdash; NIIMBOT printer:</b> same idea, but use the free <b>NIIMBOT app</b> with the white sticker rolls.</div>';
  html += '<div class="sgrid">';
  STICKERS.filter(function (s) { return s.how === 'niimbot'; }).forEach(function (s) {
    html += '<div class="scard"><img src="/sticker-files/' + s.file + '" alt=""><div class="nm">' + s.name + '</div><a href="/sticker-files/' + s.file + '" download>&#11015;&#65039; Download</a></div>';
  });
  html += '</div>';

  html += '<div class="sec">&#127981; Ordered from our printing companies</div>';

  html += '<div class="howto"><b>&#129472; SheetLabels.com &mdash; DAIRY &amp; PARVE gold stickers</b><br>' +
    '<a href="https://www.sheetlabels.com/customer/orders/" target="_blank" rel="noopener"><b>See past orders &amp; reorder here</b></a> &mdash; log in as <b>orders@thesweettooth.com</b> (password: <b>Muchogusto</b>).<br>' +
    '<b>Reference order SL343776-4:</b> Custom Sticker Rolls, 2&quot; &times; 1&quot; custom shape, Silver BOPP Permanent (SBP), gloss laminate, white ink: yes.<br>' +
    'Help: <a href="mailto:support@sheetlabels.com">support@sheetlabels.com</a> &middot; phone 888-391-7165 &middot; fax 518-798-0289.</div>';
  html += '<div class="sgrid">';
  ['dairy-rectangle.png', 'parve-oval.png', 'parve-rectangle.png'].forEach(function (f) {
    var s = STICKERS.filter(function (x) { return x.file === f; })[0];
    html += '<div class="scard"><img src="/sticker-files/' + s.file + '" alt=""><div class="nm">' + s.name + '</div><a href="/sticker-files/' + s.file + '" download>&#11015;&#65039; Download</a></div>';
  });
  html += '</div>';

  html += '<div class="howto" style="margin-top:16px"><b>&#127991;&#65039; UPrinting &mdash; circle product stickers (generic Sweet Tooth logo round + Dubai Chocolate)</b><br>' +
    'Log in as <b>mike@thesweettooth.com</b> (password: <b>Muchogusto</b>).<br>' +
    '<a href="https://orders.uprinting.com/order?filter_type=search&amp;keyword=21999028&amp;ch1=_w_up_sc_spk_ty_trans_te_pirn_co_sptl-acct-bttn-0" target="_blank" rel="noopener"><b>&#128257; Reorder the generic round logo stickers here</b></a> (order #21999028 &mdash; the basic round sticker that goes on every product).<br>' +
    'Other circle stickers (Dubai Chocolate etc.): reorder from <a href="https://orders.uprinting.com/order" target="_blank" rel="noopener">order history</a>. Specs are 2&quot;&times;2&quot; roll labels. Support: 888-888-4211.</div>';
  html += '<div class="sgrid">';
  STICKERS.filter(function (s) { return s.how === 'order' && ['dairy-rectangle.png', 'parve-oval.png', 'parve-rectangle.png'].indexOf(s.file) === -1; }).forEach(function (s) {
    html += '<div class="scard"><img src="/sticker-files/' + s.file + '" alt=""><div class="nm">' + s.name + '</div><a href="/sticker-files/' + s.file + '" download>&#11015;&#65039; Download</a></div>';
  });
  html += '</div>';

  html += '<div class="howto" style="margin-top:16px"><b>&#127872; Elegant Packages &mdash; hang tags, gift message cards, coupon cards</b><br>' +
    'James Anderson (Sales) &middot; <a href="tel:+16815252420">+1 681 525 2420</a> &middot; <a href="mailto:info@elegantpackages.com">info@elegantpackages.com</a> &middot; <a href="https://www.elegantpackages.com" target="_blank" rel="noopener">elegantpackages.com</a><br>' +
    'They custom-print almost anything (also quoted candy cups and chocolate boxes). Production is in Pakistan (address says Glendale, AZ) but turnaround is fast.<br><br>' +
    '<b>&#127991;&#65039; ORDER HANG TAGS:</b> reference quote <b>EPCOM-103051</b> &mdash; round swing tags 2.5&quot;&times;2.5&quot;, SBS white coated card 300gsm/14pt, full color both sides, no lamination. Last order: 2,000 DAIRY + 1,000 PARVE, $0.26 each ($693.90 after 10% discount, Dec 2025, gold Pantone D3AF37).<br><br>' +
    '<b>&#128140; ORDER GIFT CARDS:</b> same company &mdash; email James the gift message card file. Size: <b>4.3&quot; &times; 8.3&quot;</b>. Also does the coupon cards (3&quot;&times;2&quot;, rounded corners, hole punched).<br><br>' +
    '<span style="color:#9B8A92">Also fine: hangtagsco.com (previous vendor for these &mdash; had mistakes like wrong QR codes and card sizes, but they always made good in the end). All these Pakistan-based printers end up with the best prices. One exception: their <b>boxes are overpriced</b> &mdash; price boxes elsewhere. Double-check every proof (QR codes, sizes, colors) before approving.</span></div>';
  html += '<div class="sgrid" style="margin-top:16px">';
  html += '<div class="scard"><img src="/sticker-files/elegant-packages-products.png" alt=""><div class="nm">What their products look like<br><span style="font-weight:600;color:#9B8A92;font-size:12.5px">gift card &middot; coupon card &middot; parve + dairy hang tags</span></div><a href="/sticker-files/elegant-packages-products.png" target="_blank" rel="noopener">&#128065;&#65039; View full size</a></div>';
  html += '</div>';

  html += '<div class="sec">&#128196; Printable guides</div>';
  html += '<div class="sgrid">';
  html += '<div class="scard"><img src="/sticker-files/basket-making-guide-preview.png" alt=""><div class="nm">Basket Making Guide</div>' +
    '<a href="/sticker-files/basket-making-guide.pdf" target="_blank" rel="noopener">&#128065;&#65039; Open</a> ' +
    '<a href="/sticker-files/basket-making-guide.pdf" download>&#11015;&#65039; Download</a></div>';
  html += '</div>';

  html += '<div class="sec">&#128722; Bought on Amazon &mdash; Mucho Gusto Munch supplies</div>';
  html += '<div class="howto"><b>&#127775; Blank sticker labels:</b> 3&quot; round printable glossy white waterproof vinyl sticker labels &mdash; any brand is fine. ' +
    '<a href="https://www.amazon.com/dp/B0D6VPH6LY" target="_blank" rel="noopener">Last one we bought</a>. We print the Mucho Gusto Munch design onto these ourselves.<br><br>' +
    '<b>&#127853; Pink bags:</b> resealable stand-up foil pouches with a matte window, <b>pink, 5.5&quot; &times; 7.8&quot;</b> &mdash; any brand is fine. ' +
    'Last order for reference: <i>FireKylin 100 Pack Resealable Bags with Matte Window (Pink, 5.5&quot; x 7.8&quot;), smell proof, stand up</i> &mdash; search that on Amazon.</div>';

  html += '<div class="sec">&#128203; Not here yet</div>';
  html += '<div class="miss">Files we still need to add: <b>' + STICKERS_MISSING.join('</b> &middot; <b>') + '</b>.<br>Drop the file in the STICKERS folder on Mikey&#39;s desktop and ask Claude to add it to this page.</div>';

  html += '</div></body></html>';
  res.send(html);
});

app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
