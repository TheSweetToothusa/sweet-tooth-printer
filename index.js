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

// =============================================================================
// CONFIGURATION
// =============================================================================

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

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function verifyShopifyWebhook(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const hash = crypto
    .createHmac('sha256', CONFIG.shopify.webhookSecret)
    .update(req.body, 'utf8')
    .digest('base64');
  return hmac === hash;
}

// =============================================================================
// PDF GENERATION
// =============================================================================

async function htmlToPdfBase64(html, options = {}) {
  const browser = await puppeteer.launch({ 
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  
  const pdfOptions = {
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    ...options
  };
  
  // Default to Letter size unless specified
  if (!options.width && !options.height) {
    pdfOptions.format = 'Letter';
  }
  
  const pdfBuffer = await page.pdf(pdfOptions);
  
  await browser.close();
  return pdfBuffer.toString('base64');
}

// Gift card PDF - 4.2" x 8.5"
async function giftCardToPdfBase64(html) {
  return htmlToPdfBase64(html, {
    width: '4.2in',
    height: '8.5in'
  });
}

// =============================================================================
// PRINTNODE INTEGRATION
// =============================================================================

async function sendToPrintNode(pdfBase64, printerId, title) {
  const response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      printerId: parseInt(printerId),
      title: title,
      contentType: 'pdf_base64',
      content: pdfBase64,
      source: 'Sweet Tooth Order Printer'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PrintNode error: ${response.status} - ${error}`);
  }

  return await response.json();
}

// =============================================================================
// MAIN PRINT FUNCTION
// =============================================================================

async function printOrder(order) {
  console.log(`\n📦 Processing order ${order.name || order.order_number}...`);
  
  try {
    const orderData = extractOrderData(order);
    console.log(`   Type: ${orderData.deliveryType}`);
    console.log(`   Recipient: ${orderData.recipient.name}`);
    console.log(`   Items: ${orderData.items.length}`);

    // Print Invoice
    const invoiceHTML = generateInvoiceHTML(orderData);
    console.log('   Generating invoice PDF...');
    const invoicePdf = await htmlToPdfBase64(invoiceHTML);
    
    if (CONFIG.printNode.invoicePrinterId) {
      console.log('   Sending invoice to printer...');
      const invoiceResult = await sendToPrintNode(
        invoicePdf, 
        CONFIG.printNode.invoicePrinterId,
        `Invoice ${orderData.orderNumber}`
      );
      console.log(`   ✅ Invoice print job: ${invoiceResult}`);
    } else {
      console.log('   ⚠️ No invoice printer configured');
    }

    // Print Gift Card if message exists
    if (orderData.giftMessage && orderData.giftMessage.trim()) {
      console.log('   📝 Gift message found, generating gift card...');
      const giftCardHTML = generateGiftCardHTML(orderData);
      const giftCardPdf = await giftCardToPdfBase64(giftCardHTML);
      
      if (CONFIG.printNode.giftCardPrinterId) {
        console.log('   Sending gift card to printer...');
        const giftCardResult = await sendToPrintNode(
          giftCardPdf,
          CONFIG.printNode.giftCardPrinterId,
          `Gift Card ${orderData.orderNumber}`
        );
        console.log(`   ✅ Gift card print job: ${giftCardResult}`);
      } else {
        console.log('   ⚠️ No gift card printer configured');
      }
    }

    return { success: true, orderNumber: orderData.orderNumber };
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// =============================================================================
// WEBHOOK ENDPOINTS
// =============================================================================

app.post('/webhook/orders/create', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.log('❌ Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }

  const order = JSON.parse(req.body);
  console.log(`\n🔔 Webhook received: Order ${order.name}`);

  res.status(200).send('OK');
  await printOrder(order);
});

app.post('/webhook/orders/paid', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }

  const order = JSON.parse(req.body);
  console.log(`\n🔔 Webhook received: Order ${order.name} paid`);

  res.status(200).send('OK');
  await printOrder(order);
});

// =============================================================================
// MANUAL ENDPOINTS
// =============================================================================

app.get('/print/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    
    const response = await fetch(
      `https://${CONFIG.shopify.store}/admin/api/2024-01/orders/${orderId}.json`,
      {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token }
      }
    );

    if (!response.ok) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { order } = await response.json();
    const result = await printOrder(order);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/print-recent/:count?', async (req, res) => {
  try {
    const count = parseInt(req.params.count) || 5;
    
    const response = await fetch(
      `https://${CONFIG.shopify.store}/admin/api/2024-01/orders.json?limit=${count}&status=any`,
      {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token }
      }
    );

    const { orders } = await response.json();
    const results = [];

    for (const order of orders) {
      const result = await printOrder(order);
      results.push(result);
    }

    res.json({ printed: results.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    printer: CONFIG.printNode.invoicePrinterId ? 'configured' : 'not configured'
  });
});

// =============================================================================
// DASHBOARD - View, Edit, Reprint Gift Cards
// =============================================================================

// Dashboard home - list recent orders with gift messages
app.get('/dashboard', async (req, res) => {
  try {
    const response = await fetch(
      `https://${CONFIG.shopify.store}/admin/api/2024-01/orders.json?limit=50&status=any`,
      {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token }
      }
    );

    const { orders } = await response.json();
    
    // Filter orders with gift messages
    const ordersWithGifts = orders.filter(order => {
      const notes = {};
      (order.note_attributes || []).forEach(attr => {
        notes[attr.name] = attr.value;
      });
      return notes['Gift Message'] && notes['Gift Message'].trim();
    }).map(order => {
      const notes = {};
      (order.note_attributes || []).forEach(attr => {
        notes[attr.name] = attr.value;
      });
      return {
        id: order.id,
        name: order.name,
        created: new Date(order.created_at).toLocaleDateString(),
        recipient: order.shipping_address?.name || 'N/A',
        giftMessage: notes['Gift Message'] || '',
        giftSender: notes['Gift Sender'] || ''
      };
    });

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Sweet Tooth - Gift Card Dashboard</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #f5f5f5; padding: 20px; }
    h1 { margin-bottom: 20px; }
    .order-card {
      background: white;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .order-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .order-number { font-weight: 600; font-size: 16px; }
    .order-date { color: #666; font-size: 13px; }
    .recipient { color: #333; margin-bottom: 4px; }
    .gift-message {
      background: #f9f9f9;
      padding: 10px;
      border-radius: 4px;
      margin: 8px 0;
      font-size: 14px;
      line-height: 1.5;
    }
    .sender { font-style: italic; color: #666; font-size: 13px; }
    .actions { margin-top: 12px; }
    .btn {
      display: inline-block;
      padding: 8px 16px;
      border-radius: 4px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      margin-right: 8px;
      cursor: pointer;
      border: none;
    }
    .btn-preview { background: #e0e0e0; color: #333; }
    .btn-edit { background: #2196F3; color: white; }
    .btn-print { background: #4CAF50; color: white; }
    .empty { text-align: center; padding: 40px; color: #666; }
  </style>
</head>
<body>
  <h1>🍫 Gift Card Dashboard</h1>
  ${ordersWithGifts.length === 0 ? '<div class="empty">No orders with gift messages found</div>' : ''}
  ${ordersWithGifts.map(order => `
    <div class="order-card">
      <div class="order-header">
        <span class="order-number">${order.name}</span>
        <span class="order-date">${order.created}</span>
      </div>
      <div class="recipient">To: <strong>${order.recipient}</strong></div>
      <div class="gift-message">${order.giftMessage}</div>
      <div class="sender">From: ${order.giftSender || 'Not specified'}</div>
      <div class="actions">
        <a href="/dashboard/preview/${order.id}" class="btn btn-preview" target="_blank">Preview</a>
        <a href="/dashboard/edit/${order.id}" class="btn btn-edit">Edit</a>
        <a href="/dashboard/reprint/${order.id}" class="btn btn-print" onclick="return confirm('Print this gift card?')">Reprint</a>
      </div>
    </div>
  `).join('')}
</body>
</html>`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Preview gift card
app.get('/dashboard/preview/:orderId', async (req, res) => {
  try {
    const response = await fetch(
      `https://${CONFIG.shopify.store}/admin/api/2024-01/orders/${req.params.orderId}.json`,
      {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token }
      }
    );

    const { order } = await response.json();
    const orderData = extractOrderData(order);
    const html = generateGiftCardHTML(orderData);
    
    // Wrap in preview container
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Gift Card Preview - ${order.name}</title>
  <style>
    body { background: #666; display: flex; justify-content: center; padding: 20px; }
    .preview { box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
  </style>
</head>
<body>
  <div class="preview">
    ${html.replace('<!DOCTYPE html>', '').replace('<html dir="ltr">', '').replace('</html>', '').replace(/<head>[\s\S]*<\/head>/, '')}
  </div>
</body>
</html>`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Edit gift card form with live preview
app.get('/dashboard/edit/:orderId', async (req, res) => {
  try {
    const response = await fetch(
      `https://${CONFIG.shopify.store}/admin/api/2024-01/orders/${req.params.orderId}.json`,
      {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token }
      }
    );

    const { order } = await response.json();
    const orderData = extractOrderData(order);
    
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Edit Gift Card - ${order.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Arial&family=Georgia&family=Times+New+Roman&family=Courier+New&family=Palatino+Linotype&family=Book+Antiqua&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Inter', sans-serif; 
      background: #f0f2f5; 
      min-height: 100vh;
    }
    
    .header {
      background: white;
      padding: 16px 24px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .header h1 {
      font-size: 20px;
      font-weight: 600;
    }
    
    .header-actions a {
      padding: 8px 16px;
      background: #e0e0e0;
      color: #333;
      text-decoration: none;
      border-radius: 4px;
      font-size: 14px;
    }
    
    .container {
      display: flex;
      gap: 40px;
      padding: 30px;
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .editor-panel {
      flex: 1;
      max-width: 450px;
    }
    
    .preview-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    
    .card-section {
      background: white;
      padding: 24px;
      border-radius: 12px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #333;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .form-group { margin-bottom: 16px; }
    
    label { 
      display: block; 
      font-weight: 500; 
      margin-bottom: 6px;
      font-size: 13px;
      color: #555;
    }
    
    input, textarea, select {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: #2196F3;
    }
    
    textarea { 
      min-height: 120px; 
      resize: vertical;
      line-height: 1.5;
    }
    
    .char-count {
      text-align: right;
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    
    .font-controls {
      display: flex;
      gap: 12px;
    }
    
    .font-controls > div { flex: 1; }
    
    .btn {
      padding: 12px 24px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.2s;
    }
    
    .btn-print { 
      background: #4CAF50; 
      color: white;
      width: 100%;
      margin-top: 8px;
    }
    
    .btn-print:hover { background: #43A047; }
    
    .preview-label {
      font-size: 14px;
      font-weight: 600;
      color: #333;
      margin-bottom: 16px;
    }
    
    .card-preview-container {
      background: #888;
      padding: 20px;
      border-radius: 8px;
      display: flex;
      justify-content: center;
    }
    
    .card-preview {
      width: 302px; /* 4.2in at 72dpi scaled */
      height: 612px; /* 8.5in at 72dpi scaled */
      background: white;
      position: relative;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      font-family: Arial, sans-serif;
    }
    
    .card-top {
      position: absolute;
      top: 36px;
      left: 0;
      right: 0;
      text-align: center;
      padding: 0 20px;
    }
    
    .card-recipient {
      font-weight: bold;
      margin-bottom: 12px;
    }
    
    .card-address {
      font-weight: bold;
      line-height: 1.4;
    }
    
    .card-fold-line {
      position: absolute;
      top: 306px;
      left: 10px;
      right: 10px;
      border-top: 1px dashed #ccc;
    }
    
    .fold-label {
      position: absolute;
      top: 306px;
      right: 15px;
      transform: translateY(-50%);
      font-size: 9px;
      color: #999;
      background: white;
      padding: 0 4px;
    }
    
    .card-message-area {
      position: absolute;
      top: 345px;
      left: 0;
      right: 0;
      text-align: center;
      padding: 0 28px;
    }
    
    .card-message {
      font-weight: bold;
      line-height: 1.5;
      word-wrap: break-word;
    }
    
    .card-sender {
      margin-top: 14px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Edit Gift Card - ${order.name}</h1>
    <div class="header-actions">
      <a href="/dashboard">← Back to Dashboard</a>
    </div>
  </div>
  
  <form action="/dashboard/print-custom/${order.id}" method="POST" id="giftCardForm">
    <div class="container">
      <div class="editor-panel">
        <div class="card-section">
          <div class="section-title">📍 Recipient Information</div>
          <div class="form-group">
            <label>Recipient Name</label>
            <input type="text" name="recipientName" id="recipientName" value="${orderData.giftReceiver || orderData.recipient.name}" oninput="updatePreview()" />
          </div>
          <div class="form-group">
            <label>Address Line 1</label>
            <input type="text" name="address1" id="address1" value="${orderData.recipient.address1}" oninput="updatePreview()" />
          </div>
          <div class="form-group">
            <label>Address Line 2 (City, State ZIP)</label>
            <input type="text" name="address2" id="address2" value="${orderData.recipient.city}, ${orderData.recipient.province} ${orderData.recipient.zip}" oninput="updatePreview()" />
          </div>
        </div>
        
        <div class="card-section">
          <div class="section-title">💬 Gift Message</div>
          <div class="font-controls">
            <div>
              <label>Font Style</label>
              <select name="fontFamily" id="fontFamily" onchange="updatePreview()">
                <option value="Arial, sans-serif">Arial</option>
                <option value="Georgia, serif">Georgia</option>
                <option value="'Times New Roman', serif">Times New Roman</option>
                <option value="'Palatino Linotype', serif">Palatino</option>
                <option value="'Courier New', monospace">Courier</option>
              </select>
            </div>
            <div>
              <label>Font Size</label>
              <select name="fontSize" id="fontSize" onchange="updatePreview()">
                <option value="10pt">Small (10px)</option>
                <option value="12pt" selected>Medium (12px)</option>
                <option value="14pt">Large (14px)</option>
                <option value="16pt">X-Large (16px)</option>
              </select>
            </div>
          </div>
          <div class="form-group" style="margin-top: 16px;">
            <label>Message Body</label>
            <textarea name="giftMessage" id="giftMessage" oninput="updatePreview(); updateCharCount()">${orderData.giftMessage}</textarea>
            <div class="char-count"><span id="charCount">0</span>/250 characters</div>
          </div>
          <div class="form-group">
            <label>From (Sender)</label>
            <input type="text" name="giftSender" id="giftSender" value="${orderData.giftSender}" oninput="updatePreview()" />
          </div>
        </div>
        
        <input type="hidden" name="fontFamilyValue" id="fontFamilyValue" />
        <input type="hidden" name="fontSizeValue" id="fontSizeValue" />
        <button type="submit" class="btn btn-print">🖨️ Print Gift Card</button>
      </div>
      
      <div class="preview-panel">
        <div class="preview-label">Gift Card Preview</div>
        <div class="card-preview-container">
          <div class="card-preview">
            <div class="card-top">
              <div class="card-recipient" id="previewRecipient">${orderData.giftReceiver || orderData.recipient.name}</div>
              <div class="card-address" id="previewAddress">${orderData.recipient.address1}<br>${orderData.recipient.city}, ${orderData.recipient.province} ${orderData.recipient.zip}</div>
            </div>
            <div class="card-fold-line"></div>
            <div class="fold-label">← fold here</div>
            <div class="card-message-area">
              <div class="card-message" id="previewMessage">${orderData.giftMessage}</div>
              <div class="card-sender" id="previewSender">${orderData.giftSender}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </form>
  
  <script>
    function updatePreview() {
      document.getElementById('previewRecipient').textContent = document.getElementById('recipientName').value;
      document.getElementById('previewAddress').innerHTML = 
        document.getElementById('address1').value + '<br>' + document.getElementById('address2').value;
      document.getElementById('previewMessage').textContent = document.getElementById('giftMessage').value;
      document.getElementById('previewSender').textContent = document.getElementById('giftSender').value;
      
      const fontFamily = document.getElementById('fontFamily').value;
      const fontSize = document.getElementById('fontSize').value;
      
      document.getElementById('previewMessage').style.fontFamily = fontFamily;
      document.getElementById('previewMessage').style.fontSize = fontSize;
      document.getElementById('previewSender').style.fontFamily = fontFamily;
      document.getElementById('previewSender').style.fontSize = fontSize;
      
      document.getElementById('fontFamilyValue').value = fontFamily;
      document.getElementById('fontSizeValue').value = fontSize;
    }
    
    function updateCharCount() {
      const count = document.getElementById('giftMessage').value.length;
      document.getElementById('charCount').textContent = count;
    }
    
    // Initialize
    updatePreview();
    updateCharCount();
  </script>
</body>
</html>`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Print custom/edited gift card
app.post('/dashboard/print-custom/:orderId', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { recipientName, address1, address2, giftMessage, giftSender, fontFamilyValue, fontSizeValue } = req.body;
    
    const customData = {
      giftReceiver: recipientName,
      giftMessage: giftMessage,
      giftSender: giftSender,
      fontFamily: fontFamilyValue || 'Arial, sans-serif',
      fontSize: fontSizeValue || '12pt',
      recipient: {
        name: recipientName,
        address1: address1,
        address2: '',
        city: '',
        province: '',
        zip: ''
      }
    };
    
    // Parse address2 back into components if possible
    const cityMatch = address2.match(/^(.+),\s*([A-Z]{2})\s*(\d{5}(-\d{4})?)$/);
    if (cityMatch) {
      customData.recipient.city = cityMatch[1];
      customData.recipient.province = cityMatch[2];
      customData.recipient.zip = cityMatch[3];
    } else {
      // Just use as-is
      customData.recipient.city = address2;
    }
    
    const giftCardHTML = generateGiftCardHTML(customData);
    const giftCardPdf = await giftCardToPdfBase64(giftCardHTML);
    
    if (CONFIG.printNode.giftCardPrinterId) {
      await sendToPrintNode(
        giftCardPdf,
        CONFIG.printNode.giftCardPrinterId,
        `Gift Card - ${recipientName}`
      );
      res.send(`<!DOCTYPE html>
<html>
<head><title>Print Sent</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1>✅ Gift Card Sent to Printer</h1>
  <p>Recipient: ${recipientName}</p>
  <a href="/dashboard" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px;">Back to Dashboard</a>
</body>
</html>`);
    } else {
      res.status(500).send('Gift card printer not configured');
    }
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Reprint original gift card
app.get('/dashboard/reprint/:orderId', async (req, res) => {
  try {
    const response = await fetch(
      `https://${CONFIG.shopify.store}/admin/api/2024-01/orders/${req.params.orderId}.json`,
      {
        headers: { 'X-Shopify-Access-Token': CONFIG.shopify.token }
      }
    );

    const { order } = await response.json();
    const orderData = extractOrderData(order);
    
    if (!orderData.giftMessage) {
      return res.status(400).send('No gift message found for this order');
    }
    
    const giftCardHTML = generateGiftCardHTML(orderData);
    const giftCardPdf = await giftCardToPdfBase64(giftCardHTML);
    
    if (CONFIG.printNode.giftCardPrinterId) {
      await sendToPrintNode(
        giftCardPdf,
        CONFIG.printNode.giftCardPrinterId,
        `Gift Card ${orderData.orderNumber}`
      );
      res.send(`<!DOCTYPE html>
<html>
<head><title>Print Sent</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1>✅ Gift Card Sent to Printer</h1>
  <p>Order: ${order.name}</p>
  <a href="/dashboard" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px;">Back to Dashboard</a>
</body>
</html>`);
    } else {
      res.status(500).send('Gift card printer not configured');
    }
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Sweet Tooth Order Printer</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    h1 { margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      background: #4CAF50;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 500;
      margin-right: 10px;
      margin-bottom: 10px;
    }
    .btn-secondary { background: #2196F3; }
    .status { margin-top: 30px; padding: 15px; background: #f5f5f5; border-radius: 6px; }
    .status h3 { margin-bottom: 10px; }
    .status p { margin: 5px 0; font-size: 14px; }
  </style>
</head>
<body>
  <h1>🍫 Sweet Tooth Order Printer</h1>
  <p class="subtitle">Automatic invoice and gift card printing</p>
  
  <a href="/dashboard" class="btn">Gift Card Dashboard</a>
  <a href="/print-recent/1" class="btn btn-secondary">Test Print Latest Order</a>
  
  <div class="status">
    <h3>Status</h3>
    <p>Invoice Printer: ${CONFIG.printNode.invoicePrinterId ? '✅ Configured' : '❌ Not configured'}</p>
    <p>Gift Card Printer: ${CONFIG.printNode.giftCardPrinterId ? '✅ Configured' : '❌ Not configured'}</p>
    <p>Shopify: ${CONFIG.shopify.store || '❌ Not configured'}</p>
  </div>
</body>
</html>`);
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log(`\n🍫 Sweet Tooth Order Printer`);
  console.log(`   Server running on port ${PORT}`);
  console.log(`   Shopify store: ${CONFIG.shopify.store}`);
  console.log(`   Invoice printer: ${CONFIG.printNode.invoicePrinterId || 'NOT SET'}`);
  console.log(`\n📋 Endpoints:`);
  console.log(`   POST /webhook/orders/create`);
  console.log(`   POST /webhook/orders/paid`);
  console.log(`   GET  /print/:orderId`);
  console.log(`   GET  /print-recent/:count`);
  console.log(`   GET  /health`);
  console.log('');
});
