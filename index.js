require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { extractOrderData, generateInvoiceHTML } = require('./order-utils');
const { generateGiftCardHTML } = require('./gift-card-template');
const { buyLabelForOrder, reprintLabelByTracking } = require('./shipping-label');

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

    res.send('<!DOCTYPE html><html><head><title>Edit Invoice ' + orderData.orderNumber + '</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;display:flex;height:100vh}@media print{.no-print{display:none!important}body{display:block;background:white}.editor-panel{display:none}.preview-wrap{padding:0}}' +
      '.editor-panel{width:360px;min-width:360px;background:#fff;border-right:2px solid #eee;padding:20px;overflow-y:auto;flex-shrink:0}' +
      '.preview-wrap{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;align-items:center}' +
      '.editor-panel h2{font-size:18px;font-weight:800;margin-bottom:4px}.order-sub{font-size:12px;color:#888;margin-bottom:16px}' +
      '.field{margin-bottom:12px}.field label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;color:#555}' +
      '.field input,.field textarea{width:100%;padding:9px 10px;border:2px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit}.field textarea{height:80px;resize:vertical}' +
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
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
};

// Sticky top bar shown on every dashboard page — wordmark always goes home.
var TOPBAR_HTML = '<header class="topbar"><a href="/">The Sweet Tooth</a></header>';
var TOPBAR_CSS = '.topbar{position:fixed;top:0;left:0;right:0;height:52px;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.07);display:flex;align-items:center;padding:0 22px;z-index:100}' +
  '.topbar a{font-size:16.5px;font-weight:800;letter-spacing:-.3px;color:#2A2A2A;text-decoration:none;border-bottom:2.5px solid #F7B5CD;padding-bottom:1px}';

function dashTile(label, href, opts) {
  opts = opts || {};
  var html = '<a class="tile" href="' + (href || '#') + '"';
  if (opts.newTab) html += ' target="_blank" rel="noopener"';
  html += '>';
  if (opts.icon && DASH_ICONS[opts.icon]) {
    html += '<span class="icon-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + DASH_ICONS[opts.icon] + '</svg></span>';
  }
  html += '<span class="label">' + label + '</span></a>';
  return html;
}

function dashPage(title, subtitle, tilesHtml, backHref) {
  var html = '<!DOCTYPE html><html><head><title>' + title + ' — The Sweet Tooth</title>';
  html += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#FAF7F8;color:#3D3D3D;min-height:100vh;display:flex;padding:100px 28px 48px}';
  html += '.wrap{width:100%;max-width:1080px;margin:auto}';
  html += TOPBAR_CSS;
  html += 'h1{font-size:31px;letter-spacing:-.5px;text-align:center;color:#3D3D3D}';
  html += 'h1:after{content:"";display:block;width:56px;height:5px;border-radius:5px;background:#F7B5CD;margin:14px auto 0}';
  html += '.subtitle{color:#9B8A92;font-size:15px;text-align:center;margin-top:10px}';
  html += '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:24px;margin-top:44px;justify-content:center}';
  html += '.tile{position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:180px;background:#fff;border:1px solid #EFEBED;border-radius:20px;padding:28px 24px;text-decoration:none;color:#2A2A2A;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.05);transition:transform .12s,box-shadow .12s}';
  html += '.tile:before{content:"";position:absolute;top:0;left:0;right:0;height:4px;background:#F7B5CD;opacity:0;transition:opacity .12s}';
  html += '.tile:hover{transform:translateY(-4px);box-shadow:0 14px 30px rgba(0,0,0,.12)}';
  html += '.tile:hover:before{opacity:1}';
  html += '.icon-badge{color:#2A2A2A;display:flex;align-items:center;justify-content:center;flex-shrink:0}';
  html += '.icon-badge svg{width:34px;height:34px}';
  html += '.tile .label{font-weight:750;font-size:17.5px;letter-spacing:-.2px;line-height:1.35}';
  html += '@media (max-width:760px){body{padding:88px 18px 36px}.grid{gap:16px;margin-top:32px}.tile{min-height:150px}h1{font-size:26px}}';
  html += '</style></head><body>' + TOPBAR_HTML + '<div class="wrap">';
  html += '<h1>' + title + '</h1>';
  if (subtitle) html += '<p class="subtitle">' + subtitle + '</p>';
  html += '<div class="grid">' + tilesHtml + '</div>';
  html += '</div></body></html>';
  return html;
}

app.get('/', (req, res) => {
  var tiles = '';
  tiles += dashTile('Order Lookup', '/order-lookup', { icon: 'search' });
  tiles += dashTile('Create a Draft Order', '/draft-order', { icon: 'filePlus' });
  tiles += dashTile('Edit or Reprint Invoice', '/dashboard/invoices', { icon: 'printer', newTab: true });
  tiles += dashTile('Edit or Reprint Gift Card Message', '/dashboard', { icon: 'edit', newTab: true });
  tiles += dashTile('Create New Gift Card Message', '/dashboard/gift-card-new', { icon: 'gift', newTab: true });
  tiles += dashTile('Sugar Paper Designer', 'https://sweet-tooth-layout-studio.netlify.app/', { newTab: true, icon: 'penTool' });
  tiles += dashTile('Supplies', '/supplies', { icon: 'box' });
  tiles += dashTile('Check Email', 'https://mail.google.com/mail/u/0/#inbox', { newTab: true, icon: 'mail' });
  res.send(dashPage('The Sweet Tooth — Employee Dashboard', null, tiles));
});

app.get('/supplies', (req, res) => {
  var tiles = '';
  tiles += dashTile('Buy Supplies', '/supplies/buy', { icon: 'cart' });
  tiles += dashTile('Request Supplies', 'https://script.google.com/macros/s/AKfycbxsgmwcpeCHOQE4XahyyMly3OyJ0qD506j0N3jyrZrJyOjuKQuLUrJn8oOXL-wrh4U3/exec', { newTab: true, icon: 'hand' });
  res.send(dashPage('Supplies', null, tiles, '/'));
});

app.get('/supplies/buy', (req, res) => {
  var tiles = '';
  tiles += dashTile('Amazon', 'https://www.amazon.com', { newTab: true });
  tiles += dashTile('Restaurant Depot', 'https://www.restaurantdepot.com', { newTab: true });
  tiles += dashTile('Instacart (Costco)', 'https://www.instacart.com/store/costco/storefront', { newTab: true });
  tiles += dashTile('Sam&#39;s Club', 'https://www.samsclub.com', { newTab: true });
  tiles += dashTile('Linnea&#39;s', 'https://linneasinc.com', { newTab: true });
  tiles += dashTile('Uline', 'https://www.uline.com', { newTab: true });
  tiles += dashTile('Hialeah Products', 'https://www.newurbanfarms.com/', { newTab: true });
  tiles += dashTile('WebstaurantStore', 'https://www.webstaurantstore.com/myaccount/orders', { newTab: true });
  res.send(dashPage('Buy Supplies', null, tiles, '/supplies'));
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

app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
