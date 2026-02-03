require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer-core');
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

console.log('=== Sweet Tooth Printer Starting ===');
console.log('Invoice Printer ID:', CONFIG.printNode.invoicePrinterId || 'NOT SET');
console.log('Gift Card Printer ID:', CONFIG.printNode.giftCardPrinterId || 'NOT SET');
console.log('Shopify Store:', CONFIG.shopify.store || 'NOT SET');
console.log('=====================================');

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function verifyShopifyWebhook(req) {
  var hmac = req.get('X-Shopify-Hmac-Sha256');
  var hash = crypto.createHmac('sha256', CONFIG.shopify.webhookSecret).update(req.body, 'utf8').digest('base64');
  return hmac === hash;
}

async function htmlToPdfBase64(html, options) {
  options = options || {};
  var browser = await puppeteer.launch({ args: chromium.args, defaultViewport: chromium.defaultViewport, executablePath: await chromium.executablePath(), headless: chromium.headless });
  var page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  var pdfOptions = { printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } };
  if (options.width && options.height) { pdfOptions.width = options.width; pdfOptions.height = options.height; } else { pdfOptions.format = 'Letter'; }
  var pdfBuffer = await page.pdf(pdfOptions);
  await browser.close();
  return pdfBuffer.toString('base64');
}

async function giftCardToPdfBase64(html) { return htmlToPdfBase64(html, { width: '4.2in', height: '8.5in' }); }

async function sendToPrintNode(pdfBase64, printerId, title) {
  console.log('Sending to PrintNode - Printer:', printerId, 'Title:', title);
  var response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ printerId: parseInt(printerId), title: title, contentType: 'pdf_base64', content: pdfBase64, source: 'Sweet Tooth Order Printer' })
  });
  if (!response.ok) { var errorText = await response.text(); console.log('PrintNode ERROR:', response.status, errorText); throw new Error('PrintNode error: ' + response.status); }
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
  console.log(''); console.log('========== PROCESSING ORDER:', orderName, '=========='); console.log('Source:', order.source_name);
  try {
    var orderData = extractOrderData(order);
    console.log('Delivery Type:', orderData.deliveryType);
    console.log('Gift Message:', orderData.giftMessage ? 'YES (' + orderData.giftMessage.substring(0, 50) + '...)' : 'NO');
    var invoiceHTML = generateInvoiceHTML(orderData);
    var invoicePdf = await htmlToPdfBase64(invoiceHTML);
    if (CONFIG.printNode.invoicePrinterId) { await sendToPrintNode(invoicePdf, CONFIG.printNode.invoicePrinterId, 'Invoice ' + orderData.orderNumber); console.log('✓ Invoice sent to printer'); }
    else { console.log('✗ Invoice printer not configured'); }
    var inStore = isInStoreOrder(order);
    console.log('Is In-Store Order:', inStore);
    if (inStore) { console.log('→ Skipping gift card (in-store order)'); }
    else if (!orderData.giftMessage || !orderData.giftMessage.trim()) { console.log('→ No gift card (no gift message)'); }
    else if (!CONFIG.printNode.giftCardPrinterId) { console.log('✗ Gift card printer not configured!'); }
    else { console.log('→ Printing gift card...'); var giftCardHTML = generateGiftCardHTML(orderData); var giftCardPdf = await giftCardToPdfBase64(giftCardHTML); await sendToPrintNode(giftCardPdf, CONFIG.printNode.giftCardPrinterId, 'Gift Card ' + orderData.orderNumber); console.log('✓ Gift card sent to printer'); }
    console.log('========== ORDER COMPLETE:', orderName, '=========='); console.log('');
    return { success: true, orderNumber: orderData.orderNumber };
  } catch (error) { console.log('✗ ERROR processing order:', error.message); return { success: false, error: error.message }; }
}

app.post('/webhook/orders/create', async (req, res) => {
  console.log(''); console.log('>>> WEBHOOK RECEIVED: orders/create');
  if (!verifyShopifyWebhook(req)) { console.log('>>> WEBHOOK REJECTED'); return res.status(401).send('Unauthorized'); }
  res.status(200).send('OK'); console.log('>>> WEBHOOK VERIFIED');
  var order = JSON.parse(req.body); await printOrder(order);
});

app.post('/webhook/orders/paid', async (req, res) => {
  console.log(''); console.log('>>> WEBHOOK RECEIVED: orders/paid');
  if (!verifyShopifyWebhook(req)) { console.log('>>> WEBHOOK REJECTED'); return res.status(401).send('Unauthorized'); }
  res.status(200).send('OK'); console.log('>>> WEBHOOK VERIFIED');
  var order = JSON.parse(req.body); await printOrder(order);
});

app.get('/print/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!response.ok) { return res.status(404).json({ error: 'Order not found' }); }
    res.json(await printOrder((await response.json()).order));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/debug/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!response.ok) { return res.status(404).json({ error: 'Order not found' }); }
    var data = await response.json(); var order = data.order; var orderData = extractOrderData(order);
    res.json({ orderNumber: order.name, source_name: order.source_name, isInStore: isInStoreOrder(order), note_attributes: order.note_attributes,
      extracted: { deliveryType: orderData.deliveryType, giftMessage: orderData.giftMessage, giftSender: orderData.giftSender, giftReceiver: orderData.giftReceiver },
      config: { invoicePrinterConfigured: !!CONFIG.printNode.invoicePrinterId, giftCardPrinterConfigured: !!CONFIG.printNode.giftCardPrinterId } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/health', (req, res) => { res.json({ status: 'ok' }); });

async function fetchOrders(limit) {
  limit = limit || 250; var allOrders = [];
  var url = 'https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?limit=250&status=any';
  while (allOrders.length < limit && url) {
    var response = await fetch(url, { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json(); allOrders = allOrders.concat(data.orders || []);
    var linkHeader = response.headers.get('link');
    if (linkHeader && linkHeader.indexOf('rel="next"') > -1) { var match = linkHeader.match(/<([^>]+)>;\s*rel="next"/); url = match ? match[1] : null; } else { url = null; }
    if (allOrders.length >= limit) break;
  }
  return allOrders.slice(0, limit);
}

function buildSearchString(order) {
  var parts = [];
  parts.push(order.name || ''); parts.push(order.order_number ? order.order_number.toString() : '');
  if (order.customer) { parts.push(order.customer.first_name || '', order.customer.last_name || '', order.customer.email || '', order.customer.phone || ''); }
  if (order.billing_address) { parts.push(order.billing_address.first_name || '', order.billing_address.last_name || '', order.billing_address.name || '', order.billing_address.city || '', order.billing_address.company || '', order.billing_address.phone || ''); }
  if (order.shipping_address) { parts.push(order.shipping_address.first_name || '', order.shipping_address.last_name || '', order.shipping_address.name || '', order.shipping_address.city || '', order.shipping_address.company || '', order.shipping_address.phone || '', order.shipping_address.address1 || ''); }
  if (order.note_attributes) { for (var i = 0; i < order.note_attributes.length; i++) { parts.push(order.note_attributes[i].value || ''); } }
  if (order.line_items) { for (var j = 0; j < order.line_items.length; j++) { var item = order.line_items[j]; parts.push(item.title || '', item.sku || '', item.variant_title || '', item.vendor || ''); } }
  if (order.shipping_lines && order.shipping_lines[0]) { parts.push(order.shipping_lines[0].title || ''); }
  if (order.created_at) { parts.push(new Date(order.created_at).toLocaleDateString()); }
  parts.push(order.total_price || '', order.tags || '', order.note || '');
  return parts.join(' ').toLowerCase();
}

// ============================================================================================
// STYLES
// ============================================================================================

var svgSearch = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';

var dashboardStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F5F5F7;color:#1d1d1f}
  .top-bar{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid rgba(0,0,0,0.08);padding:12px 24px;display:flex;align-items:center}
  .top-left{flex:1}
  .seg-control{display:inline-flex;background:rgba(0,0,0,0.06);border-radius:8px;padding:2px}
  .seg{padding:6px 18px;border-radius:7px;font-size:13px;font-weight:500;text-decoration:none;color:#86868b;transition:all 0.2s}
  .seg.active{background:white;color:#1d1d1f;box-shadow:0 1px 4px rgba(0,0,0,0.08),0 0 1px rgba(0,0,0,0.08)}
  .seg:hover:not(.active){color:#1d1d1f}
  .top-right{flex:1;display:flex;justify-content:flex-end}
  .search-wrap{position:relative}
  .search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);display:flex}
  .search-input{width:240px;padding:7px 12px 7px 32px;border:1px solid rgba(0,0,0,0.1);border-radius:8px;font-size:13px;font-family:inherit;background:rgba(0,0,0,0.03);outline:none;transition:all 0.2s}
  .search-input:focus{border-color:#007AFF;background:white;box-shadow:0 0 0 3px rgba(0,122,255,0.1);width:300px}
  .content{max-width:1200px;margin:0 auto;padding:16px 24px}
  .meta{font-size:12px;color:#86868b;margin-bottom:10px}
  .table-wrap{background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e5e5ea;background:rgba(0,0,0,0.015)}
  tbody td{padding:7px 12px;font-size:13px;border-bottom:1px solid #f2f2f7;vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#fafafa}
  tbody tr.hidden{display:none}
  .col-order{font-weight:600;white-space:nowrap}
  .col-order a{color:#007AFF;text-decoration:none}
  .col-order a:hover{text-decoration:underline}
  .col-date{color:#86868b;white-space:nowrap;font-size:12px}
  .col-city{color:#86868b;font-weight:400;font-size:12px}
  .col-products{color:#6e6e73;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
  .col-type{font-size:12px;color:#86868b}
  .col-total{font-weight:600;white-space:nowrap}
  .col-actions{white-space:nowrap;text-align:right}
  .btn-print{display:inline-block;padding:5px 14px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;transition:all 0.15s;border:none;font-family:inherit;margin-left:6px;background:#1d1d1f;color:#fff}
  .btn-print:hover{background:#000}
  .no-results{text-align:center;padding:40px;color:#86868b;display:none}
  .empty-state{text-align:center;padding:60px 20px;color:#86868b;font-size:14px}
`;

var editStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Inter,-apple-system,sans-serif;background:#F5F5F7}
  .edit-header{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid rgba(0,0,0,0.08);padding:10px 24px;display:flex;align-items:center;justify-content:space-between}
  .back-link{color:#007AFF;text-decoration:none;font-size:14px;font-weight:500}
  .back-link:hover{text-decoration:underline}
  .edit-title{font-size:15px;font-weight:600;color:#1d1d1f}
  .btn-black{background:#1d1d1f;color:white;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:600;border:none;cursor:pointer;transition:background 0.2s}
  .btn-black:hover{background:#000}
  .edit-content{max-width:800px;margin:16px auto;padding:0 24px}
  .edit-note{font-size:12px;color:#86868b;margin-bottom:12px}
  .card{background:white;padding:16px 20px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:10px}
  .card h2{font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
  .form-row{display:flex;gap:12px;margin-bottom:8px}
  .form-group{flex:1;margin-bottom:8px}
  .form-group label{display:block;font-size:12px;font-weight:500;color:#86868b;margin-bottom:3px}
  .form-group input,.form-group textarea{width:100%;padding:8px 12px;border:1px solid #e5e5ea;border-radius:8px;font-size:13px;font-family:inherit;background:#fafafa;transition:all 0.2s}
  .form-group input:focus,.form-group textarea:focus{outline:none;border-color:#007AFF;background:white;box-shadow:0 0 0 3px rgba(0,122,255,0.1)}
  .form-group textarea{min-height:50px;resize:vertical}
  .items-table{width:100%;border-collapse:collapse;margin-top:8px}
  .items-table th{text-align:left;padding:6px 10px;font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #e5e5ea}
  .items-table td{padding:6px 10px;font-size:13px;border-bottom:1px solid #f2f2f7}
  .items-table th:last-child,.items-table td:last-child{text-align:right}
`;

var giftEditFontLink = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Poppins:ital,wght@0,400;0,700;1,400;1,700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&display=swap';

var giftEditStyles = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Inter,-apple-system,sans-serif;background:#F5F5F7}
  .edit-header{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid rgba(0,0,0,0.08);padding:10px 24px;display:flex;align-items:center;justify-content:space-between}
  .back-link{color:#007AFF;text-decoration:none;font-size:14px;font-weight:500}
  .back-link:hover{text-decoration:underline}
  .edit-title{font-size:15px;font-weight:600;color:#1d1d1f}
  .btn-black{background:#1d1d1f;color:white;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:600;border:none;cursor:pointer;transition:background 0.2s}
  .btn-black:hover{background:#000}
  .panels{display:flex;gap:20px;padding:12px 24px;max-width:1200px;margin:0 auto}
  .editor-panel{flex:1;max-width:420px}
  .preview-panel{flex:1;display:flex;flex-direction:column;align-items:center}
  .edit-note{font-size:12px;color:#86868b;margin-bottom:10px}
  .card-section{background:white;padding:14px 16px;border-radius:12px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
  .section-title{font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
  .form-group{margin-bottom:6px}
  .form-group label{display:block;font-size:12px;font-weight:500;color:#86868b;margin-bottom:2px}
  .form-group input[type="text"],.form-group textarea,.form-group select{width:100%;padding:7px 10px;border:1px solid #e5e5ea;border-radius:8px;font-size:13px;font-family:inherit;background:#fafafa;transition:all 0.2s}
  .form-group input:focus,.form-group textarea:focus,.form-group select:focus{outline:none;border-color:#007AFF;background:white;box-shadow:0 0 0 3px rgba(0,122,255,0.1)}
  .form-group textarea{min-height:50px;resize:vertical;line-height:1.5}
  .form-group select{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2386868b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px}
  .char-count{text-align:right;font-size:11px;color:#86868b;margin-top:2px}
  .slider-group{margin-bottom:6px}
  .slider-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
  .slider-label label{margin-bottom:0}
  .slider-value{font-size:12px;font-weight:600;color:#007AFF}
  input[type="range"]{width:100%;height:4px;border-radius:2px;background:#e5e5ea;outline:none;-webkit-appearance:none}
  input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:white;border:1px solid #d1d1d6;box-shadow:0 1px 3px rgba(0,0,0,0.15);cursor:pointer}
  .font-row{display:flex;gap:8px;margin-bottom:6px}
  .font-row>div{flex:1}
  .preview-label{font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
  .card-preview-container{background:#86868b;padding:16px;border-radius:12px}
  .card-preview{width:302px;height:612px;background:white;position:relative;box-shadow:0 4px 20px rgba(0,0,0,0.3);overflow:hidden}
  .card-top{position:absolute;left:0;right:0;text-align:center;padding:0 20px}
  .card-recipient{font-weight:bold;margin-bottom:12px;font-size:14px}
  .card-address{font-weight:bold;line-height:1.4;font-size:12px}
  .card-fold-line{position:absolute;top:306px;left:10px;right:10px;border-top:1px dashed #ccc}
  .fold-label{position:absolute;top:306px;right:15px;transform:translateY(-50%);font-size:9px;color:#999;background:white;padding:0 4px}
  .card-message-area{position:absolute;left:0;right:0;text-align:center;padding:0 20px}
  .card-message{line-height:1.4;word-wrap:break-word}
  .card-sender{margin-top:12px}
`;

var reprintBarStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Inter,-apple-system,sans-serif}
  .reprint-bar{position:fixed;top:0;left:0;right:0;z-index:999;background:rgba(255,255,255,0.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid rgba(0,0,0,0.08);padding:10px 24px;display:flex;align-items:center;justify-content:space-between}
  .reprint-bar a{color:#007AFF;text-decoration:none;font-size:14px;font-weight:500}
  .reprint-bar span{font-size:14px;font-weight:600;color:#1d1d1f}
  .reprint-bar button{background:#1d1d1f;color:white;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:600;border:none;cursor:pointer}
  .reprint-bar button:hover{background:#000}
  @media print{.reprint-bar{display:none!important}}
`;

var filterScript = '<script>function filterOrders(){var q=document.getElementById("searchBox").value.toLowerCase().trim();var rows=document.querySelectorAll("tbody tr");var f=0;for(var i=0;i<rows.length;i++){var r=rows[i];var s=r.getAttribute("data-search");if(!q||s.indexOf(q)>-1){r.classList.remove("hidden");f++}else{r.classList.add("hidden")}}document.getElementById("orderCount").textContent=f+" orders"+(q?\' matching "\'+q+\'"\':"");var n=document.getElementById("noResults");if(n)n.style.display=(f===0&&q)?"block":"none"}</script>';

// ============================================================================================
// DASHBOARD ROUTES
// ============================================================================================

app.get('/dashboard', async (req, res) => {
  try {
    var orders = await fetchOrders(250);
    var ordersWithGifts = [];
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      var notes = {};
      if (order.note_attributes) { for (var j = 0; j < order.note_attributes.length; j++) { notes[order.note_attributes[j].name] = order.note_attributes[j].value; } }
      if (notes['Gift Message'] && notes['Gift Message'].trim()) {
        var recipient = order.shipping_address ? order.shipping_address.name : 'N/A';
        var giftReceiver = notes['Gift Receiver'] || recipient;
        var d = new Date(order.created_at);
        var orderDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        var products = [];
        if (order.line_items) { for (var p = 0; p < order.line_items.length; p++) { if (order.line_items[p].title.toLowerCase().indexOf('tip') === -1) products.push(order.line_items[p].title); } }
        ordersWithGifts.push({ id: order.id, name: order.name, created: orderDate, giftReceiver: giftReceiver, products: products.join(', '), city: order.shipping_address ? order.shipping_address.city : '', searchStr: buildSearchString(order) });
      }
    }
    var rows = '';
    for (var k = 0; k < ordersWithGifts.length; k++) {
      var o = ordersWithGifts[k];
      rows += '<tr data-search="' + o.searchStr.replace(/"/g, '&quot;') + '">' +
        '<td class="col-order"><a href="/dashboard/edit/' + o.id + '">' + o.name + '</a></td>' +
        '<td class="col-date">' + o.created + '</td>' +
        '<td>' + o.giftReceiver + (o.city ? ' <span class="col-city">— ' + o.city + '</span>' : '') + '</td>' +
        '<td class="col-products">' + (o.products || '—') + '</td>' +
        '<td class="col-actions">' +
        '<a class="btn-print" href="/dashboard/quick-print/gift/' + o.id + '" target="_blank">Print Card</a>' +
        '<a class="btn-print" href="/dashboard/quick-print/invoice/' + o.id + '" target="_blank">Print Invoice</a>' +
        '</td></tr>';
    }
    var tableHtml = ordersWithGifts.length === 0 ? '<div class="empty-state">No orders with gift messages found</div>' :
      '<div class="table-wrap"><table><thead><tr><th>Order</th><th>Date</th><th>Recipient</th><th>Products</th><th style="text-align:right">Quick Print</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    res.send('<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orders — Gift Cards</title><style>' + dashboardStyles + '</style></head><body>' +
      '<div class="top-bar"><div class="top-left"></div><div class="seg-control"><a href="/dashboard" class="seg active">Gift Cards</a><a href="/dashboard/invoices" class="seg">Invoices</a></div>' +
      '<div class="top-right"><div class="search-wrap"><span class="search-icon">' + svgSearch + '</span><input type="text" class="search-input" id="searchBox" placeholder="Search orders..." oninput="filterOrders()"></div></div></div>' +
      '<div class="content"><div class="meta" id="orderCount">' + ordersWithGifts.length + ' orders with gift messages</div>' + tableHtml +
      '<div class="no-results" id="noResults">No matching orders</div></div>' + filterScript + '</body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/dashboard/invoices', async (req, res) => {
  try {
    var orders = await fetchOrders(250);
    var rows = '';
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      var recipient = order.shipping_address ? order.shipping_address.name : (order.customer ? (order.customer.first_name + ' ' + order.customer.last_name) : 'N/A');
      var city = order.shipping_address ? order.shipping_address.city : '';
      var shippingType = order.shipping_lines && order.shipping_lines[0] ? order.shipping_lines[0].title : (isInStoreOrder(order) ? 'In Store' : 'Standard');
      var d = new Date(order.created_at);
      var orderDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      var total = '$' + (order.total_price || '0.00');
      var hasGift = false;
      if (order.note_attributes) { for (var na = 0; na < order.note_attributes.length; na++) { if (order.note_attributes[na].name === 'Gift Message' && order.note_attributes[na].value && order.note_attributes[na].value.trim()) { hasGift = true; break; } } }
      var searchStr = buildSearchString(order);
      var gcBtn = hasGift ? '<a class="btn-print" href="/dashboard/quick-print/gift/' + order.id + '" target="_blank">Print Card</a>' : '';
      rows += '<tr data-search="' + searchStr.replace(/"/g, '&quot;') + '">' +
        '<td class="col-order"><a href="/dashboard/invoice/edit/' + order.id + '">' + order.name + '</a></td>' +
        '<td class="col-date">' + orderDate + '</td>' +
        '<td>' + recipient + (city ? ' <span class="col-city">— ' + city + '</span>' : '') + '</td>' +
        '<td class="col-type">' + shippingType + '</td>' +
        '<td class="col-total">' + total + '</td>' +
        '<td class="col-actions">' +
        '<a class="btn-print" href="/dashboard/quick-print/invoice/' + order.id + '" target="_blank">Print Invoice</a>' +
        gcBtn + '</td></tr>';
    }
    res.send('<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orders — Invoices</title><style>' + dashboardStyles + '</style></head><body>' +
      '<div class="top-bar"><div class="top-left"></div><div class="seg-control"><a href="/dashboard" class="seg">Gift Cards</a><a href="/dashboard/invoices" class="seg active">Invoices</a></div>' +
      '<div class="top-right"><div class="search-wrap"><span class="search-icon">' + svgSearch + '</span><input type="text" class="search-input" id="searchBox" placeholder="Search orders..." oninput="filterOrders()"></div></div></div>' +
      '<div class="content"><div class="meta" id="orderCount">' + orders.length + ' orders</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Order</th><th>Date</th><th>Recipient</th><th>Type</th><th>Total</th><th style="text-align:right">Quick Print</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="no-results" id="noResults">No matching orders</div></div>' + filterScript + '</body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============================================================================================
// EDIT ROUTES
// ============================================================================================

app.get('/dashboard/invoice/edit/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json(); var order = data.order; var orderData = extractOrderData(order);
    var recipientName = orderData.recipient.name || '';
    var address1 = orderData.recipient.address1 || '';
    var city = orderData.recipient.city || '';
    var province = orderData.recipient.province || '';
    var zip = orderData.recipient.zip || '';
    var phone = orderData.recipient.phone || '';
    var deliveryDate = orderData.deliveryDate || '';
    var specialInstructions = (orderData.specialInstructions || '').replace(/"/g, '&quot;');
    var shippingMethod = orderData.shippingMethod || '';
    var itemsHtml = '<table class="items-table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th></tr></thead><tbody>';
    for (var i = 0; i < orderData.items.length; i++) { var item = orderData.items[i]; itemsHtml += '<tr><td>' + item.title + '</td><td>' + item.sku + '</td><td>' + item.quantity + '</td><td>$' + item.price + '</td></tr>'; }
    itemsHtml += '</tbody></table>';
    res.send('<!DOCTYPE html><html><head><title>' + order.name + ' — Invoice</title><style>' + editStyles + '</style></head><body>' +
      '<form action="/dashboard/invoice/print/' + order.id + '" method="POST">' +
      '<div class="edit-header"><a href="/dashboard/invoices" class="back-link">← Back</a><span class="edit-title">' + order.name + ' — Invoice</span><button type="submit" class="btn-black">Print Invoice</button></div>' +
      '<div class="edit-content"><div class="edit-note">Changes are for printing only — not saved to Shopify.</div>' +
      '<div class="card"><h2>Recipient</h2><div class="form-row"><div class="form-group"><label>Name</label><input type="text" name="recipientName" value="' + recipientName + '"></div><div class="form-group"><label>Phone</label><input type="text" name="phone" value="' + phone + '"></div></div>' +
      '<div class="form-group"><label>Address</label><input type="text" name="address1" value="' + address1 + '"></div>' +
      '<div class="form-row"><div class="form-group"><label>City</label><input type="text" name="city" value="' + city + '"></div><div class="form-group"><label>State</label><input type="text" name="province" value="' + province + '"></div><div class="form-group"><label>ZIP</label><input type="text" name="zip" value="' + zip + '"></div></div></div>' +
      '<div class="card"><h2>Delivery</h2><div class="form-row"><div class="form-group"><label>Type</label><input type="text" name="shippingMethod" value="' + shippingMethod + '"></div><div class="form-group"><label>Date</label><input type="text" name="deliveryDate" value="' + deliveryDate + '"></div></div></div>' +
      '<div class="card"><h2>Items</h2>' + itemsHtml + '</div>' +
      '<div class="card"><h2>Special Instructions</h2><div class="form-group"><textarea name="specialInstructions" placeholder="Special instructions...">' + specialInstructions + '</textarea></div></div>' +
      '</div></form></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.post('/dashboard/invoice/print/:orderId', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json(); var orderData = extractOrderData(data.order);
    orderData.recipient.name = req.body.recipientName || orderData.recipient.name;
    orderData.recipient.phone = req.body.phone || orderData.recipient.phone;
    orderData.recipient.address1 = req.body.address1 || orderData.recipient.address1;
    orderData.recipient.city = req.body.city || orderData.recipient.city;
    orderData.recipient.province = req.body.province || orderData.recipient.province;
    orderData.recipient.zip = req.body.zip || orderData.recipient.zip;
    orderData.shippingMethod = req.body.shippingMethod || orderData.shippingMethod;
    orderData.deliveryDate = req.body.deliveryDate || orderData.deliveryDate;
    orderData.specialInstructions = req.body.specialInstructions || '';
    var html = generateInvoiceHTML(orderData);
    res.send('<!DOCTYPE html><html><head><title>Print Invoice</title><style>' + reprintBarStyles + '</style></head><body>' +
      '<div class="reprint-bar"><a href="/dashboard/invoices">← Back</a><span>' + orderData.orderNumber + ' — Invoice</span><button onclick="window.print()">Print Now</button></div>' +
      '<div style="margin-top:52px">' + html + '</div><script>setTimeout(function(){window.print()},500)</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/dashboard/edit/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json(); var order = data.order; var orderData = extractOrderData(order);
    var recipientName = orderData.giftReceiver || orderData.recipient.name || '';
    var address1 = orderData.recipient.address1 || '';
    var address2 = (orderData.recipient.city || '') + ', ' + (orderData.recipient.province || '') + ' ' + (orderData.recipient.zip || '');
    var giftMessage = (orderData.giftMessage || '').replace(/"/g, '&quot;');
    var giftSender = orderData.giftSender || '';
    res.send('<!DOCTYPE html><html><head><title>' + order.name + ' — Gift Card</title><link href="' + giftEditFontLink + '" rel="stylesheet"><style>' + giftEditStyles + '</style></head><body>' +
      '<form action="/dashboard/print-custom/' + order.id + '" method="POST">' +
      '<div class="edit-header"><a href="/dashboard" class="back-link">← Back</a><span class="edit-title">' + order.name + ' — Gift Card</span><button type="submit" class="btn-black">Print Gift Card</button></div>' +
      '<div class="panels"><div class="editor-panel">' +
      '<div class="edit-note">Changes are for printing only — not saved to Shopify.</div>' +
      '<div class="card-section"><div class="section-title">Recipient</div>' +
      '<div class="form-group"><label>Name</label><input type="text" name="recipientName" id="recipientName" value="' + recipientName + '" oninput="updatePreview()"></div>' +
      '<div class="form-group"><label>Address Line 1</label><input type="text" name="address1" id="address1" value="' + address1 + '" oninput="updatePreview()"></div>' +
      '<div class="form-group"><label>Address Line 2</label><input type="text" name="address2" id="address2" value="' + address2 + '" oninput="updatePreview()"></div>' +
      '<div class="slider-group"><div class="slider-label"><label>Position</label><span class="slider-value" id="topPosValue">36px</span></div><input type="range" id="topPosition" name="topPosition" min="20" max="100" value="36" oninput="updatePreview()"></div></div>' +
      '<div class="card-section"><div class="section-title">Message</div>' +
      '<div class="font-row"><div><label>Font</label><select name="fontFamily" id="fontFamily" onchange="updatePreview()"><option value="Montserrat, sans-serif">Montserrat</option><option value="Inter, sans-serif">Inter</option><option value="Poppins, sans-serif">Poppins</option><option value="Lato, sans-serif">Lato</option><option value="Open Sans, sans-serif">Open Sans</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Playfair Display, serif">Playfair Display</option><option value="Cormorant Garamond, serif">Cormorant Garamond</option></select></div>' +
      '<div><label>Weight</label><select name="fontWeight" id="fontWeight" onchange="updatePreview()"><option value="normal">Normal</option><option value="bold" selected>Bold</option></select></div>' +
      '<div><label>Style</label><select name="fontStyle" id="fontStyle" onchange="updatePreview()"><option value="normal">Normal</option><option value="italic">Italic</option></select></div></div>' +
      '<div class="slider-group"><div class="slider-label"><label>Size</label><span class="slider-value" id="fontSizeValue">12pt</span></div><input type="range" id="fontSize" name="fontSize" min="8" max="24" value="12" oninput="updatePreview()"></div>' +
      '<div class="slider-group"><div class="slider-label"><label>Position</label><span class="slider-value" id="msgPosValue">340px</span></div><input type="range" id="messagePosition" name="messagePosition" min="320" max="420" value="340" oninput="updatePreview()"></div>' +
      '<div class="form-group"><label>Message <span style="font-weight:400;color:#aaa">(max 300)</span></label><textarea name="giftMessage" id="giftMessage" maxlength="300" oninput="updatePreview();updateCharCount()">' + giftMessage + '</textarea><div class="char-count"><span id="charCount">0</span>/300</div></div>' +
      '<div class="form-group"><label>Sender Name</label><input type="text" name="giftSender" id="giftSender" value="' + giftSender + '" oninput="updatePreview()"></div></div></div>' +
      '<div class="preview-panel"><div class="preview-label">Preview</div><div class="card-preview-container"><div class="card-preview">' +
      '<div class="card-top" id="cardTop" style="top:36px"><div class="card-recipient" id="previewRecipient">' + recipientName + '</div><div class="card-address" id="previewAddress">' + address1 + '<br>' + address2 + '</div></div>' +
      '<div class="card-fold-line"></div><div class="fold-label">fold here</div>' +
      '<div class="card-message-area" id="cardMessageArea" style="top:340px"><div class="card-message" id="previewMessage">' + giftMessage + '</div><div class="card-sender" id="previewSender">' + giftSender + '</div></div></div></div></div></div></form>' +
      '<script>function updatePreview(){document.getElementById("previewRecipient").textContent=document.getElementById("recipientName").value;document.getElementById("previewAddress").innerHTML=document.getElementById("address1").value+"<br>"+document.getElementById("address2").value;var m=document.getElementById("giftMessage").value;document.getElementById("previewMessage").innerHTML=m.replace(/\\n/g,"<br>");document.getElementById("previewSender").textContent=document.getElementById("giftSender").value;var ff=document.getElementById("fontFamily").value;var fs=document.getElementById("fontSize").value+"pt";var fw=document.getElementById("fontWeight").value;var fst=document.getElementById("fontStyle").value;var tp=document.getElementById("topPosition").value+"px";var mp=document.getElementById("messagePosition").value+"px";var msg=document.getElementById("previewMessage");var snd=document.getElementById("previewSender");msg.style.fontFamily=ff;msg.style.fontSize=fs;msg.style.fontWeight=fw;msg.style.fontStyle=fst;snd.style.fontFamily=ff;snd.style.fontSize=fs;snd.style.fontWeight=fw;snd.style.fontStyle=fst;document.getElementById("cardTop").style.top=tp;document.getElementById("cardMessageArea").style.top=mp;document.getElementById("fontSizeValue").textContent=fs;document.getElementById("topPosValue").textContent=tp;document.getElementById("msgPosValue").textContent=mp}function updateCharCount(){document.getElementById("charCount").textContent=document.getElementById("giftMessage").value.length}updatePreview();updateCharCount()</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.post('/dashboard/print-custom/:orderId', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    var customData = {
      giftReceiver: req.body.recipientName, giftMessage: req.body.giftMessage, giftSender: req.body.giftSender,
      fontFamily: req.body.fontFamily || 'Arial, sans-serif', fontSize: (req.body.fontSize || '12') + 'pt',
      fontWeight: req.body.fontWeight || 'bold', fontStyle: req.body.fontStyle || 'normal',
      topPosition: (req.body.topPosition || '36') + 'px', messagePosition: (req.body.messagePosition || '340') + 'px',
      recipient: { name: req.body.recipientName, address1: req.body.address1, address2: '', city: '', province: '', zip: '' }
    };
    var cityMatch = req.body.address2.match(/^(.+),\s*([A-Z]{2})\s*(\d{5}(-\d{4})?)$/);
    if (cityMatch) { customData.recipient.city = cityMatch[1]; customData.recipient.province = cityMatch[2]; customData.recipient.zip = cityMatch[3]; }
    else { customData.recipient.city = req.body.address2; }
    var giftCardHTML = generateGiftCardHTML(customData);
    res.send('<!DOCTYPE html><html><head><title>Gift Card</title><style>' + reprintBarStyles + '</style></head><body>' +
      '<div class="reprint-bar"><a href="/dashboard">← Back</a><span>Gift Card</span><button onclick="window.print()">Print Now</button></div>' +
      '<div style="margin-top:52px">' + giftCardHTML + '</div><script>setTimeout(function(){window.print()},500)</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============================================================================================
// QUICK REPRINT
// ============================================================================================

app.get('/dashboard/quick-print/gift/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!response.ok) { return res.status(404).send('Order not found'); }
    var orderData = extractOrderData((await response.json()).order);
    var giftCardHTML = generateGiftCardHTML(orderData);
    res.send('<!DOCTYPE html><html><head><title>' + orderData.orderNumber + ' — Gift Card</title><style>' + reprintBarStyles + '</style></head><body>' +
      '<div class="reprint-bar"><a href="/dashboard">← Back</a><span>' + orderData.orderNumber + ' — Gift Card</span><button onclick="window.print()">Print Now</button></div>' +
      '<div style="margin-top:52px">' + giftCardHTML + '</div><script>setTimeout(function(){window.print()},700)</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/dashboard/quick-print/invoice/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!response.ok) { return res.status(404).send('Order not found'); }
    var orderData = extractOrderData((await response.json()).order);
    var invoiceHTML = generateInvoiceHTML(orderData);
    res.send('<!DOCTYPE html><html><head><title>' + orderData.orderNumber + ' — Invoice</title><style>' + reprintBarStyles + '</style></head><body>' +
      '<div class="reprint-bar"><a href="/dashboard/invoices">← Back</a><span>' + orderData.orderNumber + ' — Invoice</span><button onclick="window.print()">Print Now</button></div>' +
      '<div style="margin-top:52px">' + invoiceHTML + '</div><script>setTimeout(function(){window.print()},700)</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============================================================================================
// HOME
// ============================================================================================

app.get('/', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Sweet Tooth Order Printer</title><style>@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap");*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#F5F5F7}.wrap{text-align:center}h1{font-size:24px;font-weight:600;color:#1d1d1f;margin-bottom:6px}p{color:#86868b;margin-bottom:24px;font-size:14px}a{display:inline-block;padding:10px 24px;background:#1d1d1f;color:white;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px}a:hover{background:#000}</style></head><body><div class="wrap"><h1>Sweet Tooth Order Printer</h1><p>Automatic invoice and gift card printing</p><a href="/dashboard">Open Dashboard</a></div></body></html>');
});

app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
