require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { extractOrderData, generateInvoiceHTML } = require('./order-utils');
const { generateGiftCardHTML } = require('./gift-card-template');

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
    giftCardPrinterId: process.env.PRINTNODE_GIFTCARD_PRINTER_ID
  }
};

// Log config on startup (without sensitive values)
console.log('=== Sweet Tooth Printer Starting ===');
console.log('Invoice Printer ID:', CONFIG.printNode.invoicePrinterId || 'NOT SET');
console.log('Gift Card Printer ID:', CONFIG.printNode.giftCardPrinterId || 'NOT SET');
console.log('Shopify Store:', CONFIG.shopify.store || 'NOT SET');
console.log('=====================================');

// In-memory order store (last 250 orders)
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

async function sendToPrintNode(pdfBase64, printerId, title) {
  console.log('Sending to PrintNode - Printer:', printerId, 'Title:', title);
  var response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ printerId: parseInt(printerId), title: title, contentType: 'pdf_base64', content: pdfBase64, source: 'Sweet Tooth Order Printer' })
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

    // Store in memory
    recentOrders.unshift({ order: order, data: orderData, timestamp: new Date() });
    if (recentOrders.length > MAX_ORDERS) recentOrders.pop();

    // Print Invoice
    if (CONFIG.printNode.invoicePrinterId) {
      console.log('Printing invoice...');
      var invoiceHTML = generateInvoiceHTML(orderData);
      var invoicePdf = await htmlToPdfBase64(invoiceHTML);
      await sendToPrintNode(invoicePdf, CONFIG.printNode.invoicePrinterId, 'Invoice ' + orderName);
      console.log('✓ Invoice sent to printer');
    } else {
      console.log('✗ Invoice printer not configured!');
    }

    // Print Gift Card (skip for POS/in-store orders)
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
    // Only process if not already in memory
    var exists = recentOrders.find(function(o) { return o.order.id === order.id; });
    if (!exists) {
      await printOrder(order);
    } else {
      console.log('Order already processed, skipping');
    }
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

// ============ DASHBOARD - GIFT CARDS ============

app.get('/dashboard', async (req, res) => {
  try {
    // Load recent orders from Shopify if memory is empty
    if (recentOrders.length === 0) {
      var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=50';
      var response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        var data = await response.json();
        var orders = data.orders || [];
        for (var i = 0; i < orders.length; i++) {
          var od = extractOrderData(orders[i]);
          recentOrders.push({ order: orders[i], data: od, timestamp: new Date(orders[i].created_at) });
        }
      }
    }

    var giftOrders = recentOrders.filter(function(o) { return o.data.giftMessage && o.data.giftMessage.trim(); });

    var orderCards = '';
    for (var j = 0; j < giftOrders.length; j++) {
      var o = giftOrders[j];
      var msg = o.data.giftMessage.length > 80 ? o.data.giftMessage.substring(0, 80) + '...' : o.data.giftMessage;
      orderCards += '<div class="order-card"><div class="order-num">' + o.data.orderNumber + '</div><div class="order-detail">To: ' + o.data.giftReceiver + '</div><div class="order-detail">From: ' + o.data.giftSender + '</div><div class="order-msg">"' + msg + '"</div><div class="order-actions"><a href="/dashboard/print-custom/' + o.order.id + '" class="btn btn-print">Edit & Print</a></div></div>';
    }

    if (!orderCards) orderCards = '<p style="text-align:center;color:#999;padding:40px;">No gift card orders found. New orders with gift messages will appear here.</p>';

    res.send('<!DOCTYPE html><html><head><title>Gift Card Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.header h1{font-size:24px}.nav-links a{margin-left:12px;padding:8px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600}.nav-links a.secondary{background:#fff;color:#000;border:2px solid #000}.search-bar{margin-bottom:20px}.search-bar input{width:100%;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px}.search-bar input:focus{outline:none;border-color:#000}.order-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.order-card{background:#fff;border:2px solid #eee;border-radius:12px;padding:16px;transition:border-color 0.2s}.order-card:hover{border-color:#000}.order-num{font-size:18px;font-weight:800;margin-bottom:8px}.order-detail{font-size:13px;margin-bottom:4px;color:#333}.order-msg{font-size:12px;font-style:italic;margin:8px 0;padding:8px;background:#f9f9f9;border-radius:6px;color:#555}.order-actions{margin-top:12px}.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}.btn-print{background:#000;color:#fff}</style></head><body><div class="header"><h1>🎁 Gift Cards</h1><div class="nav-links"><a href="/dashboard/invoices" class="secondary">Invoices</a></div></div><div class="search-bar"><input type="text" id="search" placeholder="Search orders..." oninput="filterOrders()"></div><div class="order-grid" id="orderGrid">' + orderCards + '</div><script>function filterOrders(){var q=document.getElementById("search").value.toLowerCase();var cards=document.querySelectorAll(".order-card");cards.forEach(function(c){c.style.display=c.textContent.toLowerCase().indexOf(q)>-1?"":"none"})}</script></body></html>');
  } catch (error) {
    res.status(500).send('Error loading dashboard: ' + error.message);
  }
});

// ============ DASHBOARD - INVOICES ============

app.get('/dashboard/invoices', async (req, res) => {
  try {
    if (recentOrders.length === 0) {
      var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?status=any&limit=50';
      var response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        var data = await response.json();
        var orders = data.orders || [];
        for (var i = 0; i < orders.length; i++) {
          var od = extractOrderData(orders[i]);
          recentOrders.push({ order: orders[i], data: od, timestamp: new Date(orders[i].created_at) });
        }
      }
    }

    var orderCards = '';
    for (var j = 0; j < recentOrders.length; j++) {
      var o = recentOrders[j];
      var hasGift = o.data.giftMessage && o.data.giftMessage.trim() ? '<span style="display:inline-block;background:#000;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px">🎁 GIFT</span>' : '';
      orderCards += '<div class="order-card"><div class="order-num">' + o.data.orderNumber + hasGift + '</div><div class="order-detail"><strong>' + o.data.deliveryType.toUpperCase() + '</strong> — ' + o.data.recipient.name + '</div><div class="order-detail">' + o.data.deliveryDate + '</div><div class="order-detail">' + o.data.items.length + ' item(s)</div><div class="order-actions"><a href="/dashboard/invoice-view/' + o.order.id + '" class="btn btn-view">View Invoice</a> <a href="/dashboard/reprint-invoice/' + o.order.id + '" class="btn btn-print">Reprint</a></div></div>';
    }

    if (!orderCards) orderCards = '<p style="text-align:center;color:#999;padding:40px;">No orders found. Orders will appear here as they come in.</p>';

    res.send('<!DOCTYPE html><html><head><title>Invoice Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.header h1{font-size:24px}.nav-links a{margin-left:12px;padding:8px 16px;background:#000;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600}.nav-links a.secondary{background:#fff;color:#000;border:2px solid #000}.search-bar{margin-bottom:20px}.search-bar input{width:100%;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px}.search-bar input:focus{outline:none;border-color:#000}.order-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.order-card{background:#fff;border:2px solid #eee;border-radius:12px;padding:16px;transition:border-color 0.2s}.order-card:hover{border-color:#000}.order-num{font-size:18px;font-weight:800;margin-bottom:8px}.order-detail{font-size:13px;margin-bottom:4px;color:#333}.order-actions{margin-top:12px;display:flex;gap:8px}.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}.btn-view{background:#fff;color:#000;border:2px solid #000}.btn-print{background:#000;color:#fff}</style></head><body><div class="header"><h1>📋 Invoices</h1><div class="nav-links"><a href="/dashboard" class="secondary">Gift Cards</a></div></div><div class="search-bar"><input type="text" id="search" placeholder="Search orders..." oninput="filterOrders()"></div><div class="order-grid" id="orderGrid">' + orderCards + '</div><script>function filterOrders(){var q=document.getElementById("search").value.toLowerCase();var cards=document.querySelectorAll(".order-card");cards.forEach(function(c){c.style.display=c.textContent.toLowerCase().indexOf(q)>-1?"":"none"})}</script></body></html>');
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
    res.send('<!DOCTYPE html><html><head><title>Invoice ' + orderData.orderNumber + '</title><style>@media print{.no-print{display:none!important}body{margin:0;padding:0}@page{margin:0}}</style></head><body><div class="no-print" style="position:fixed;top:20px;left:20px;z-index:1000;display:flex;gap:10px"><a href="/dashboard/invoices" style="background:#000;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600">← Back</a><button onclick="window.print()" style="background:#4CAF50;color:#fff;padding:10px 20px;border-radius:6px;font-family:sans-serif;font-size:14px;font-weight:600;border:none;cursor:pointer">🖨 Print</button></div>' + invoiceHTML + '</body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
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

// ============ GIFT CARD EDITOR & PRINT (FIXED: editor values actually work) ============

app.get('/dashboard/print-custom/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);

    // Truncate message to 300 chars
    var giftMsg = (orderData.giftMessage || '').substring(0, 300);
    var msgLen = giftMsg.length;

    res.send('<!DOCTYPE html><html><head><title>Edit Gift Card ' + orderData.orderNumber + '</title><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f5;display:flex;height:100vh}.editor-panel{width:380px;background:#fff;border-right:2px solid #eee;padding:20px;overflow-y:auto}.preview-panel{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}.editor-panel h2{font-size:20px;margin-bottom:16px}.field{margin-bottom:14px}.field label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;color:#333}.field input,.field textarea{width:100%;padding:10px;border:2px solid #ddd;border-radius:6px;font-size:14px;font-family:inherit}.field textarea{height:100px;resize:vertical}.field input[type=range]{padding:0;border:none}.char-count{font-size:11px;text-align:right;margin-top:2px}.char-count.warn{color:red;font-weight:700}.slider-row{display:flex;align-items:center;gap:10px}.slider-row input[type=range]{flex:1}.slider-val{font-size:12px;font-weight:700;min-width:40px;text-align:right}.btn-row{display:flex;gap:10px;margin-top:16px}.btn{padding:12px 20px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;border:none;cursor:pointer;text-align:center;flex:1}.btn-primary{background:#000;color:#fff}.btn-secondary{background:#fff;color:#000;border:2px solid #000}.card-preview{width:299px;height:612px;background:#fff;border:2px solid #000;position:relative;overflow:hidden;font-family:Montserrat,sans-serif}.top-section-preview{position:absolute;left:0;right:0;text-align:center;padding:0 40px}.msg-section-preview{position:absolute;left:0;right:0;text-align:center;padding:0 40px}@media print{.no-print{display:none!important}body{margin:0;padding:0;background:white;display:block}.editor-panel{display:none}.preview-panel{display:block;padding:0}.card-preview{border:none;width:4.15in;height:8.5in;margin:0;padding:0}@page{size:4.15in 8.5in;margin:0}}</style></head><body><div class="editor-panel no-print"><h2>Edit Gift Card</h2><p style="font-size:12px;color:#666;margin-bottom:16px">' + orderData.orderNumber + '</p><div class="field"><label>Recipient Name</label><input type="text" id="recipientName" value="' + (orderData.giftReceiver || orderData.recipient.name).replace(/"/g, '&quot;') + '" oninput="updatePreview()"></div><div class="field"><label>Address Line 1</label><input type="text" id="address1" value="' + (orderData.recipient.address1 || '').replace(/"/g, '&quot;') + '" oninput="updatePreview()"></div><div class="field"><label>Address Line 2</label><input type="text" id="address2" value="' + (orderData.recipient.city ? orderData.recipient.city + ', ' + orderData.recipient.province + ' ' + orderData.recipient.zip : '').replace(/"/g, '&quot;') + '" oninput="updatePreview()"></div><div class="field"><label>Gift Message <span id="charCount" class="char-count">' + msgLen + '/300</span></label><textarea id="giftMessage" maxlength="300" oninput="updatePreview()">' + giftMsg.replace(/</g, '&lt;') + '</textarea></div><div class="field"><label>Sender Name</label><input type="text" id="senderName" value="' + (orderData.giftSender || '').replace(/"/g, '&quot;') + '" oninput="updatePreview()"></div><hr style="margin:16px 0;border:1px solid #eee"><div class="field"><label>Name/Address Position (from top)</label><div class="slider-row"><input type="range" id="topPos" min="0" max="150" value="11" oninput="updatePreview()"><span class="slider-val" id="topPosVal">0.15in</span></div></div><div class="field"><label>Message Position (from top)</label><div class="slider-row"><input type="range" id="msgPos" min="280" max="400" value="310" oninput="updatePreview()"><span class="slider-val" id="msgPosVal">4.30in</span></div></div><div class="btn-row"><button class="btn btn-primary" onclick="printCard()">🖨 Print to Printer</button></div><div class="btn-row"><button class="btn btn-secondary" onclick="window.print()">🖥 Browser Print</button><a href="/dashboard" class="btn btn-secondary" style="display:flex;align-items:center;justify-content:center">← Back</a></div></div><div class="preview-panel"><div class="card-preview" id="cardPreview"><div class="top-section-preview" id="topSection" style="top:0.15in"><div id="prevName" style="font-size:11.9pt;font-weight:400;margin-bottom:12px">' + (orderData.giftReceiver || orderData.recipient.name) + '</div><div id="prevAddr" style="font-size:9.35pt;font-weight:400;line-height:1.4">' + (orderData.recipient.address1 || '') + (orderData.recipient.city ? '<br>' + orderData.recipient.city + ', ' + orderData.recipient.province + ' ' + orderData.recipient.zip : '') + '</div></div><div class="msg-section-preview" id="msgSection" style="top:4.30in"><div id="prevMsg" style="font-size:10.2pt;font-weight:700;line-height:1.5">' + giftMsg.replace(/\n/g, '<br>') + '</div><div id="prevSender" style="margin-top:12px;font-size:10.2pt;font-weight:700">' + (orderData.giftSender || '') + '</div></div></div></div><script>function updatePreview(){var name=document.getElementById("recipientName").value;var a1=document.getElementById("address1").value;var a2=document.getElementById("address2").value;var msg=document.getElementById("giftMessage").value;var sender=document.getElementById("senderName").value;var topPx=parseInt(document.getElementById("topPos").value);var msgPx=parseInt(document.getElementById("msgPos").value);var topIn=(topPx/72).toFixed(2);var msgIn=(msgPx/72).toFixed(2);document.getElementById("topPosVal").textContent=topIn+"in";document.getElementById("msgPosVal").textContent=msgIn+"in";document.getElementById("topSection").style.top=topIn+"in";document.getElementById("msgSection").style.top=msgIn+"in";document.getElementById("prevName").textContent=name;document.getElementById("prevAddr").innerHTML=a1+(a2?"<br>"+a2:"");var len=msg.length;var cc=document.getElementById("charCount");cc.textContent=len+"/300";cc.className=len>280?"char-count warn":"char-count";var fs="10.2pt";var lh="1.5";if(len>250){fs="8pt";lh="1.3"}else if(len>200){fs="8.5pt";lh="1.35"}else if(len>150){fs="9pt";lh="1.4"}else if(len>100){fs="9.5pt";lh="1.45"}document.getElementById("prevMsg").style.fontSize=fs;document.getElementById("prevMsg").style.lineHeight=lh;document.getElementById("prevMsg").innerHTML=msg.replace(/\\n/g,"<br>");document.getElementById("prevSender").textContent=sender;document.getElementById("prevSender").style.fontSize=fs}function printCard(){var fd=new FormData();fd.append("recipientName",document.getElementById("recipientName").value);fd.append("address1",document.getElementById("address1").value);fd.append("address2",document.getElementById("address2").value);fd.append("giftMessage",document.getElementById("giftMessage").value);fd.append("senderName",document.getElementById("senderName").value);fd.append("topPosition",(parseInt(document.getElementById("topPos").value)/72).toFixed(2)+"in");fd.append("messagePosition",(parseInt(document.getElementById("msgPos").value)/72).toFixed(2)+"in");var params=new URLSearchParams(fd);fetch("/dashboard/send-gift-card-print/' + order.id + '",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params.toString()}).then(function(r){return r.json()}).then(function(d){if(d.success){alert("✅ Gift card sent to printer!")}else{alert("❌ Print failed: "+d.error)}}).catch(function(e){alert("Error: "+e.message)})}</script></body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ SEND GIFT CARD TO PRINTNODE (from editor) ============

app.post('/dashboard/send-gift-card-print/:orderId', async (req, res) => {
  try {
    var order = await fetchOrderFromShopify(req.params.orderId);
    var orderData = extractOrderData(order);

    // FIXED: Use editor values instead of defaults
    var customData = {
      giftReceiver: req.body.recipientName || orderData.giftReceiver,
      giftMessage: (req.body.giftMessage || orderData.giftMessage || '').substring(0, 300),
      giftSender: req.body.senderName || orderData.giftSender,
      recipient: {
        name: req.body.recipientName || orderData.recipient.name,
        address1: req.body.address1 || orderData.recipient.address1,
        address2: '',
        city: '',
        province: '',
        zip: ''
      },
      // FIXED: Editor position values are passed through to the template
      topPosition: req.body.topPosition || '0.15in',
      messagePosition: req.body.messagePosition || '4.30in'
    };

    // Parse address2 for city/state/zip
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
      recipient: {
        name: req.body.recipientName || '',
        address1: req.body.address1 || '',
        address2: '',
        city: '',
        province: '',
        zip: ''
      },
      topPosition: req.body.topPosition || '0.15in',
      messagePosition: req.body.messagePosition || '4.30in'
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
    // FIXED: No "Gift Card" header in print output
    res.send('<!DOCTYPE html><html><head><title> </title><style>@media print{.no-print{display:none!important}body{margin:0;padding:0}@page{size:4.15in 8.5in;margin:0}}</style></head><body><div class="no-print" style="position:fixed;top:20px;display:flex;gap:10px;left:50%;transform:translateX(-50%);z-index:1000"><a href="/dashboard" style="background:#000;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600">← Back</a><button onclick="window.print()" style="background:#4CAF50;color:#fff;padding:10px 20px;border-radius:6px;font-family:sans-serif;font-size:14px;font-weight:600;border:none;cursor:pointer">🖨 Print</button></div>' + giftCardHTML + '</body></html>');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// ============ SEARCH ============

app.get('/dashboard/search', async (req, res) => {
  try {
    var q = req.query.q || '';
    if (!q) return res.redirect('/dashboard');

    // Search by order number in Shopify
    var orders = [];
    if (q.match(/^#?\d+$/)) {
      orders = await searchShopifyOrders(q.replace('#', ''));
    }

    // Also search in memory
    var qLower = q.toLowerCase();
    var memResults = recentOrders.filter(function(o) {
      var d = o.data;
      return (d.orderNumber && d.orderNumber.toLowerCase().indexOf(qLower) > -1) ||
        (d.recipient.name && d.recipient.name.toLowerCase().indexOf(qLower) > -1) ||
        (d.giftReceiver && d.giftReceiver.toLowerCase().indexOf(qLower) > -1) ||
        (d.giftSender && d.giftSender.toLowerCase().indexOf(qLower) > -1) ||
        (d.recipient.city && d.recipient.city.toLowerCase().indexOf(qLower) > -1);
    });

    var allResults = memResults.map(function(o) { return o; });
    for (var i = 0; i < orders.length; i++) {
      var exists = allResults.find(function(r) { return r.order.id === orders[i].id; });
      if (!exists) {
        allResults.push({ order: orders[i], data: extractOrderData(orders[i]), timestamp: new Date(orders[i].created_at) });
      }
    }

    var html = '<h2>Search: "' + q + '" (' + allResults.length + ' results)</h2>';
    for (var j = 0; j < allResults.length; j++) {
      var r = allResults[j];
      html += '<div style="background:#fff;border:2px solid #eee;border-radius:8px;padding:12px;margin:8px 0"><strong>' + r.data.orderNumber + '</strong> — ' + r.data.recipient.name + ' — ' + r.data.deliveryType.toUpperCase() + (r.data.giftMessage ? ' <a href="/dashboard/print-custom/' + r.order.id + '">[Edit Gift Card]</a>' : '') + ' <a href="/dashboard/invoice-view/' + r.order.id + '">[View Invoice]</a></div>';
    }

    res.send('<!DOCTYPE html><html><head><title>Search</title><style>body{font-family:sans-serif;max-width:900px;margin:20px auto;padding:20px}a{color:#000}</style></head><body><a href="/dashboard">← Back to Dashboard</a><br><br>' + html + '</body></html>');
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
