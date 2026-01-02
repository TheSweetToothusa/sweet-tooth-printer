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

  // Check if this is a POS (in-store) order
  var isPOS = order.source_name === 'pos' || order.source_name === 'shopify_pos';

  // Determine delivery type from shipping line
  var shippingTitle = '';
  var deliveryFee = '0.00';
  if (order.shipping_lines && order.shipping_lines[0]) {
    if (order.shipping_lines[0].title) {
      shippingTitle = order.shipping_lines[0].title;
    }
    if (order.shipping_lines[0].price) {
      deliveryFee = parseFloat(order.shipping_lines[0].price).toFixed(2);
    }
  }
  var shippingTitleLower = shippingTitle.toLowerCase();
  var deliveryType = 'shipping';
  
  // POS orders are in-store
  if (isPOS) {
    deliveryType = 'in-store';
  } else if (shippingTitleLower.indexOf('local') > -1 || shippingTitleLower.indexOf('delivery') > -1) {
    deliveryType = 'local-delivery';
  } else if (shippingTitleLower.indexOf('pickup') > -1 || shippingTitleLower.indexOf('pick up') > -1) {
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
  var billing = order.billing_address || {};
  var customer = order.customer || {};
  
  // For POS orders, use billing or customer info since there's no shipping
  var addressSource = isPOS ? (billing.address1 ? billing : {}) : shipping;
  
  var firstName = addressSource.first_name || customer.first_name || '';
  var lastName = addressSource.last_name || customer.last_name || '';
  var recipient = {
    name: addressSource.name || customer.first_name && customer.last_name ? (customer.first_name + ' ' + customer.last_name) : (firstName + ' ' + lastName).trim(),
    phone: addressSource.phone || customer.phone || '',
    address1: addressSource.address1 || '',
    address2: addressSource.address2 || '',
    city: addressSource.city || '',
    province: addressSource.province || '',
    zip: addressSource.zip || '',
    country: addressSource.country || ''
  };

  // Extract gift giver info
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
    
    // CRITICAL: Extract variant_title for dietary designation (Dairy, Vegan/Parve, etc.)
    items.push({
      title: itemTitle,
      variant: item.variant_title || '',
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
  
  // 2. Note attributes - Special Instructions (check multiple variations)
  if (notes['Special Instructions'] && notes['Special Instructions'].trim()) {
    allInstructions.push(notes['Special Instructions'].trim());
  }
  if (notes['special instructions'] && notes['special instructions'].trim()) {
    allInstructions.push(notes['special instructions'].trim());
  }
  
  // 3. Delivery instructions
  if (notes['Delivery instructions'] && notes['Delivery instructions'].trim()) {
    allInstructions.push('Delivery: ' + notes['Delivery instructions'].trim());
  }
  
  // 4. Line item properties (already collected above)
  for (var m = 0; m < lineItemInstructions.length; m++) {
    // Avoid duplicates
    var inst = lineItemInstructions[m];
    var isDuplicate = false;
    for (var n = 0; n < allInstructions.length; n++) {
      if (allInstructions[n].indexOf(inst) > -1) {
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

  // Format delivery date with day of week and abbreviated month
  var deliveryDateRaw = notes['Delivery Date'] || '';
  var deliveryDayOfWeek = notes['Delivery Day'] || '';
  var deliveryDateFormatted = 'TBD';
  
  if (deliveryDateRaw) {
    try {
      var dateObj = new Date(deliveryDateRaw);
      if (!isNaN(dateObj.getTime())) {
        if (!deliveryDayOfWeek) {
          deliveryDayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
        }
        var month = dateObj.toLocaleDateString('en-US', { month: 'short' });
        var day = dateObj.getDate();
        var year = dateObj.getFullYear();
        deliveryDateFormatted = month + ' ' + day + ', ' + year;
      } else {
        deliveryDateFormatted = deliveryDateRaw;
      }
    } catch (e) {
      deliveryDateFormatted = deliveryDateRaw;
    }
  }

  // Extract totals
  var subtotal = order.subtotal_price || '0.00';
  var totalTax = order.total_tax || '0.00';
  var totalPrice = order.total_price || '0.00';

  // Get gift message and receiver info
  var giftMessage = notes['Gift Message'] || '';
  var giftSender = notes['Gift Sender'] || giver.name;
  var giftReceiver = notes['Gift Receiver'] || recipient.name;
  var shippingMethod = shippingTitle;

  return {
    orderNumber: order.name || ('#' + order.order_number),
    orderDate: orderDate,
    deliveryType: deliveryType,
    deliveryDate: deliveryDateFormatted,
    deliveryDayOfWeek: deliveryDayOfWeek,
    deliveryFee: deliveryFee,
    recipient: recipient,
    giver: giver,
    items: items,
    specialInstructions: specialInstructions,
    giftMessage: giftMessage,
    giftSender: giftSender,
    giftReceiver: giftReceiver,
    shippingMethod: shippingMethod,
    subtotal: subtotal,
    totalTax: totalTax,
    totalPrice: totalPrice,
    isPOS: isPOS
  };
}

// =============================================================================
// INVOICE HTML GENERATION
// =============================================================================

function generateInvoiceHTML(data) {
  var orderNumber = data.orderNumber;
  var deliveryType = data.deliveryType;
  var deliveryDate = data.deliveryDate;
  var deliveryDayOfWeek = data.deliveryDayOfWeek;
  var deliveryFee = data.deliveryFee;
  var recipient = data.recipient;
  var giver = data.giver;
  var items = data.items;
  var specialInstructions = data.specialInstructions;
  var giftMessage = data.giftMessage;
  var giftSender = data.giftSender;
  var shippingMethod = data.shippingMethod;
  var subtotal = data.subtotal;
  var totalTax = data.totalTax;
  var totalPrice = data.totalPrice;
  var isPOS = data.isPOS;

  // Determine badge text, layout, and labels based on delivery type
  var badgeText = 'SHIPPING';
  var cityDisplay = '';
  var recipientLabel = 'Recipient — Ship To';
  var topRightLabel = 'Shipping To';
  var showTopRight = true;
  var showDeliveryDate = true;
  var gridClass = 'info-grid';

  if (deliveryType === 'in-store') {
    badgeText = 'IN STORE';
    cityDisplay = '';
    recipientLabel = 'Customer';
    topRightLabel = '';
    showTopRight = false;
    showDeliveryDate = false;
  } else if (deliveryType === 'local-delivery') {
    badgeText = 'LOCAL DELIVERY';
    cityDisplay = recipient.city.toUpperCase();
    recipientLabel = 'Recipient — Deliver To';
    topRightLabel = 'Delivering To';
  } else if (deliveryType === 'pickup') {
    badgeText = 'PICKUP';
    cityDisplay = '';
    recipientLabel = 'Customer Picking Up';
    topRightLabel = '';
    showTopRight = false;
  }

  // Format recipient address
  var addressParts = [];
  if (recipient.address1) addressParts.push(recipient.address1);
  if (recipient.address2) addressParts.push(recipient.address2);
  if (recipient.city || recipient.province || recipient.zip) {
    addressParts.push(recipient.city + ', ' + recipient.province + ' ' + recipient.zip);
  }
  var addressLines = addressParts.join('<br>');

  // Generate items rows - WITH VARIANT/DIETARY DESIGNATION
  var itemRows = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    // CRITICAL: Show variant (Dairy, Vegan/Parve) below item name
    var variantHTML = item.variant ? '<div class="item-variant">' + item.variant + '</div>' : '';
    itemRows += '<tr><td class="item-name">' + item.title + variantHTML + '</td><td>' + item.sku + '</td><td>' + item.quantity + '</td><td>$' + item.price + '</td></tr>';
  }

  // Top right section varies by type
  var topRightHTML = '';
  if (showTopRight) {
    if (deliveryType === 'local-delivery') {
      topRightHTML = '<div class="city-badge"><div class="city-label">' + topRightLabel + '</div><div class="city-name">' + cityDisplay + '</div></div>';
    } else if (deliveryType === 'shipping') {
      // Shipping - show city/state and shipping service
      var shippingServiceHTML = shippingMethod ? '<div class="shipping-service">' + shippingMethod + '</div>' : '';
      topRightHTML = '<div class="shipping-info"><div class="shipping-label">' + topRightLabel + '</div><div class="shipping-destination">' + recipient.city.toUpperCase() + '</div><div class="shipping-state">' + recipient.province + '</div>' + shippingServiceHTML + '</div>';
    }
  } else if (deliveryType === 'pickup') {
    topRightHTML = '<div class="pickup-info"><div class="pickup-label">Pickup Location</div><div class="pickup-location">The Sweet Tooth</div><div class="pickup-address">18435 NE 19th Ave<br>North Miami Beach, FL 33179</div></div>';
  }

  // Phone HTML
  var phoneHTML = recipient.phone ? '<div class="recipient-phone">☎ ' + recipient.phone + '</div>' : '';
  
  // Address HTML (hide for pickup and in-store)
  var addressHTML = (deliveryType !== 'pickup' && deliveryType !== 'in-store' && addressLines) ? '<div class="recipient-address">' + addressLines + '</div>' : '';
  
  // Giver details - hide for in-store
  var giverCardHTML = '';
  if (deliveryType !== 'in-store') {
    var giverEmailHTML = giver.email ? '<div class="giver-detail">' + giver.email + '</div>' : '';
    var giverPhoneHTML = giver.phone ? '<div class="giver-detail">' + giver.phone + '</div>' : '';
    giverCardHTML = '<div class="info-card"><div class="info-card-header">Gift From</div><div class="giver-name">' + giver.name + '</div>' + giverEmailHTML + giverPhoneHTML + '</div>';
  }

  // Special instructions - convert newlines to <br> for display
  var instructionsDisplay = specialInstructions ? specialInstructions.replace(/\n/g, '<br>') : '';
  var instructionsClass = specialInstructions ? '' : 'no-notes';
  var instructionsContent = specialInstructions ? instructionsDisplay : 'No special instructions';

  // Gift message section - hide for in-store (NOW WITH 💌 EMOJI)
  var giftMessageHTML = '';
  if (giftMessage && giftMessage.trim() && deliveryType !== 'in-store') {
    var formattedGiftMessage = giftMessage.replace(/\n/g, '<br>');
    giftMessageHTML = '<div class="gift-message-section"><div class="gift-message-header">💌 Gift Message</div><div class="gift-message-content">"' + formattedGiftMessage + '"</div><div class="gift-message-from">— ' + giftSender + '</div></div>';
  }

  // Totals section - show for POS orders AND local delivery orders
  var totalsHTML = '';
  if (isPOS || deliveryType === 'local-delivery') {
    totalsHTML = '<div class="totals-section">';
    totalsHTML += '<div class="totals-row"><span>Subtotal:</span><span>$' + parseFloat(subtotal).toFixed(2) + '</span></div>';
    totalsHTML += '<div class="totals-row"><span>Tax:</span><span>$' + parseFloat(totalTax).toFixed(2) + '</span></div>';
    if (deliveryType === 'local-delivery') {
      totalsHTML += '<div class="totals-row"><span>Delivery Fee:</span><span>$' + parseFloat(deliveryFee).toFixed(2) + '</span></div>';
    }
    totalsHTML += '<div class="totals-row totals-total"><span>Total:</span><span>$' + parseFloat(totalPrice).toFixed(2) + '</span></div>';
    totalsHTML += '</div>';
  }

  // Print timestamp - FORCE EST TIMEZONE
  var now = new Date();
  var printTimestamp = now.toLocaleString('en-US', { 
    timeZone: 'America/New_York',
    month: 'short', 
    day: 'numeric', 
    year: 'numeric', 
    hour: 'numeric', 
    minute: '2-digit', 
    hour12: true 
  });

  // Build delivery date display for header (day of week + date on same line as order #)
  var deliveryDateHeaderHTML = '';
  if (showDeliveryDate && deliveryDate && deliveryDate !== 'TBD') {
    var fullDeliveryDisplay = deliveryDayOfWeek ? deliveryDayOfWeek + ', ' + deliveryDate : deliveryDate;
    deliveryDateHeaderHTML = '<div class="delivery-date-inline">📅 ' + fullDeliveryDisplay + '</div>';
  }

  // Build the HTML
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
  html += '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">';
  html += '<style>';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { font-family: "Manrope", sans-serif; font-size: 12px; line-height: 1.4; background: #fff; color: #000; }';
  html += '.invoice-page { width: 4in; padding: 0.25in; }';
  html += '.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 2px solid #000; padding-bottom: 12px; }';
  html += '.header-left { flex-shrink: 0; }';
  html += '.header-center { flex-grow: 1; text-align: center; padding: 0 12px; }';
  html += '.delivery-badge { display: inline-block; background: #000; color: #fff; padding: 6px 14px; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; }';
  html += '.order-number-header { font-size: 20px; font-weight: 800; margin-bottom: 4px; }';
  html += '.delivery-date-inline { font-size: 12px; font-weight: 600; }';
  html += '.city-badge { text-align: right; }';
  html += '.city-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }';
  html += '.city-name { font-size: 16px; font-weight: 800; letter-spacing: 0.5px; }';
  html += '.shipping-info { text-align: right; }';
  html += '.shipping-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }';
  html += '.shipping-destination { font-size: 14px; font-weight: 800; }';
  html += '.shipping-state { font-size: 12px; font-weight: 600; }';
  html += '.shipping-service { font-size: 10px; font-weight: 500; margin-top: 4px; padding: 2px 6px; background: #f0f0f0; display: inline-block; }';
  html += '.pickup-info { text-align: right; }';
  html += '.pickup-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }';
  html += '.pickup-location { font-size: 14px; font-weight: 800; }';
  html += '.pickup-address { font-size: 10px; font-weight: 500; line-height: 1.3; }';
  html += '.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }';
  html += '.info-card { border: 2px solid #000; padding: 10px; }';
  html += '.recipient-card { border-width: 3px; }';
  html += '.info-card-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px; border-bottom: 1px solid #000; padding-bottom: 4px; }';
  html += '.recipient-name { font-size: 16px; font-weight: 800; margin-bottom: 4px; }';
  html += '.recipient-phone { font-size: 13px; font-weight: 600; margin-bottom: 4px; }';
  html += '.recipient-address { font-size: 11px; line-height: 1.4; }';
  html += '.giver-name { font-size: 14px; font-weight: 700; margin-bottom: 4px; }';
  html += '.giver-detail { font-size: 10px; color: #333; }';
  html += '.items-section { margin-bottom: 16px; }';
  html += '.items-header { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }';
  html += '.items-table { width: 100%; border-collapse: collapse; }';
  html += '.items-table th { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; text-align: left; padding: 6px 4px; border-bottom: 2px solid #000; }';
  html += '.items-table td { padding: 8px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }';
  html += '.items-table .item-name { font-size: 13px; font-weight: 800; }';
  // CRITICAL: Style for variant/dietary designation
  html += '.items-table .item-variant { font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 3px; background: #f0f0f0; padding: 2px 6px; display: inline-block; letter-spacing: 0.5px; }';
  html += '.items-table td:last-child { text-align: right; font-weight: 600; }';
  html += '.items-table tbody tr:last-child td { border-bottom: 2px solid #000; }';
  html += '.totals-section { margin-bottom: 20px; padding: 14px; border: 2px solid #000; max-width: 300px; margin-left: auto; }';
  html += '.totals-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }';
  html += '.totals-total { font-size: 16px; font-weight: 800; border-top: 1px solid #000; margin-top: 8px; padding-top: 8px; }';
  html += '.gift-message-section { border: 2px solid #000; padding: 14px; margin-bottom: 20px; background: #fafafa; }';
  html += '.gift-message-header { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }';
  html += '.gift-message-content { font-size: 13px; line-height: 1.6; font-style: italic; margin-bottom: 8px; }';
  html += '.gift-message-from { font-size: 12px; font-weight: 700; text-align: right; }';
  html += '.special-notes { border: 2px dashed #000; padding: 14px; margin-bottom: 20px; }';
  html += '.special-notes-header { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }';
  html += '.special-notes-content { font-size: 12px; line-height: 1.6; font-weight: 500; }';
  html += '.no-notes { font-style: italic; color: #666; }';
  html += '.footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #000; display: flex; justify-content: space-between; align-items: center; }';
  html += '.logo-area { font-size: 12px; font-weight: 700; letter-spacing: 0.5px; }';
  html += '.print-timestamp { font-size: 9px; }';
  html += '</style></head><body>';
  html += '<div class="invoice-page">';
  // HEADER: Badge on left, Order # + Delivery Date in center, City/Location on right
  html += '<div class="header"><div class="header-left"><div class="delivery-badge">' + badgeText + '</div></div><div class="header-center"><div class="order-number-header">' + orderNumber + '</div>' + deliveryDateHeaderHTML + '</div>' + topRightHTML + '</div>';
  html += '<div class="' + gridClass + '">';
  html += '<div class="info-card recipient-card"><div class="info-card-header">' + recipientLabel + '</div><div class="recipient-name">' + recipient.name + '</div>' + phoneHTML + addressHTML + '</div>';
  html += giverCardHTML;
  html += '</div>';
  html += '<div class="items-section"><div class="items-header">Order Items</div><table class="items-table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th></tr></thead><tbody>' + itemRows + '</tbody></table></div>';
  html += totalsHTML;
  // GIFT MESSAGE NOW COMES BEFORE SPECIAL INSTRUCTIONS
  html += giftMessageHTML;
  html += '<div class="special-notes"><div class="special-notes-header">⚠ Special Instructions</div><div class="special-notes-content ' + instructionsClass + '">' + instructionsContent + '</div></div>';
  html += '<div class="footer"><div class="logo-area">The Sweet Tooth Chocolate Factory</div><div class="print-timestamp">Printed: ' + printTimestamp + ' EST</div></div>';
  html += '</div></body></html>';

  return html;
}

module.exports = {
  extractOrderData: extractOrderData,
  generateInvoiceHTML: generateInvoiceHTML
};
