// =============================================================================
// ORDER DATA EXTRACTION
// =============================================================================

function extractOrderData(order) {
  // Get note attributes as key-value object
  var notes = {};
  var noteAttrs = order.note_attributes || [];
  for (var i = 0; i < noteAttrs.length; i++) {
    notes[noteAttrs[i].name] = noteAttrs[i].value;
  }

  // Determine delivery type from shipping line
  var shippingTitle = '';
  if (order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].title) {
    shippingTitle = order.shipping_lines[0].title.toLowerCase();
  }
  
  // Check if this is a POS (in-store) order FIRST
  var sourceName = (order.source_name || '').toLowerCase();
  var deliveryType = 'shipping';
  
  if (sourceName === 'pos' || sourceName === 'shopify_pos' || sourceName.indexOf('pos') > -1) {
    deliveryType = 'instore';
  } else if (shippingTitle.indexOf('local') > -1 || shippingTitle.indexOf('delivery') > -1) {
    deliveryType = 'local-delivery';
  } else if (shippingTitle.indexOf('pickup') > -1 || shippingTitle.indexOf('pick up') > -1) {
    deliveryType = 'pickup';
  }

  // Also check note_attributes for Delivery Method
  var deliveryMethod = (notes['Delivery Method'] || '').toLowerCase();
  if (deliveryMethod.indexOf('pickup') > -1 || deliveryMethod.indexOf('pick up') > -1) {
    deliveryType = 'pickup';
  } else if (deliveryMethod.indexOf('delivery') > -1) {
    deliveryType = 'local-delivery';
  }

  // Extract recipient info
  var shipping = order.shipping_address || {};
  var firstName = shipping.first_name || '';
  var lastName = shipping.last_name || '';
  var recipient = {
    name: shipping.name || (firstName + ' ' + lastName).trim(),
    phone: shipping.phone || (order.customer ? order.customer.phone : '') || '',
    address1: shipping.address1 || '',
    address2: shipping.address2 || '',
    city: shipping.city || '',
    province: shipping.province || '',
    zip: shipping.zip || '',
    country: shipping.country || ''
  };

  // Extract gift giver info
  var billing = order.billing_address || {};
  var customer = order.customer || {};
  var billingFirstName = billing.first_name || '';
  var billingLastName = billing.last_name || '';
  var giver = {
    name: notes['Gift Sender'] || billing.name || (billingFirstName + ' ' + billingLastName).trim(),
    email: customer.email || order.email || '',
    phone: billing.phone || customer.phone || ''
  };

  // Extract line items (NO TIP!) and collect special instructions from line item properties
  var items = [];
  var lineItemInstructions = [];
  var lineItems = order.line_items || [];
  
  for (var j = 0; j < lineItems.length; j++) {
    var item = lineItems[j];
    var itemTitle = item.title || '';
    
    // Skip tips
    if (itemTitle.toLowerCase().indexOf('tip') > -1) {
      continue;
    }
    
    items.push({
      title: itemTitle,
      sku: item.sku || '',
      quantity: item.quantity,
      price: parseFloat(item.price).toFixed(2)
    });
    
    // Check line item properties for special instructions
    var props = item.properties || [];
    for (var k = 0; k < props.length; k++) {
      var propName = (props[k].name || '').toLowerCase();
      var propValue = props[k].value || '';
      if (propName.indexOf('special') > -1 || propName.indexOf('instruction') > -1 || propName.indexOf('note') > -1) {
        if (propValue && propValue.trim()) {
          lineItemInstructions.push(propValue.trim());
        }
      }
    }
  }

  // Gather ALL special instructions from multiple sources
  var allInstructions = [];
  
  // 1. Order-level note (order.note)
  if (order.note && order.note.trim()) {
    allInstructions.push(order.note.trim());
  }
  
  // 2. Note attributes - Special Instructions
  if (notes['Special Instructions'] && notes['Special Instructions'].trim()) {
    allInstructions.push(notes['Special Instructions'].trim());
  }
  
  // 3. Note attributes - Delivery Instructions
  if (notes['Delivery Instructions'] && notes['Delivery Instructions'].trim()) {
    allInstructions.push(notes['Delivery Instructions'].trim());
  }
  
  // 4. Line item properties (already collected above)
  for (var m = 0; m < lineItemInstructions.length; m++) {
    // Avoid duplicates
    var inst = lineItemInstructions[m];
    var isDuplicate = false;
    for (var n = 0; n < allInstructions.length; n++) {
      if (allInstructions[n] === inst) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      allInstructions.push(inst);
    }
  }
  
  // Combine all instructions
  var specialInstructions = allInstructions.join('\n\n');

  // Format order date
  var orderDateObj = new Date(order.created_at);
  var orderDate = orderDateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  return {
    orderNumber: order.name || ('#' + order.order_number),
    orderDate: orderDate,
    deliveryType: deliveryType,
    deliveryDate: notes['Delivery Date'] || 'TBD',
    recipient: recipient,
    giver: giver,
    items: items,
    giftMessage: notes['Gift Message'] || '',
    giftReceiver: notes['Gift Receiver'] || recipient.name,
    giftSender: notes['Gift Sender'] || giver.name,
    specialInstructions: specialInstructions,
    shippingMethod: (order.shipping_lines && order.shipping_lines[0]) ? order.shipping_lines[0].title : ''
  };
}

// =============================================================================
// INVOICE HTML GENERATION
// =============================================================================

function generateInvoiceHTML(data) {
  var deliveryType = data.deliveryType;
  var recipient = data.recipient;
  var giver = data.giver;
  var items = data.items;
  var orderNumber = data.orderNumber;
  var deliveryDate = data.deliveryDate;
  var specialInstructions = data.specialInstructions;

  // Determine badge and city display based on delivery type
  var badgeText = 'SHIPPING';
  var cityDisplay = '';
  var dateLabel = 'Ship By Date';

  if (deliveryType === 'instore') {
    badgeText = 'IN STORE';
    cityDisplay = '';
    dateLabel = 'Order Date';
  } else if (deliveryType === 'local-delivery') {
    badgeText = 'LOCAL DELIVERY';
    cityDisplay = recipient.city.toUpperCase();
    dateLabel = 'Delivery Date';
  } else if (deliveryType === 'pickup') {
    badgeText = 'PICKUP';
    cityDisplay = '';
    dateLabel = 'Ready for Pickup';
  }

  // Format recipient address
  var addressParts = [];
  if (recipient.address1) addressParts.push(recipient.address1);
  if (recipient.address2) addressParts.push(recipient.address2);
  if (recipient.city || recipient.province || recipient.zip) {
    addressParts.push(recipient.city + ', ' + recipient.province + ' ' + recipient.zip);
  }
  var addressLines = addressParts.join('<br>');

  // Generate items rows
  var itemRows = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    itemRows += '<tr><td>' + item.title + '</td><td>' + item.sku + '</td><td>' + item.quantity + '</td><td>$' + item.price + '</td></tr>';
  }

  // Top right section varies by type
  var topRightHTML = '';
  if (deliveryType === 'instore') {
    topRightHTML = '<div class="pickup-info"><div class="pickup-label">In Store Purchase</div><div class="pickup-location">The Sweet Tooth</div><div class="pickup-address">18435 NE 19th Ave<br>North Miami Beach, FL 33179</div></div>';
  } else if (deliveryType === 'local-delivery') {
    topRightHTML = '<div class="city-badge"><div class="city-label">Delivering To</div><div class="city-name">' + cityDisplay + '</div></div>';
  } else if (deliveryType === 'pickup') {
    topRightHTML = '<div class="pickup-info"><div class="pickup-label">Pickup Location</div><div class="pickup-location">The Sweet Tooth</div><div class="pickup-address">18435 NE 19th Ave<br>North Miami Beach, FL 33179</div></div>';
  } else {
    topRightHTML = '<div class="shipping-info"><div class="shipping-label">Ship To</div><div class="shipping-destination">' + recipient.city.toUpperCase() + '</div><div class="shipping-state">' + recipient.province + '</div></div>';
  }

  // Recipient card label
  var recipientLabel = 'Recipient — Deliver To';
  if (deliveryType === 'pickup') {
    recipientLabel = 'Customer Picking Up';
  } else if (deliveryType === 'instore') {
    recipientLabel = 'Customer';
  }

  // Phone HTML
  var phoneHTML = recipient.phone ? '<div class="recipient-phone">☎ ' + recipient.phone + '</div>' : '';
  
  // Address HTML (hide for pickup and instore)
  var addressHTML = (deliveryType !== 'pickup' && deliveryType !== 'instore') ? '<div class="recipient-address">' + addressLines + '</div>' : '';
  
  // Giver details
  var giverEmailHTML = giver.email ? '<div class="giver-detail">' + giver.email + '</div>' : '';
  var giverPhoneHTML = giver.phone ? '<div class="giver-detail">' + giver.phone + '</div>' : '';

  // Special instructions - convert newlines to <br> for display
  var instructionsDisplay = specialInstructions ? specialInstructions.replace(/\n/g, '<br>') : '';
  var instructionsClass = specialInstructions ? '' : 'no-notes';
  var instructionsContent = specialInstructions ? instructionsDisplay : 'No special instructions';

  // Print timestamp
  var now = new Date();
  var printTimestamp = now.toLocaleString('en-US', { 
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true 
  });

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invoice ' + orderNumber + '</title>';
  html += '<style>';
  html += '@import url(\'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap\');';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { font-family: Manrope, -apple-system, sans-serif; font-size: 11px; line-height: 1.4; color: #000; background: white; }';
  html += '.invoice-page { width: 8.5in; min-height: 11in; padding: 0.5in; background: white; }';
  html += '.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #000; }';
  html += '.delivery-badge { display: inline-block; padding: 10px 20px; font-size: 20px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; border: 3px solid #000; }';
  html += '.city-badge, .pickup-info, .shipping-info { text-align: right; }';
  html += '.city-label, .pickup-label, .shipping-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 2px; }';
  html += '.city-name { font-size: 26px; font-weight: 800; text-transform: uppercase; }';
  html += '.pickup-location { font-size: 13px; font-weight: 700; }';
  html += '.pickup-address { font-size: 10px; margin-top: 4px; line-height: 1.4; }';
  html += '.shipping-destination { font-size: 18px; font-weight: 800; text-transform: uppercase; }';
  html += '.shipping-state { font-size: 11px; margin-top: 2px; }';
  html += '.order-bar { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; margin-bottom: 16px; border-bottom: 1px solid #000; }';
  html += '.order-number { font-size: 14px; font-weight: 700; }';
  html += '.order-number span { font-weight: 400; }';
  html += '.delivery-date { text-align: right; }';
  html += '.delivery-date-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }';
  html += '.delivery-date-value { font-size: 16px; font-weight: 800; }';
  html += '.content-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }';
  html += '.info-card { border: 1px solid #000; padding: 14px; }';
  html += '.info-card-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #000; }';
  html += '.recipient-card { border: 3px solid #000; }';
  html += '.recipient-name { font-size: 16px; font-weight: 800; margin-bottom: 8px; }';
  html += '.recipient-phone { display: inline-block; border: 2px solid #000; padding: 4px 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 10px; }';
  html += '.recipient-address { font-size: 12px; line-height: 1.5; }';
  html += '.giver-name { font-size: 14px; font-weight: 700; margin-bottom: 6px; }';
  html += '.giver-detail { font-size: 11px; margin-bottom: 3px; }';
  html += '.items-section { margin-bottom: 20px; }';
  html += '.items-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }';
  html += '.items-table { width: 100%; border-collapse: collapse; }';
  html += '.items-table th { text-align: left; padding: 8px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-top: 2px solid #000; border-bottom: 1px solid #000; }';
  html += '.items-table th:last-child { text-align: right; }';
  html += '.items-table td { padding: 8px 10px; border-bottom: 1px solid #ccc; font-size: 11px; }';
  html += '.items-table td:first-child { font-weight: 500; }';
  html += '.items-table td:last-child { text-align: right; font-weight: 600; }';
  html += '.items-table tbody tr:last-child td { border-bottom: 2px solid #000; }';
  html += '.special-notes { border: 2px dashed #000; padding: 14px; }';
  html += '.special-notes-header { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }';
  html += '.special-notes-content { font-size: 12px; line-height: 1.6; font-weight: 500; }';
  html += '.no-notes { font-style: italic; color: #666; }';
  html += '.footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #000; display: flex; justify-content: space-between; align-items: center; }';
  html += '.logo-area { font-size: 12px; font-weight: 700; letter-spacing: 0.5px; }';
  html += '.print-timestamp { font-size: 9px; }';
  html += '</style></head><body>';
  html += '<div class="invoice-page">';
  html += '<div class="header"><div class="delivery-badge">' + badgeText + '</div>' + topRightHTML + '</div>';
  html += '<div class="order-bar"><div class="order-number"><span>Order</span> ' + orderNumber + '</div><div class="delivery-date"><div class="delivery-date-label">' + dateLabel + '</div><div class="delivery-date-value">' + deliveryDate + '</div></div></div>';
  html += '<div class="content-grid">';
  html += '<div class="info-card recipient-card"><div class="info-card-header">' + recipientLabel + '</div><div class="recipient-name">' + recipient.name + '</div>' + phoneHTML + addressHTML + '</div>';
  html += '<div class="info-card"><div class="info-card-header">Gift From</div><div class="giver-name">' + giver.name + '</div>' + giverEmailHTML + giverPhoneHTML + '</div>';
  html += '</div>';
  html += '<div class="items-section"><div class="items-header">Order Items</div><table class="items-table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th></tr></thead><tbody>' + itemRows + '</tbody></table></div>';
  html += '<div class="special-notes"><div class="special-notes-header">⚠ Special Instructions</div><div class="special-notes-content ' + instructionsClass + '">' + instructionsContent + '</div></div>';
  html += '<div class="footer"><div class="logo-area">The Sweet Tooth Chocolate Factory</div><div class="print-timestamp">Printed: ' + printTimestamp + '</div></div>';
  html += '</div></body></html>';

  return html;
}

module.exports = {
  extractOrderData: extractOrderData,
  generateInvoiceHTML: generateInvoiceHTML
};
