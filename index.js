require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { extractOrderData, generateInvoiceHTML } = require('./order-utils');
const { generateGiftCardHTML } = require('./gift-card-template');
const { buyLabelForOrder } = require('./shipping-label');

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
  await sendToPrintNode(label.labelBase64, CONFIG.printNode.labelPrinterId, 'Label ' + orderName);
  console.log('✓ Label printed for', orderName, '-', label.carrier, label.service, '$' + label.amount, 'track', label.tracking);
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
    ordersSeenInMemory: recentOrders.length,
    recentOrderNames: recentOrders.slice(0, 8).map(function (o) { return o.order.name; }),
    labelsAttempted: Object.keys(labeledOrderIds).length
  });
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

    res.send('<!DOCTYPE html><html><head><title>Gift Card Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.header h1{font-size:24px}.nav-links a{margin-left:12px;padding:8px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600}.nav-links a.secondary{background:#fff;color:#000;border:2px solid #000}.search-bar{margin-bottom:20px}.search-bar form{display:flex;gap:8px}.search-bar input{flex:1;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px}.search-bar input:focus{outline:none;border-color:#000}.order-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.order-card{background:#fff;border:2px solid #eee;border-radius:12px;padding:16px;transition:border-color 0.2s}.order-card:hover{border-color:#000}.order-num{font-size:18px;font-weight:800;margin-bottom:8px}.order-detail{font-size:13px;margin-bottom:4px;color:#333}.order-msg{font-size:12px;font-style:italic;margin:8px 0;padding:8px;background:#f9f9f9;border-radius:6px;color:#555}.order-actions{margin-top:12px}.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}.btn-print{background:#000;color:#fff}.tab-nav{display:flex;gap:0;margin-bottom:20px;align-items:center}.tab{padding:10px 24px;text-decoration:none;font-size:15px;font-weight:700;border-radius:0}.tab:first-child{border-radius:8px 0 0 8px}.tab:last-child{border-radius:0 8px 8px 0}.tab-active{background:#22c55e;color:#fff;border:2px solid #22c55e}.tab-inactive{background:#fff;color:#999;border:2px solid #ddd}.btn-new{margin-left:auto;padding:10px 20px;background:#f59e0b;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700}</style></head><body><div class="tab-nav"><a href="/dashboard/invoices" class="tab tab-inactive">📋 Invoices</a><a href="/dashboard" class="tab tab-active">🎁 Gift Cards</a><a href="/dashboard/gift-card-new" class="btn-new">✨ Create New Card</a></div><div class="search-bar"><form action="/dashboard/search" method="get"><input type="text" name="q" id="search" placeholder="Search orders..." oninput="filterOrders()"></form></div><div class="order-grid" id="orderGrid">' + orderCards + '</div><script>function filterOrders(){var q=document.getElementById("search").value.toLowerCase();if(!q){document.querySelectorAll(".order-card").forEach(function(c){c.style.display=""});return}var cards=document.querySelectorAll(".order-card");cards.forEach(function(c){c.style.display=c.textContent.toLowerCase().indexOf(q)>-1?"":"none"})}</script></body></html>');
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
    html += '<div style="position:absolute;top:4.7%;left:7%;font-family:Arial,sans-serif;font-size:6pt;color:#bbb">'+orderData.orderNumber+'</div>';
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
  html += '<div id="prevOrderCode" style="position:absolute;top:4.7%;left:7%;font-family:Arial,sans-serif;font-size:6pt;color:#bbb"></div>';
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

// ============ HOME ============

app.get('/', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Sweet Tooth Order Printer</title><style>body{font-family:sans-serif;max-width:600px;margin:50px auto;padding:20px}h1{margin-bottom:10px}.subtitle{color:#666;margin-bottom:30px}.btn{display:inline-block;padding:12px 24px;background:#000;color:white;text-decoration:none;border-radius:6px;font-weight:600;margin-right:10px}</style></head><body><h1>Sweet Tooth Order Printer</h1><p class="subtitle">Automatic invoice and gift card printing</p><a href="/dashboard" class="btn">Gift Cards</a><a href="/dashboard/invoices" class="btn">Invoices</a></body></html>');
});

app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
