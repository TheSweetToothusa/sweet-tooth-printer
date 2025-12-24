require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const { extractOrderData, generateInvoiceHTML } = require('./order-utils');

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

async function htmlToPdfBase64(html) {
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  
  const pdfBuffer = await page.pdf({
    format: 'Letter',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  
  await browser.close();
  return pdfBuffer.toString('base64');
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

    const invoiceHTML = generateInvoiceHTML(orderData);
    
    console.log('   Generating PDF...');
    const pdfBase64 = await htmlToPdfBase64(invoiceHTML);
    
    if (CONFIG.printNode.invoicePrinterId) {
      console.log('   Sending to printer...');
      const result = await sendToPrintNode(
        pdfBase64, 
        CONFIG.printNode.invoicePrinterId,
        `Invoice ${orderData.orderNumber}`
      );
      console.log(`   ✅ Print job created: ${result}`);
    } else {
      console.log('   ⚠️ No printer ID configured - skipping print');
    }

    if (orderData.giftMessage) {
      console.log('   📝 Gift message found - gift card printing coming soon');
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

app.get('/', (req, res) => {
  res.json({ 
    app: 'Sweet Tooth Order Printer',
    status: 'running',
    endpoints: {
      health: '/health',
      printOrder: '/print/:orderId',
      printRecent: '/print-recent/:count'
    }
  });
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
