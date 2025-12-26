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

// Log config on startup (without sensitive values)
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
  var browser = await puppeteer.launch({ 
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
  return htmlToPdfBase64(html, { width: '4.2in', height: '8.5in' });
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

// Check if order is from POS (in-store)
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
    console.log('Gift Message:', orderData.giftMessage ? 'YES (' + orderData.giftMessage.substring(0, 50) + '...)' : 'NO');
    
    // Print invoice
    var invoiceHTML = generateInvoiceHTML(orderData);
    var invoicePdf = await htmlToPdfBase64(invoiceHTML);
    if (CONFIG.printNode.invoicePrinterId) {
      await sendToPrintNode(invoicePdf, CONFIG.printNode.invoicePrinterId, 'Invoice ' + orderData.orderNumber);
      console.log('✓ Invoice sent to printer');
    } else {
      console.log('✗ Invoice printer not configured');
    }
    
    // Print gift card ONLY if:
    // 1. NOT an in-store order
    // 2. Has a gift message
    // 3. Gift card printer is configured
    var inStore = isInStoreOrder(order);
    console.log('Is In-Store Order:', inStore);
    
    if (inStore) {
      console.log('→ Skipping gift card (in-store order)');
    } else if (!orderData.giftMessage || !orderData.giftMessage.trim()) {
      console.log('→ No gift card (no gift message)');
    } else if (!CONFIG.printNode.giftCardPrinterId) {
      console.log('✗ Gift card printer not configured!');
    } else {
      console.log('→ Printing gift card...');
      var giftCardHTML = generateGiftCardHTML(orderData);
      var giftCardPdf = await giftCardToPdfBase64(giftCardHTML);
      await sendToPrintNode(giftCardPdf, CONFIG.printNode.giftCardPrinterId, 'Gift Card ' + orderData.orderNumber);
      console.log('✓ Gift card sent to printer');
    }
    
    console.log('========== ORDER COMPLETE:', orderName, '==========');
    console.log('');
    return { success: true, orderNumber: orderData.orderNumber };
  } catch (error) {
    console.log('✗ ERROR processing order:', error.message);
    return { success: false, error: error.message };
  }
}

// Webhooks
app.post('/webhook/orders/create', async (req, res) => {
  console.log('');
  console.log('>>> WEBHOOK RECEIVED: orders/create');
  
  if (!verifyShopifyWebhook(req)) { 
    console.log('>>> WEBHOOK REJECTED: Invalid signature');
    return res.status(401).send('Unauthorized'); 
  }
  
  res.status(200).send('OK');
  console.log('>>> WEBHOOK VERIFIED - Processing...');
  
  var order = JSON.parse(req.body);
  await printOrder(order);
});

app.post('/webhook/orders/paid', async (req, res) => {
  console.log('');
  console.log('>>> WEBHOOK RECEIVED: orders/paid');
  
  if (!verifyShopifyWebhook(req)) { 
    console.log('>>> WEBHOOK REJECTED: Invalid signature');
    return res.status(401).send('Unauthorized'); 
  }
  
  res.status(200).send('OK');
  console.log('>>> WEBHOOK VERIFIED - Processing...');
  
  var order = JSON.parse(req.body);
  await printOrder(order);
});

app.get('/print/:orderId', async (req, res) => {
  console.log('Manual print requested for order ID:', req.params.orderId);
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!response.ok) { return res.status(404).json({ error: 'Order not found' }); }
    res.json(await printOrder((await response.json()).order));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Debug endpoint to check gift message extraction
app.get('/debug/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    if (!response.ok) { return res.status(404).json({ error: 'Order not found' }); }
    var data = await response.json();
    var order = data.order;
    var orderData = extractOrderData(order);
    
    res.json({
      orderNumber: order.name,
      source_name: order.source_name,
      isInStore: isInStoreOrder(order),
      note_attributes: order.note_attributes,
      extracted: {
        deliveryType: orderData.deliveryType,
        giftMessage: orderData.giftMessage,
        giftSender: orderData.giftSender,
        giftReceiver: orderData.giftReceiver
      },
      config: {
        invoicePrinterConfigured: !!CONFIG.printNode.invoicePrinterId,
        giftCardPrinterConfigured: !!CONFIG.printNode.giftCardPrinterId
      }
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/health', (req, res) => { res.json({ status: 'ok' }); });

// ============ STYLES ============
var dashboardStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Inter, sans-serif; background: #f5f5f5; padding: 20px; }
  h1 { margin-bottom: 16px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab { padding: 10px 20px; border: none; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; }
  .tab.active { background: #2196F3; color: white; }
  .tab:not(.active) { background: #e0e0e0; color: #333; }
  .search-box { width: 100%; padding: 12px 16px; font-size: 16px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 20px; }
  .search-box:focus { outline: none; border-color: #2196F3; }
  .order-card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .order-card.hidden { display: none; }
  .order-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .order-number { font-weight: 600; font-size: 16px; }
  .order-date { color: #666; font-size: 13px; }
  .recipient { color: #333; margin-bottom: 4px; }
  .order-details { display: flex; gap: 16px; margin: 8px 0; font-size: 13px; color: #666; }
  .gift-message, .special-notes { background: #f9f9f9; padding: 10px; border-radius: 4px; margin: 8px 0; font-size: 14px; line-height: 1.5; }
  .sender { font-style: italic; color: #666; font-size: 13px; }
  .actions { margin-top: 12px; }
  .btn { display: inline-block; padding: 8px 16px; border-radius: 4px; text-decoration: none; font-size: 13px; font-weight: 500; margin-right: 8px; cursor: pointer; border: none; }
  .btn-edit { background: #2196F3; color: white; }
  .btn-preview { background: #e0e0e0; color: #333; }
  .empty { text-align: center; padding: 40px; color: #666; }
  .no-results { text-align: center; padding: 40px; color: #666; display: none; }
  .note { background: #fff3cd; padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; color: #856404; }
`;

var editStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Inter, sans-serif; background: #f0f2f5; min-height: 100vh; }
  .header { background: white; padding: 16px 24px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 20px; }
  .header a { padding: 8px 16px; background: #e0e0e0; color: #333; text-decoration: none; border-radius: 4px; font-size: 14px; }
  .container { max-width: 900px; margin: 30px auto; padding: 0 20px; }
  .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; }
  .card h2 { font-size: 16px; margin-bottom: 16px; border-bottom: 1px solid #eee; padding-bottom: 12px; }
  .form-row { display: flex; gap: 16px; margin-bottom: 16px; }
  .form-group { flex: 1; margin-bottom: 16px; }
  .form-group label { display: block; font-weight: 500; margin-bottom: 6px; font-size: 13px; color: #555; }
  .form-group input, .form-group textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #2196F3; }
  .form-group textarea { min-height: 100px; resize: vertical; }
  .items-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  .items-table th, .items-table td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; font-size: 14px; }
  .items-table th { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; }
  .btn { padding: 12px 24px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; }
  .btn-print { background: #4CAF50; color: white; width: 100%; }
  .btn-print:hover { background: #43A047; }
  .note { background: #e3f2fd; padding: 12px; border-radius: 6px; margin-bottom: 20px; font-size: 13px; color: #1565c0; }
`;

// ============ GIFT CARD DASHBOARD ============
app.get('/dashboard', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?limit=50&status=any', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json();
    var ordersWithGifts = [];
    
    for (var i = 0; i < data.orders.length; i++) {
      var order = data.orders[i];
      var notes = {};
      if (order.note_attributes) {
        for (var j = 0; j < order.note_attributes.length; j++) {
          notes[order.note_attributes[j].name] = order.note_attributes[j].value;
        }
      }
      if (notes['Gift Message'] && notes['Gift Message'].trim()) {
        var recipient = order.shipping_address ? order.shipping_address.name : 'N/A';
        var sender = notes['Gift Sender'] || '';
        var orderDate = new Date(order.created_at).toLocaleDateString();
        var total = order.total_price || '0.00';
        ordersWithGifts.push({
          id: order.id,
          name: order.name,
          created: orderDate,
          recipient: recipient,
          giftMessage: notes['Gift Message'],
          giftSender: sender,
          total: total,
          searchStr: (order.name + ' ' + recipient + ' ' + sender + ' ' + orderDate + ' ' + total).toLowerCase()
        });
      }
    }
    
    var orderCards = '';
    for (var k = 0; k < ordersWithGifts.length; k++) {
      var o = ordersWithGifts[k];
      orderCards += '<div class="order-card" data-search="' + o.searchStr + '">' +
        '<div class="order-header"><span class="order-number">' + o.name + '</span><span class="order-date">' + o.created + '</span></div>' +
        '<div class="recipient">To: <strong>' + o.recipient + '</strong></div>' +
        '<div class="gift-message">' + o.giftMessage + '</div>' +
        '<div class="sender">From: ' + (o.giftSender || 'Not specified') + '</div>' +
        '<div class="actions"><a href="/dashboard/edit/' + o.id + '" class="btn btn-edit">Edit & Print</a></div></div>';
    }
    
    var html = '<!DOCTYPE html><html><head><title>Gift Card Dashboard</title><style>' + dashboardStyles + '</style></head><body>' +
      '<h1>Dashboard</h1>' +
      '<div class="tabs"><a href="/dashboard" class="tab active">Gift Cards</a><a href="/dashboard/invoices" class="tab">Invoices</a></div>' +
      '<div class="note">📋 Data is pulled from Shopify in real-time. Edits are for printing only and do not update Shopify.</div>' +
      '<input type="text" class="search-box" id="searchBox" placeholder="Search by order #, name, date, amount..." oninput="filterOrders()">' +
      (ordersWithGifts.length === 0 ? '<div class="empty">No orders with gift messages found</div>' : orderCards) +
      '<div class="no-results" id="noResults">No matching orders found</div>' +
      '<script>function filterOrders(){var q=document.getElementById("searchBox").value.toLowerCase().trim();var cards=document.querySelectorAll(".order-card");var found=0;for(var i=0;i<cards.length;i++){var card=cards[i];var searchData=card.getAttribute("data-search");if(!q||searchData.indexOf(q)>-1){card.classList.remove("hidden");found++;}else{card.classList.add("hidden");}}var nr=document.getElementById("noResults");if(nr)nr.style.display=(found===0&&q)?"block":"none";}</script></body></html>';
    
    res.send(html);
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============ INVOICE DASHBOARD ============
app.get('/dashboard/invoices', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders.json?limit=50&status=any', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json();
    var orderCards = '';
    
    for (var i = 0; i < data.orders.length; i++) {
      var order = data.orders[i];
      var recipient = order.shipping_address ? order.shipping_address.name : 'N/A';
      var shippingType = order.shipping_lines && order.shipping_lines[0] ? order.shipping_lines[0].title : 'Standard';
      var orderDate = new Date(order.created_at).toLocaleDateString();
      var total = '$' + (order.total_price || '0.00');
      var itemCount = order.line_items ? order.line_items.length : 0;
      var searchStr = (order.name + ' ' + recipient + ' ' + shippingType + ' ' + orderDate + ' ' + total).toLowerCase();
      
      orderCards += '<div class="order-card" data-search="' + searchStr + '">' +
        '<div class="order-header"><span class="order-number">' + order.name + '</span><span class="order-date">' + orderDate + '</span></div>' +
        '<div class="recipient">To: <strong>' + recipient + '</strong></div>' +
        '<div class="order-details"><span>' + shippingType + '</span><span>' + itemCount + ' item(s)</span><span>' + total + '</span></div>' +
        '<div class="actions"><a href="/dashboard/invoice/edit/' + order.id + '" class="btn btn-edit">Edit & Print</a></div></div>';
    }
    
    var html = '<!DOCTYPE html><html><head><title>Invoice Dashboard</title><style>' + dashboardStyles + '</style></head><body>' +
      '<h1>Dashboard</h1>' +
      '<div class="tabs"><a href="/dashboard" class="tab">Gift Cards</a><a href="/dashboard/invoices" class="tab active">Invoices</a></div>' +
      '<div class="note">📋 Data is pulled from Shopify in real-time. Edits are for printing only and do not update Shopify.</div>' +
      '<input type="text" class="search-box" id="searchBox" placeholder="Search by order #, name, delivery type, date, amount..." oninput="filterOrders()">' +
      orderCards +
      '<div class="no-results" id="noResults">No matching orders found</div>' +
      '<script>function filterOrders(){var q=document.getElementById("searchBox").value.toLowerCase().trim();var cards=document.querySelectorAll(".order-card");var found=0;for(var i=0;i<cards.length;i++){var card=cards[i];var searchData=card.getAttribute("data-search");if(!q||searchData.indexOf(q)>-1){card.classList.remove("hidden");found++;}else{card.classList.add("hidden");}}var nr=document.getElementById("noResults");if(nr)nr.style.display=(found===0&&q)?"block":"none";}</script></body></html>';
    
    res.send(html);
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============ INVOICE EDIT ============
app.get('/dashboard/invoice/edit/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json();
    var order = data.order;
    var orderData = extractOrderData(order);
    
    var recipientName = orderData.recipient.name || '';
    var address1 = orderData.recipient.address1 || '';
    var city = orderData.recipient.city || '';
    var province = orderData.recipient.province || '';
    var zip = orderData.recipient.zip || '';
    var phone = orderData.recipient.phone || '';
    var deliveryDate = orderData.deliveryDate || '';
    var specialInstructions = (orderData.specialInstructions || '').replace(/"/g, '&quot;');
    var shippingMethod = orderData.shippingMethod || '';
    
    // Build items table
    var itemsHtml = '<table class="items-table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th></tr></thead><tbody>';
    for (var i = 0; i < orderData.items.length; i++) {
      var item = orderData.items[i];
      itemsHtml += '<tr><td>' + item.title + '</td><td>' + item.sku + '</td><td>' + item.quantity + '</td><td>$' + item.price + '</td></tr>';
    }
    itemsHtml += '</tbody></table>';
    
    var html = '<!DOCTYPE html><html><head><title>Edit Invoice - ' + order.name + '</title><style>' + editStyles + '</style></head><body>' +
      '<div class="header"><h1>Edit Invoice - ' + order.name + '</h1><a href="/dashboard/invoices">← Back to Dashboard</a></div>' +
      '<form action="/dashboard/invoice/print/' + order.id + '" method="POST">' +
      '<div class="container">' +
      '<div class="note">✏️ Changes here are for printing only. They will not be saved to Shopify.</div>' +
      
      '<div class="card"><h2>Recipient Information</h2>' +
      '<div class="form-row">' +
      '<div class="form-group"><label>Recipient Name</label><input type="text" name="recipientName" value="' + recipientName + '"></div>' +
      '<div class="form-group"><label>Phone</label><input type="text" name="phone" value="' + phone + '"></div>' +
      '</div>' +
      '<div class="form-group"><label>Address</label><input type="text" name="address1" value="' + address1 + '"></div>' +
      '<div class="form-row">' +
      '<div class="form-group"><label>City</label><input type="text" name="city" value="' + city + '"></div>' +
      '<div class="form-group"><label>State</label><input type="text" name="province" value="' + province + '"></div>' +
      '<div class="form-group"><label>ZIP</label><input type="text" name="zip" value="' + zip + '"></div>' +
      '</div></div>' +
      
      '<div class="card"><h2>Delivery Details</h2>' +
      '<div class="form-row">' +
      '<div class="form-group"><label>Delivery Type</label><input type="text" name="shippingMethod" value="' + shippingMethod + '"></div>' +
      '<div class="form-group"><label>Delivery Date</label><input type="text" name="deliveryDate" value="' + deliveryDate + '"></div>' +
      '</div></div>' +
      
      '<div class="card"><h2>Order Items</h2>' + itemsHtml + '</div>' +
      
      '<div class="card"><h2>Special Instructions</h2>' +
      '<div class="form-group"><textarea name="specialInstructions" placeholder="Enter any special instructions...">' + specialInstructions + '</textarea></div>' +
      '<button type="submit" class="btn btn-print">Print Invoice</button></div>' +
      
      '</div></form></body></html>';
    
    res.send(html);
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============ INVOICE PRINT ============
app.post('/dashboard/invoice/print/:orderId', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json();
    var orderData = extractOrderData(data.order);
    
    // Override with form data
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
    res.send('<!DOCTYPE html><html><head><title>Print Invoice</title><style>@media print{.no-print{display:none!important}}</style></head><body>' +
      '<a href="/dashboard/invoices" class="no-print" style="position:fixed;top:20px;left:20px;font-family:sans-serif;font-size:14px;color:#333;text-decoration:none;">← Back</a>' +
      '<button class="no-print" onclick="window.print()" style="position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#4CAF50;color:white;padding:12px 24px;border-radius:6px;font-family:sans-serif;font-size:14px;cursor:pointer;border:none;">Print (Cmd+P)</button>' +
      html + '<script>setTimeout(function(){window.print();},500);</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============ GIFT CARD EDIT ============
app.get('/dashboard/edit/:orderId', async (req, res) => {
  try {
    var response = await fetch('https://' + CONFIG.shopify.store + '/admin/api/2024-01/orders/' + req.params.orderId + '.json', { headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token } });
    var data = await response.json();
    var order = data.order;
    var orderData = extractOrderData(order);
    
    var recipientName = orderData.giftReceiver || orderData.recipient.name || '';
    var address1 = orderData.recipient.address1 || '';
    var address2 = (orderData.recipient.city || '') + ', ' + (orderData.recipient.province || '') + ' ' + (orderData.recipient.zip || '');
    var giftMessage = (orderData.giftMessage || '').replace(/"/g, '&quot;');
    var giftSender = orderData.giftSender || '';
    
    res.send('<!DOCTYPE html><html><head><title>Edit Gift Card - ' + order.name + '</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Poppins:ital,wght@0,400;0,700;1,400;1,700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,sans-serif;background:#f0f2f5;min-height:100vh}.header{background:white;padding:16px 24px;border-bottom:1px solid #e0e0e0;display:flex;justify-content:space-between;align-items:center}.header h1{font-size:20px;font-weight:600}.header-actions a{padding:8px 16px;background:#e0e0e0;color:#333;text-decoration:none;border-radius:4px;font-size:14px}.container{display:flex;gap:40px;padding:30px;max-width:1200px;margin:0 auto}.editor-panel{flex:1;max-width:450px}.preview-panel{flex:1;display:flex;flex-direction:column;align-items:center}.card-section{background:white;padding:24px;border-radius:12px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.section-title{font-size:14px;font-weight:600;color:#333;margin-bottom:16px}.form-group{margin-bottom:16px}label{display:block;font-weight:500;margin-bottom:6px;font-size:13px;color:#555}input[type="text"],textarea,select{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;font-family:inherit}input:focus,textarea:focus,select:focus{outline:none;border-color:#2196F3}textarea{min-height:120px;resize:vertical;line-height:1.5}.char-count{text-align:right;font-size:12px;color:#888;margin-top:4px}.slider-group{margin-bottom:16px}.slider-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.slider-value{font-weight:600;color:#2196F3}input[type="range"]{width:100%;height:6px;border-radius:3px;background:#ddd;outline:none;-webkit-appearance:none}input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#2196F3;cursor:pointer}.font-row{display:flex;gap:12px;margin-bottom:12px}.font-row>div{flex:1}.btn{padding:12px 24px;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer;border:none}.btn-print{background:#4CAF50;color:white;width:100%;margin-top:8px}.btn-print:hover{background:#43A047}.preview-label{font-size:14px;font-weight:600;color:#333;margin-bottom:16px}.card-preview-container{background:#888;padding:20px;border-radius:8px}.card-preview{width:302px;height:612px;background:white;position:relative;box-shadow:0 4px 20px rgba(0,0,0,0.3);overflow:hidden}.card-top{position:absolute;left:0;right:0;text-align:center;padding:0 20px}.card-recipient{font-weight:bold;margin-bottom:12px;font-size:14px}.card-address{font-weight:bold;line-height:1.4;font-size:12px}.card-fold-line{position:absolute;top:306px;left:10px;right:10px;border-top:1px dashed #ccc}.fold-label{position:absolute;top:306px;right:15px;transform:translateY(-50%);font-size:9px;color:#999;background:white;padding:0 4px}.card-message-area{position:absolute;left:0;right:0;text-align:center;padding:0 20px}.card-message{line-height:1.4;word-wrap:break-word}.card-sender{margin-top:12px}.note{background:#e3f2fd;padding:12px;border-radius:6px;margin-bottom:20px;font-size:13px;color:#1565c0}</style></head><body><div class="header"><h1>Edit Gift Card - ' + order.name + '</h1><div class="header-actions"><a href="/dashboard">← Back to Dashboard</a></div></div><form action="/dashboard/print-custom/' + order.id + '" method="POST"><div class="container"><div class="editor-panel"><div class="note">✏️ Changes are for printing only. They will not be saved to Shopify.</div><div class="card-section"><div class="section-title">Recipient Information</div><div class="form-group"><label>Recipient Name</label><input type="text" name="recipientName" id="recipientName" value="' + recipientName + '" oninput="updatePreview()"></div><div class="form-group"><label>Address Line 1</label><input type="text" name="address1" id="address1" value="' + address1 + '" oninput="updatePreview()"></div><div class="form-group"><label>Address Line 2</label><input type="text" name="address2" id="address2" value="' + address2 + '" oninput="updatePreview()"></div><div class="slider-group"><div class="slider-label"><label>Name/Address Position</label><span class="slider-value" id="topPosValue">36px</span></div><input type="range" id="topPosition" name="topPosition" min="20" max="100" value="36" oninput="updatePreview()"></div></div><div class="card-section"><div class="section-title">Gift Message</div><div class="font-row"><div><label>Font</label><select name="fontFamily" id="fontFamily" onchange="updatePreview()"><option value="Montserrat, sans-serif">Montserrat</option><option value="Inter, sans-serif">Inter</option><option value="Poppins, sans-serif">Poppins</option><option value="Lato, sans-serif">Lato</option><option value="Open Sans, sans-serif">Open Sans</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Playfair Display, serif">Playfair Display</option><option value="Cormorant Garamond, serif">Cormorant Garamond</option></select></div><div><label>Weight</label><select name="fontWeight" id="fontWeight" onchange="updatePreview()"><option value="normal">Normal</option><option value="bold" selected>Bold</option></select></div></div><div class="font-row"><div><label>Style</label><select name="fontStyle" id="fontStyle" onchange="updatePreview()"><option value="normal">Normal</option><option value="italic">Italic</option></select></div></div><div class="slider-group"><div class="slider-label"><label>Font Size</label><span class="slider-value" id="fontSizeValue">12pt</span></div><input type="range" id="fontSize" name="fontSize" min="8" max="24" value="12" oninput="updatePreview()"></div><div class="slider-group"><div class="slider-label"><label>Message Position</label><span class="slider-value" id="msgPosValue">340px</span></div><input type="range" id="messagePosition" name="messagePosition" min="320" max="420" value="340" oninput="updatePreview()"></div><div class="form-group"><label>Message (max 300 chars)</label><textarea name="giftMessage" id="giftMessage" maxlength="300" oninput="updatePreview();updateCharCount()">' + giftMessage + '</textarea><div class="char-count"><span id="charCount">0</span>/300</div></div><div class="form-group"><label>From (Sender)</label><input type="text" name="giftSender" id="giftSender" value="' + giftSender + '" oninput="updatePreview()"></div></div><button type="submit" class="btn btn-print">Print Gift Card</button></div><div class="preview-panel"><div class="preview-label">Gift Card Preview</div><div class="card-preview-container"><div class="card-preview"><div class="card-top" id="cardTop" style="top:36px"><div class="card-recipient" id="previewRecipient">' + recipientName + '</div><div class="card-address" id="previewAddress">' + address1 + '<br>' + address2 + '</div></div><div class="card-fold-line"></div><div class="fold-label">fold here</div><div class="card-message-area" id="cardMessageArea" style="top:340px"><div class="card-message" id="previewMessage">' + giftMessage + '</div><div class="card-sender" id="previewSender">' + giftSender + '</div></div></div></div></div></div></form><script>function updatePreview(){document.getElementById("previewRecipient").textContent=document.getElementById("recipientName").value;document.getElementById("previewAddress").innerHTML=document.getElementById("address1").value+"<br>"+document.getElementById("address2").value;var m=document.getElementById("giftMessage").value;document.getElementById("previewMessage").innerHTML=m.replace(/\\n/g,"<br>");document.getElementById("previewSender").textContent=document.getElementById("giftSender").value;var ff=document.getElementById("fontFamily").value;var fs=document.getElementById("fontSize").value+"pt";var fw=document.getElementById("fontWeight").value;var fst=document.getElementById("fontStyle").value;var tp=document.getElementById("topPosition").value+"px";var mp=document.getElementById("messagePosition").value+"px";var msg=document.getElementById("previewMessage");var snd=document.getElementById("previewSender");msg.style.fontFamily=ff;msg.style.fontSize=fs;msg.style.fontWeight=fw;msg.style.fontStyle=fst;snd.style.fontFamily=ff;snd.style.fontSize=fs;snd.style.fontWeight=fw;snd.style.fontStyle=fst;document.getElementById("cardTop").style.top=tp;document.getElementById("cardMessageArea").style.top=mp;document.getElementById("fontSizeValue").textContent=fs;document.getElementById("topPosValue").textContent=tp;document.getElementById("msgPosValue").textContent=mp}function updateCharCount(){document.getElementById("charCount").textContent=document.getElementById("giftMessage").value.length}updatePreview();updateCharCount()</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============ GIFT CARD PRINT ============
app.post('/dashboard/print-custom/:orderId', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    var customData = {
      giftReceiver: req.body.recipientName,
      giftMessage: req.body.giftMessage,
      giftSender: req.body.giftSender,
      fontFamily: req.body.fontFamily || 'Arial, sans-serif',
      fontSize: (req.body.fontSize || '12') + 'pt',
      fontWeight: req.body.fontWeight || 'bold',
      fontStyle: req.body.fontStyle || 'normal',
      topPosition: (req.body.topPosition || '36') + 'px',
      messagePosition: (req.body.messagePosition || '340') + 'px',
      recipient: { name: req.body.recipientName, address1: req.body.address1, address2: '', city: '', province: '', zip: '' }
    };
    var cityMatch = req.body.address2.match(/^(.+),\s*([A-Z]{2})\s*(\d{5}(-\d{4})?)$/);
    if (cityMatch) { customData.recipient.city = cityMatch[1]; customData.recipient.province = cityMatch[2]; customData.recipient.zip = cityMatch[3]; }
    else { customData.recipient.city = req.body.address2; }
    var giftCardHTML = generateGiftCardHTML(customData);
    res.send('<!DOCTYPE html><html><head><title>Gift Card</title><style>@media print{.no-print{display:none!important}body{margin:0;padding:0}@page{margin:0}}</style></head><body><a href="/dashboard" class="no-print" style="position:fixed;top:20px;left:20px;font-family:sans-serif;font-size:14px;color:#333;text-decoration:none">← Back</a><button class="no-print" onclick="window.print()" style="position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#4CAF50;color:white;padding:12px 24px;border-radius:6px;font-family:sans-serif;font-size:14px;cursor:pointer;border:none">Print (Cmd+P)</button>' + giftCardHTML + '<script>setTimeout(function(){window.print()},500)</script></body></html>');
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// ============ HOME ============
app.get('/', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Sweet Tooth Order Printer</title><style>body{font-family:sans-serif;max-width:600px;margin:50px auto;padding:20px}h1{margin-bottom:10px}.subtitle{color:#666;margin-bottom:30px}.btn{display:inline-block;padding:12px 24px;background:#4CAF50;color:white;text-decoration:none;border-radius:6px;font-weight:500}</style></head><body><h1>Sweet Tooth Order Printer</h1><p class="subtitle">Automatic invoice and gift card printing</p><a href="/dashboard" class="btn">Open Dashboard</a></body></html>');
});

app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
