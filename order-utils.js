// =============================================================================
// ORDER DATA EXTRACTION
// =============================================================================

function extractOrderData(order) {
  // Get note attributes as key-value object
  const notes = {};
  (order.note_attributes || []).forEach(attr => {
    notes[attr.name] = attr.value;
  });

  // Determine delivery type from shipping line
  const shippingTitle = order.shipping_lines?.[0]?.title?.toLowerCase() || '';
  let deliveryType = 'shipping';
  if (shippingTitle.includes('local') || shippingTitle.includes('delivery')) {
    deliveryType = 'local-delivery';
  } else if (shippingTitle.includes('pickup') || shippingTitle.includes('pick up')) {
    deliveryType = 'pickup';
  }

  // Also check note_attributes for Delivery Method
  const deliveryMethod = notes['Delivery Method']?.toLowerCase() || '';
  if (deliveryMethod.includes('pickup') || deliveryMethod.includes('pick up')) {
    deliveryType = 'pickup';
  } else if (deliveryMethod.includes('delivery')) {
    deliveryType = 'local-delivery';
  }

  // Extract recipient info
  const shipping = order.shipping_address || {};
  const recipient = {
    name: shipping.name || `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
    phone: shipping.phone || order.customer?.phone || '',
    address1: shipping.address1 || '',
    address2: shipping.address2 || '',
    city: shipping.city || '',
    province: shipping.province || '',
    zip: shipping.zip || '',
    country: shipping.country || ''
  };

  // Extract gift giver info
  const billing = order.billing_address || {};
  const customer = order.customer || {};
  const giver = {
    name: notes['Gift Sender'] || billing.name || `${billing.first_name || ''} ${billing.last_name || ''}`.trim(),
    email: customer.email || order.email || '',
    phone: billing.phone || customer.phone || ''
  };

  // Extract line items (NO TIP!)
  const items = (order.line_items || [])
    .filter(item => !item.title.toLowerCase().includes('tip'))
    .map(item => ({
      title: item.title,
      sku: item.sku || '',
      quantity: item.quantity,
      price: parseFloat(item.price).toFixed(2)
    }));

  return {
    orderNumber: order.name || `#${order.order_number}`,
    orderDate: new Date(order.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }),
    deliveryType,
    deliveryDate: notes['Delivery Date'] || 'TBD',
    recipient,
    giver,
    items,
    giftMessage: notes['Gift Message'] || '',
    giftReceiver: notes['Gift Receiver'] || recipient.name,
    giftSender: notes['Gift Sender'] || giver.name,
    specialInstructions: order.note || notes['Special Instructions'] || '',
    shippingMethod: order.shipping_lines?.[0]?.title || ''
  };
}

// =============================================================================
// INVOICE HTML GENERATION
// =============================================================================

function generateInvoiceHTML(data) {
  const { deliveryType, recipient, giver, items, orderNumber, deliveryDate, specialInstructions } = data;

  // Determine badge and city display based on delivery type
  let badgeText = 'SHIPPING';
  let cityDisplay = '';
  let dateLabel = 'Ship By Date';

  if (deliveryType === 'local-delivery') {
    badgeText = 'LOCAL DELIVERY';
    cityDisplay = recipient.city.toUpperCase();
    dateLabel = 'Delivery Date';
  } else if (deliveryType === 'pickup') {
    badgeText = 'PICKUP';
    cityDisplay = '';
    dateLabel = 'Ready for Pickup';
  }

  // Format recipient address
  const addressLines = [
    recipient.address1,
    recipient.address2,
    `${recipient.city}, ${recipient.province} ${recipient.zip}`
  ].filter(Boolean).join('<br>');

  // Generate items rows
  const itemRows = items.map(item => `
    <tr>
      <td>${item.title}</td>
      <td>${item.sku}</td>
      <td>${item.quantity}</td>
      <td>$${item.price}</td>
    </tr>
  `).join('');

  // Top right section varies by type
  let topRightHTML = '';
  if (deliveryType === 'local-delivery') {
    topRightHTML = `
      <div class="city-badge">
        <div class="city-label">Delivering To</div>
        <div class="city-name">${cityDisplay}</div>
      </div>
    `;
  } else if (deliveryType === 'pickup') {
    topRightHTML = `
      <div class="pickup-info">
        <div class="pickup-label">Pickup Location</div>
        <div class="pickup-location">The Sweet Tooth</div>
        <div class="pickup-address">18435 NE 19th Ave<br>North Miami Beach, FL 33179</div>
      </div>
    `;
  } else {
    topRightHTML = `
      <div class="shipping-info">
        <div class="shipping-label">Ship To</div>
        <div class="shipping-destination">${recipient.city.toUpperCase()}</div>
        <div class="shipping-state">${recipient.province}</div>
      </div>
    `;
  }

  // Recipient card label
  const recipientLabel = deliveryType === 'pickup' ? 'Customer Picking Up' : 'Recipient — Deliver To';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${orderNumber}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Manrope', -apple-system, sans-serif;
      font-size: 11px;
      line-height: 1.4;
      color: #000;
      background: white;
      font-variant-numeric: tabular-nums;
    }
    
    .invoice-page {
      width: 8.5in;
      min-height: 11in;
      padding: 0.5in;
      background: white;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 2px solid #000;
    }
    
    .delivery-badge {
      display: inline-block;
      padding: 10px 20px;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 1px;
      text-transform: uppercase;
      border: 3px solid #000;
    }
    
    .city-badge, .pickup-info, .shipping-info { text-align: right; }
    
    .city-label, .pickup-label, .shipping-label {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 2px;
    }
    
    .city-name {
      font-size: 26px;
      font-weight: 800;
      text-transform: uppercase;
    }
    
    .pickup-location {
      font-size: 13px;
      font-weight: 700;
    }
    
    .pickup-address {
      font-size: 10px;
      margin-top: 4px;
      line-height: 1.4;
    }
    
    .shipping-destination {
      font-size: 18px;
      font-weight: 800;
      text-transform: uppercase;
    }
    
    .shipping-state {
      font-size: 11px;
      margin-top: 2px;
    }
    
    .order-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      margin-bottom: 16px;
      border-bottom: 1px solid #000;
    }
    
    .order-number {
      font-size: 14px;
      font-weight: 700;
    }
    
    .order-number span { font-weight: 400; }
    
    .delivery-date { text-align: right; }
    
    .delivery-date-label {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .delivery-date-value {
      font-size: 16px;
      font-weight: 800;
    }
    
    .content-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 20px;
    }
    
    .info-card {
      border: 1px solid #000;
      padding: 14px;
    }
    
    .info-card-header {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid #000;
    }
    
    .recipient-card { border: 3px solid #000; }
    
    .recipient-name {
      font-size: 16px;
      font-weight: 800;
      margin-bottom: 8px;
    }
    
    .recipient-phone {
      display: inline-block;
      border: 2px solid #000;
      padding: 4px 10px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }
    
    .recipient-address {
      font-size: 12px;
      line-height: 1.5;
    }
    
    .giver-name {
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    
    .giver-detail {
      font-size: 11px;
      margin-bottom: 3px;
    }
    
    .giver-account {
      margin-top: 8px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .items-section { margin-bottom: 20px; }
    
    .items-header {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 8px;
    }
    
    .items-table {
      width: 100%;
      border-collapse: collapse;
    }
    
    .items-table th {
      text-align: left;
      padding: 8px 10px;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-top: 2px solid #000;
      border-bottom: 1px solid #000;
    }
    
    .items-table th:last-child { text-align: right; }
    
    .items-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #ccc;
      font-size: 11px;
    }
    
    .items-table td:first-child { font-weight: 500; }
    
    .items-table td:last-child {
      text-align: right;
      font-weight: 600;
    }
    
    .items-table tbody tr:last-child td {
      border-bottom: 2px solid #000;
    }
    
    .special-notes {
      border: 2px dashed #000;
      padding: 14px;
    }
    
    .special-notes-header {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 8px;
    }
    
    .special-notes-content {
      font-size: 12px;
      line-height: 1.6;
      font-weight: 500;
    }
    
    .no-notes {
      font-style: italic;
      color: #666;
    }
    
    .footer {
      margin-top: 24px;
      padding-top: 10px;
      border-top: 1px solid #000;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo-area {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    
    .print-timestamp { font-size: 9px; }
  </style>
</head>
<body>
  <div class="invoice-page">
    <div class="header">
      <div class="delivery-badge">${badgeText}</div>
      ${topRightHTML}
    </div>
    
    <div class="order-bar">
      <div class="order-number"><span>Order</span> ${orderNumber}</div>
      <div class="delivery-date">
        <div class="delivery-date-label">${dateLabel}</div>
        <div class="delivery-date-value">${deliveryDate}</div>
      </div>
    </div>
    
    <div class="content-grid">
      <div class="info-card recipient-card">
        <div class="info-card-header">${recipientLabel}</div>
        <div class="recipient-name">${recipient.name}</div>
        ${recipient.phone ? `<div class="recipient-phone">☎ ${recipient.phone}</div>` : ''}
        ${deliveryType !== 'pickup' ? `<div class="recipient-address">${addressLines}</div>` : ''}
      </div>
      
      <div class="info-card">
        <div class="info-card-header">Gift From</div>
        <div class="giver-name">${giver.name}</div>
        ${giver.email ? `<div class="giver-detail">${giver.email}</div>` : ''}
        ${giver.phone ? `<div class="giver-detail">${giver.phone}</div>` : ''}
      </div>
    </div>
    
    <div class="items-section">
      <div class="items-header">Order Items</div>
      <table class="items-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>SKU</th>
            <th>Qty</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>
    </div>
    
    <div class="special-notes">
      <div class="special-notes-header">⚠ Special Instructions</div>
      <div class="special-notes-content ${!specialInstructions ? 'no-notes' : ''}">
        ${specialInstructions || 'No special instructions'}
      </div>
    </div>
    
    <div class="footer">
      <div class="logo-area">The Sweet Tooth Chocolate Factory</div>
      <div class="print-timestamp">Printed: ${new Date().toLocaleString('en-US', { 
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true 
      })}</div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  extractOrderData,
  generateInvoiceHTML
};
