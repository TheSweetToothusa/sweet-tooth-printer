require('dotenv').config();
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  shopify: {
    token: process.env.SHOPIFY_API_TOKEN,
    store: process.env.SHOPIFY_STORE_URL
  },
  printNode: {
    apiKey: process.env.PRINTNODE_API_KEY,
    invoicePrinterId: process.env.PRINTNODE_INVOICE_PRINTER_ID
  }
};

// Import the order processing functions from main file
const { extractOrderData, generateInvoiceHTML } = require('./order-utils');

async function testWithRealOrder() {
  console.log('🧪 Testing with most recent order...\n');

  // Fetch most recent order
  const response = await fetch(
    `https://${CONFIG.shopify.store}/admin/api/2024-01/orders.json?limit=1&status=any`,
    {
      headers: {
        'X-Shopify-Access-Token': CONFIG.shopify.token
      }
    }
  );

  const { orders } = await response.json();
  
  if (!orders || orders.length === 0) {
    console.log('❌ No orders found');
    return;
  }

  const order = orders[0];
  console.log(`📦 Order: ${order.name}`);
  console.log(`   Customer: ${order.customer?.first_name} ${order.customer?.last_name}`);
  console.log(`   Created: ${order.created_at}\n`);

  // Extract data
  const orderData = extractOrderData(order);
  console.log('📋 Extracted Data:');
  console.log(`   Delivery Type: ${orderData.deliveryType}`);
  console.log(`   Delivery Date: ${orderData.deliveryDate}`);
  console.log(`   Recipient: ${orderData.recipient.name}`);
  console.log(`   Phone: ${orderData.recipient.phone}`);
  console.log(`   City: ${orderData.recipient.city}`);
  console.log(`   Gift From: ${orderData.giver.name}`);
  console.log(`   Items: ${orderData.items.length}`);
  if (orderData.giftMessage) {
    console.log(`   Gift Message: "${orderData.giftMessage.substring(0, 50)}..."`);
  }
  console.log('');

  // Generate HTML
  const html = generateInvoiceHTML(orderData);

  // Save HTML for inspection
  const htmlPath = path.join(__dirname, 'test-invoice.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`💾 Saved HTML: ${htmlPath}`);

  // Generate PDF
  console.log('📄 Generating PDF...');
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  
  const pdfPath = path.join(__dirname, 'test-invoice.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  
  await browser.close();
  console.log(`💾 Saved PDF: ${pdfPath}`);

  // Option to actually print
  if (CONFIG.printNode.invoicePrinterId && process.argv.includes('--print')) {
    console.log('\n🖨️  Sending to PrintNode...');
    
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfBase64 = pdfBuffer.toString('base64');

    const printResponse = await fetch('https://api.printnode.com/printjobs', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CONFIG.printNode.apiKey + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        printerId: parseInt(CONFIG.printNode.invoicePrinterId),
        title: `Test Invoice ${orderData.orderNumber}`,
        contentType: 'pdf_base64',
        content: pdfBase64,
        source: 'Sweet Tooth Test'
      })
    });

    if (printResponse.ok) {
      const result = await printResponse.json();
      console.log(`✅ Print job created: ${result}`);
    } else {
      const error = await printResponse.text();
      console.log(`❌ Print failed: ${error}`);
    }
  } else if (!CONFIG.printNode.invoicePrinterId) {
    console.log('\n⚠️  No printer configured. Add PRINTNODE_INVOICE_PRINTER_ID to .env');
  } else {
    console.log('\n💡 Add --print flag to actually send to printer');
  }

  console.log('\n✅ Test complete!');
}

// Run
testWithRealOrder().catch(console.error);
