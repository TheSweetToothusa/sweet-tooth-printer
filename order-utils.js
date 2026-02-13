// =============================================================================
// GIFT FIELD NORMALIZATION — handles old/new/alternate field name formats
// =============================================================================

function normalizeGiftFields(notes) {
  var ci = {};
  var keys = Object.keys(notes);
  for (var i = 0; i < keys.length; i++) {
    var normalized = keys[i].toLowerCase().replace(/[\s_\-]+/g, '');
    if (!ci[normalized]) ci[normalized] = notes[keys[i]];
  }

  if (!notes['Gift Message'] || !notes['Gift Message'].trim()) {
    notes['Gift Message'] = ci['giftmessage'] || ci['giftmessagetext'] || '';
  }

  if (!notes['Gift Sender'] || !notes['Gift Sender'].trim()) {
    notes['Gift Sender'] = ci['giftsender'] || ci['giftmessagefrom'] || ci['giftfrom'] || '';
  }

  if (!notes['Gift Receiver'] || !notes['Gift Receiver'].trim()) {
    notes['Gift Receiver'] = ci['giftreceiver'] || ci['giftmessageto'] || ci['giftto'] || '';
  }

  if (!notes['Gift Wrap'] || !notes['Gift Wrap'].trim()) {
    var wrapVal = ci['giftwrap'] || ci['giftmessageisgift'] || ci['isgift'] || '';
    if (wrapVal === 'true' || wrapVal === '1' || wrapVal === 'yes' || wrapVal === 'Yes') {
      wrapVal = 'true';
    }
    notes['Gift Wrap'] = wrapVal;
  }
}

// =============================================================================
// ORDER DATA EXTRACTION
// =============================================================================

function extractOrderData(order) {
  var notes = {};
  var noteAttrs = order.note_attributes || [];
  for (var i = 0; i < noteAttrs.length; i++) {
    notes[noteAttrs[i].name] = noteAttrs[i].value;
  }

  var cartAttrs = order.cart_attributes || [];
  for (var ca = 0; ca < cartAttrs.length; ca++) {
    if (cartAttrs[ca].name && !notes[cartAttrs[ca].name]) {
      notes[cartAttrs[ca].name] = cartAttrs[ca].value;
    }
  }

  var allLineItems = order.line_items || [];
  for (var li = 0; li < allLineItems.length; li++) {
    var liProps = allLineItems[li].properties || [];
    for (var lp = 0; lp < liProps.length; lp++) {
      var lpName = (liProps[lp].name || '').toLowerCase();
      if (lpName.indexOf('gift') > -1) {
        if (!notes[liProps[lp].name]) {
          notes[liProps[lp].name] = liProps[lp].value;
        }
      }
    }
  }

  normalizeGiftFields(notes);

  var isPOS = order.source_name === 'pos' || order.source_name === 'shopify_pos';

  var shippingTitle = '';
  var shippingPrice = '0.00';
  if (order.shipping_lines && order.shipping_lines[0]) {
    if (order.shipping_lines[0].title) {
      shippingTitle = order.shipping_lines[0].title;
    }
    if (order.shipping_lines[0].price) {
      shippingPrice = order.shipping_lines[0].price;
    }
  }
  var shippingTitleLower = shippingTitle.toLowerCase();
  var deliveryType = 'shipping';
  
  if (isPOS) {
    deliveryType = 'in-store';
  } else if (shippingTitleLower.indexOf('local') > -1 || shippingTitleLower.indexOf('delivery') > -1) {
    deliveryType = 'local-delivery';
  } else if (shippingTitleLower.indexOf('pickup') > -1 || shippingTitleLower.indexOf('pick up') > -1) {
    deliveryType = 'pickup';
  }

  var deliveryMethod = (notes['Delivery Method'] || '').toLowerCase();
  if (deliveryMethod.indexOf('pickup') > -1 || deliveryMethod.indexOf('pick up') > -1) {
    deliveryType = 'pickup';
  } else if (deliveryMethod.indexOf('delivery') > -1) {
    deliveryType = 'local-delivery';
  }

  var shipping = order.shipping_address || {};
  var billing = order.billing_address || {};
  var customer = order.customer || {};
  
  var addressSource = isPOS ? (billing.address1 ? billing : {}) : shipping;
  
  var firstName = addressSource.first_name || customer.first_name || '';
  var lastName = addressSource.last_name || customer.last_name || '';
  var recipient = {
    name: addressSource.name || (customer.first_name && customer.last_name ? (customer.first_name + ' ' + customer.last_name) : (firstName + ' ' + lastName).trim()),
    phone: addressSource.phone || customer.phone || '',
    address1: addressSource.address1 || '',
    address2: addressSource.address2 || '',
    city: addressSource.city || '',
    province: addressSource.province || '',
    zip: addressSource.zip || '',
    country: addressSource.country || ''
  };

  var billingFirstName = billing.first_name || '';
  var billingLastName = billing.last_name || '';
  var giver = {
    name: notes['Gift Sender'] || billing.name || (billingFirstName + ' ' + billingLastName).trim(),
    email: customer.email || order.email || '',
    phone: billing.phone || customer.phone || ''
  };

  var items = [];
  var lineItemInstructions = [];
  var lineItems = order.line_items || [];
  var itemsSubtotal = 0;
  var occasion = '';
  var babyGender = '';
  
  for (var j = 0; j < lineItems.length; j++) {
    var item = lineItems[j];
    var itemTitle = item.title || '';
    
    if (itemTitle.toLowerCase().indexOf('tip') > -1) {
      continue;
    }
    
    var variantTitle = item.variant_title || '';
    
    var itemPrice = parseFloat(item.price) || 0;
    var itemQty = item.quantity || 1;
    itemsSubtotal += itemPrice * itemQty;
    
    items.push({
      title: itemTitle,
      variant: variantTitle,
      sku: item.sku || '',
      quantity: itemQty,
      price: itemPrice.toFixed(2)
    });
    
    var props = item.properties || [];
    for (var k = 0; k < props.length; k++) {
      var propName = (props[k].name || '');
      var propNameLower = propName.toLowerCase();
      var propValue = props[k].value || '';
      
      if (!occasion && propValue && propValue.trim()) {
        if (propNameLower === '_occasion' || propNameLower === 'occasion' || propNameLower === 'order occasion') {
          occasion = propValue.trim();
        }
      }
      
      if (!babyGender && propValue && propValue.trim()) {
        if (propNameLower === 'baby gender' || propNameLower === '_baby gender' || propNameLower === 'baby_gender') {
          babyGender = propValue.trim();
        }
      }
      
      if (propNameLower.indexOf('special') > -1 || propNameLower.indexOf('instruction') > -1 || propNameLower.indexOf('note') > -1) {
        if (propValue && propValue.trim()) {
          lineItemInstructions.push(propValue.trim());
        }
      }
    }
  }

  var allInstructions = [];
  
  if (order.note && order.note.trim()) {
    allInstructions.push(order.note.trim());
  }
  
  if (notes['Special Instructions'] && notes['Special Instructions'].trim()) {
    allInstructions.push(notes['Special Instructions'].trim());
  }
  if (notes['special instructions'] && notes['special instructions'].trim()) {
    allInstructions.push(notes['special instructions'].trim());
  }
  
  if (notes['Delivery Instructions'] && notes['Delivery Instructions'].trim()) {
    allInstructions.push('DELIVERY: ' + notes['Delivery Instructions'].trim());
  }
  if (notes['Delivery instructions'] && notes['Delivery instructions'].trim()) {
    allInstructions.push('DELIVERY: ' + notes['Delivery instructions'].trim());
  }
  if (notes['delivery instructions'] && notes['delivery instructions'].trim()) {
    allInstructions.push('DELIVERY: ' + notes['delivery instructions'].trim());
  }
  if (notes['DeliveryInstructions'] && notes['DeliveryInstructions'].trim()) {
    allInstructions.push('DELIVERY: ' + notes['DeliveryInstructions'].trim());
  }
  
  for (var key in notes) {
    if (notes.hasOwnProperty(key)) {
      var keyLower = key.toLowerCase();
      if (keyLower.indexOf('instruction') > -1 && notes[key] && notes[key].trim()) {
        var alreadyAdded = false;
        for (var x = 0; x < allInstructions.length; x++) {
          if (allInstructions[x].indexOf(notes[key].trim()) > -1) {
            alreadyAdded = true;
            break;
          }
        }
        if (!alreadyAdded) {
          allInstructions.push(notes[key].trim());
        }
      }
    }
  }
  
  for (var m = 0; m < lineItemInstructions.length; m++) {
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
  
  var specialInstructions = allInstructions.join('\n\n');

  var orderDateObj = new Date(order.created_at);
  var orderDate = orderDateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  var deliveryDateRaw = notes['Delivery Date'] || '';
  var deliveryDayOfWeek = notes['Delivery Day'] || '';
  var deliveryDateFormatted = 'TBD';
  
  if (deliveryDateRaw) {
    try {
      var dateObj = new Date(deliveryDateRaw);
      if (!isNaN(dateObj.getTime())) {
        if (!deliveryDayOfWeek) {
          deliveryDayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
        } else {
          deliveryDayOfWeek = deliveryDayOfWeek.toUpperCase();
        }
        var month = dateObj.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
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

  var subtotal = itemsSubtotal.toFixed(2);
  var totalTax = order.total_tax || '0.00';
  var deliveryFee = shippingPrice;

  if (!occasion) {
    occasion = notes['Occasion'] || notes['occasion'] || notes['Order Occasion'] || notes['_Occasion'] || '';
  }

  if (!babyGender) {
    babyGender = notes['Baby Gender'] || notes['baby gender'] || notes['_Baby Gender'] || notes['baby_gender'] || '';
  }

  return {
    orderNumber: order.name || ('#' + order.order_number),
    orderDate: orderDate,
    deliveryType: deliveryType,
    deliveryDayOfWeek: deliveryDayOfWeek,
    deliveryDate: deliveryDateFormatted,
    recipient: recipient,
    giver: giver,
    items: items,
    giftMessage: notes['Gift Message'] || '',
    giftReceiver: notes['Gift Receiver'] || recipient.name,
    giftSender: notes['Gift Sender'] || giver.name,
    specialInstructions: specialInstructions,
    shippingMethod: shippingTitle,
    isPOS: isPOS,
    subtotal: subtotal,
    totalTax: totalTax,
    deliveryFee: deliveryFee,
    occasion: occasion,
    babyGender: babyGender
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
  var deliveryDayOfWeek = data.deliveryDayOfWeek;
  var deliveryDate = data.deliveryDate;
  var specialInstructions = data.specialInstructions;
  var giftMessage = data.giftMessage;
  var giftSender = data.giftSender;
  var shippingMethod = data.shippingMethod;
  var isPOS = data.isPOS;
  var subtotal = data.subtotal;
  var totalTax = data.totalTax;
  var deliveryFee = data.deliveryFee;
  var occasion = data.occasion;
  var babyGender = data.babyGender;

  var badgeText = 'SHIPPING';
  var cityDisplay = '';
  var dateLabel = 'Ship Date';
  var recipientLabel = 'Recipient — Ship To';
  var topRightLabel = 'Shipping To';
  var showTopRight = true;
  var showDateBar = true;
  var deliveryFeeLabel = 'Shipping';

  if (deliveryType === 'in-store') {
    badgeText = 'IN STORE';
    cityDisplay = '';
    dateLabel = '';
    recipientLabel = 'Customer';
    topRightLabel = '';
    showTopRight = false;
    showDateBar = false;
    deliveryFeeLabel = '';
  } else if (deliveryType === 'local-delivery') {
    badgeText = 'LOCAL DELIVERY';
    cityDisplay = recipient.city.toUpperCase();
    dateLabel = 'Delivery Date';
    recipientLabel = 'Recipient — Deliver To';
    topRightLabel = 'Delivering To';
    deliveryFeeLabel = 'Delivery';
  } else if (deliveryType === 'pickup') {
    badgeText = 'PICKUP';
    cityDisplay = '';
    dateLabel = 'Ready for Pickup';
    recipientLabel = 'Customer Picking Up';
    topRightLabel = '';
    showTopRight = false;
    deliveryFeeLabel = '';
  }

  var addressParts = [];
  if (recipient.address1) addressParts.push(recipient.address1);
  if (recipient.address2) addressParts.push(recipient.address2);
  if (recipient.city || recipient.province || recipient.zip) {
    addressParts.push(recipient.city + ', ' + recipient.province + ' ' + recipient.zip);
  }
  var addressLines = addressParts.join('<br>');

  var itemRows = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var variantHTML = '';
    if (item.variant) {
      variantHTML = '<span class="variant-tag">' + item.variant + '</span>';
    }
    itemRows += '<tr><td class="item-name">' + item.title + ' ' + variantHTML + '</td><td>' + item.sku + '</td><td>' + item.quantity + '</td><td>$' + item.price + '</td></tr>';
  }

  var topRightHTML = '';
  if (showTopRight) {
    if (deliveryType === 'local-delivery') {
      topRightHTML = '<div class="city-badge"><div class="city-label">' + topRightLabel + '</div><div class="city-name">' + cityDisplay + '</div></div>';
    } else if (deliveryType === 'shipping') {
      var shippingServiceHTML = shippingMethod ? '<div class="shipping-service">' + shippingMethod + '</div>' : '';
      topRightHTML = '<div class="shipping-info"><div class="shipping-label">' + topRightLabel + '</div><div class="shipping-destination">' + recipient.city.toUpperCase() + '</div><div class="shipping-state">' + recipient.province + '</div>' + shippingServiceHTML + '</div>';
    }
  } else if (deliveryType === 'pickup') {
    topRightHTML = '<div class="pickup-info"><div class="pickup-label">Pickup Location</div><div class="pickup-location">The Sweet Tooth</div><div class="pickup-address">18435 NE 19th Ave<br>North Miami Beach, FL 33179</div></div>';
  }

  var phoneHTML = recipient.phone ? '<div class="recipient-phone">☎ ' + recipient.phone + '</div>' : '';
  
  var addressHTML = (deliveryType !== 'pickup' && deliveryType !== 'in-store' && addressLines) ? '<div class="recipient-address">' + addressLines + '</div>' : '';
  
  var giverCardHTML = '';
  if (deliveryType !== 'in-store') {
    var giverEmailHTML = giver.email ? '<div class="giver-detail">' + giver.email + '</div>' : '';
    var giverPhoneHTML = giver.phone ? '<div class="giver-detail">' + giver.phone + '</div>' : '';
    giverCardHTML = '<div class="info-card"><div class="info-card-header">Gift From</div><div class="giver-name">' + giver.name + '</div>' + giverEmailHTML + giverPhoneHTML + '</div>';
  }

  // Special instructions display is handled inline in the alert box below

  // FIXED: Gift message section — show "NO GIFT MESSAGE" when empty
  var giftMessageHTML = '';
  if (giftMessage && giftMessage.trim()) {
    var formattedGiftMessage = giftMessage.replace(/\n/g, '<br>');
    giftMessageHTML = '<div class="gift-message-section"><div class="gift-message-header">🎁 Gift Card Included</div><div class="gift-message-content">"' + formattedGiftMessage + '"</div><div class="gift-message-from">— ' + giftSender + '</div></div>';
  } else {
    // NO GIFT MESSAGE — big visible indicator so factory team knows
    giftMessageHTML = '<div class="no-gift-message-section"><div class="no-gift-message">NO GIFT MESSAGE</div></div>';
  }

  var occasionHTML = '';
  if (occasion && occasion.trim()) {
    occasionHTML = '<div class="occasion-section"><div class="occasion-label">Occasion</div><div class="occasion-value">' + occasion + '</div></div>';
  }

  var babyGenderHTML = '';
  if (babyGender && babyGender.trim()) {
    var genderUpper = babyGender.trim().toUpperCase();
    var genderBg = '#000';
    var genderColor = '#fff';
    var genderIcon = '👶';
    if (genderUpper === 'BOY') {
      genderBg = '#1565C0';
      genderColor = '#fff';
      genderIcon = '👶💙';
    } else if (genderUpper === 'GIRL') {
      genderBg = '#D81B60';
      genderColor = '#fff';
      genderIcon = '👶💗';
    }
    babyGenderHTML = '<div class="baby-gender-section" style="background:' + genderBg + ';color:' + genderColor + ';padding:12px 20px;margin-bottom:12px;display:inline-block;"><div class="baby-gender-label" style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:2px;">Baby Gender</div><div class="baby-gender-value" style="font-size:22px;font-weight:800;text-transform:uppercase;">' + genderIcon + ' ' + genderUpper + '</div></div>';
  }

  var totalsHTML = '<div class="totals-section">';
  totalsHTML += '<div class="totals-row"><span>Subtotal:</span><span>$' + parseFloat(subtotal).toFixed(2) + '</span></div>';
  if (deliveryFeeLabel && parseFloat(deliveryFee) > 0) {
    totalsHTML += '<div class="totals-row"><span>' + deliveryFeeLabel + ':</span><span>$' + parseFloat(deliveryFee).toFixed(2) + '</span></div>';
  }
  totalsHTML += '<div class="totals-row"><span>Tax:</span><span>$' + parseFloat(totalTax).toFixed(2) + '</span></div>';
  var total = parseFloat(subtotal) + parseFloat(deliveryFee) + parseFloat(totalTax);
  totalsHTML += '<div class="totals-row totals-total"><span>Total:</span><span>$' + total.toFixed(2) + '</span></div>';
  totalsHTML += '</div>';

  var now = new Date();
  var printTimestamp = now.toLocaleString('en-US', { 
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true 
  }) + ' EST';

  var dateBarHTML = '';
  if (showDateBar) {
    var dateDisplayHTML = '';
    if (deliveryDayOfWeek) {
      dateDisplayHTML = '<div class="delivery-day">' + deliveryDayOfWeek + '</div><div class="delivery-date-value">' + deliveryDate + '</div>';
    } else {
      dateDisplayHTML = '<div class="delivery-date-value">' + deliveryDate + '</div>';
    }
    dateBarHTML = '<div class="date-bar"><div class="delivery-date"><div class="delivery-date-label">' + dateLabel + '</div>' + dateDisplayHTML + '</div></div>';
  }

  var gridClass = deliveryType === 'in-store' ? 'content-grid-single' : 'content-grid';

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invoice ' + orderNumber + '</title>';
  html += '<style>';
  html += '@import url(\'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap\');';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { font-family: Manrope, -apple-system, sans-serif; font-size: 11px; line-height: 1.3; color: #000; background: white; }';
  html += '.invoice-page { width: 8.5in; min-height: 11in; padding: 0.35in 0.5in; background: white; }';
  html += '.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid #000; }';
  html += '.delivery-badge { display: inline-block; padding: 8px 16px; font-size: 18px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; border: 3px solid #000; }';
  html += '.order-number-header { font-size: 26px; font-weight: 800; text-align: center; }';
  html += '.city-badge, .pickup-info, .shipping-info { text-align: right; }';
  html += '.city-label, .pickup-label, .shipping-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 2px; }';
  html += '.city-name { font-size: 24px; font-weight: 800; text-transform: uppercase; }';
  html += '.pickup-location { font-size: 12px; font-weight: 700; }';
  html += '.pickup-address { font-size: 10px; margin-top: 3px; line-height: 1.3; }';
  html += '.shipping-destination { font-size: 16px; font-weight: 800; text-transform: uppercase; }';
  html += '.shipping-state { font-size: 11px; margin-top: 2px; }';
  html += '.shipping-service { font-size: 11px; font-weight: 700; margin-top: 4px; padding: 3px 6px; background: #000; color: #fff; display: inline-block; }';
  html += '.date-bar { display: flex; justify-content: flex-end; padding: 8px 0; margin-bottom: 10px; border-bottom: 1px solid #000; }';
  html += '.delivery-date { text-align: right; }';
  html += '.delivery-date-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }';
  html += '.delivery-day { font-size: 14px; font-weight: 800; margin-top: 2px; }';
  html += '.delivery-date-value { font-size: 13px; font-weight: 700; }';
  html += '.content-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }';
  html += '.content-grid-single { display: block; margin-bottom: 12px; }';
  html += '.content-grid-single .info-card { max-width: 50%; }';
  html += '.info-card { border: 1px solid #000; padding: 10px; }';
  html += '.info-card-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #000; }';
  html += '.recipient-card { border: 3px solid #000; }';
  html += '.recipient-name { font-size: 15px; font-weight: 800; margin-bottom: 6px; }';
  html += '.recipient-phone { display: inline-block; border: 2px solid #000; padding: 3px 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 6px; }';
  html += '.recipient-address { font-size: 11px; line-height: 1.4; }';
  html += '.giver-name { font-size: 13px; font-weight: 700; margin-bottom: 4px; }';
  html += '.giver-detail { font-size: 10px; margin-bottom: 2px; }';
  html += '.occasion-section { background: #000; color: #fff; padding: 10px 14px; margin-bottom: 12px; display: inline-block; }';
  html += '.occasion-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 2px; }';
  html += '.occasion-value { font-size: 18px; font-weight: 800; text-transform: uppercase; }';
  html += '.items-section { margin-bottom: 12px; }';
  html += '.items-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }';
  html += '.items-table { width: 100%; border-collapse: collapse; }';
  html += '.items-table th { text-align: left; padding: 6px 8px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-top: 2px solid #000; border-bottom: 1px solid #000; }';
  html += '.items-table th:last-child { text-align: right; }';
  html += '.items-table td { padding: 6px 8px; border-bottom: 1px solid #ccc; font-size: 11px; }';
  html += '.items-table td.item-name { font-size: 15px; font-weight: 800; }';
  html += '.items-table td:last-child { text-align: right; font-weight: 600; }';
  html += '.items-table tbody tr:last-child td { border-bottom: 2px solid #000; }';
  html += '.variant-tag { display: inline-block; background: #000; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 6px; margin-left: 6px; vertical-align: middle; text-transform: uppercase; }';
  html += '.totals-section { margin-bottom: 12px; padding: 10px; border: 2px solid #000; max-width: 280px; margin-left: auto; }';
  html += '.totals-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; }';
  html += '.totals-total { font-size: 14px; font-weight: 800; border-top: 1px solid #000; margin-top: 6px; padding-top: 6px; }';
  html += '.gift-message-section { border: 2px solid #000; padding: 10px; margin-bottom: 12px; background: #fafafa; }';
  html += '.gift-message-header { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px; }';
  html += '.gift-message-content { font-size: 12px; line-height: 1.5; font-style: italic; margin-bottom: 6px; }';
  html += '.gift-message-from { font-size: 11px; font-weight: 700; text-align: right; }';
  // FIXED: Style for "NO GIFT MESSAGE" indicator
  html += '.no-gift-message-section { border: 2px dashed #999; padding: 10px; margin-bottom: 12px; text-align: center; }';
  html += '.no-gift-message { font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; color: #666; }';
  html += '.special-instructions-alert { border: 4px solid #000; margin-bottom: 14px; }';
  html += '.special-instructions-alert .alert-header { background: #000; color: #fff; padding: 10px 16px; display: flex; align-items: center; justify-content: center; gap: 10px; }';
  html += '.special-instructions-alert .alert-header-text { font-size: 20px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; }';
  html += '.special-instructions-alert .warning-triangle { flex-shrink: 0; }';
  html += '.special-instructions-alert .alert-body { padding: 14px 16px; font-size: 15px; font-weight: 700; line-height: 1.5; }';
  html += '.footer { margin-top: 12px; padding-top: 8px; border-top: 1px solid #000; display: flex; justify-content: space-between; align-items: center; }';
  html += '.logo-area { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }';
  html += '.print-timestamp { font-size: 9px; }';
  html += '</style></head><body>';
  html += '<div class="invoice-page">';
  html += '<div class="header"><div class="delivery-badge">' + badgeText + '</div><div class="order-number-header">' + orderNumber + '</div>' + topRightHTML + '</div>';
  html += dateBarHTML;
  html += occasionHTML;
  html += babyGenderHTML;
  html += '<div class="' + gridClass + '">';
  html += '<div class="info-card recipient-card"><div class="info-card-header">' + recipientLabel + '</div><div class="recipient-name">' + recipient.name + '</div>' + phoneHTML + addressHTML + '</div>';
  html += giverCardHTML;
  html += '</div>';
  // Special Instructions — big alert box, only shows when instructions exist
  if (specialInstructions && specialInstructions.trim()) {
    var instructionsDisplay = specialInstructions.replace(/\n/g, '<br>');
    html += '<div class="special-instructions-alert"><div class="alert-header">';
    html += '<svg class="warning-triangle" width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M12 2L1 21h22L12 2z" fill="#fff" stroke="#fff" stroke-width="1"/><path d="M12 9v5" stroke="#000" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="#000"/></svg>';
    html += '<span class="alert-header-text">SPECIAL INSTRUCTIONS</span>';
    html += '<svg class="warning-triangle" width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M12 2L1 21h22L12 2z" fill="#fff" stroke="#fff" stroke-width="1"/><path d="M12 9v5" stroke="#000" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="#000"/></svg>';
    html += '</div><div class="alert-body">' + instructionsDisplay + '</div></div>';
  }
  html += '<div class="items-section"><div class="items-header">Order Items</div><table class="items-table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th></tr></thead><tbody>' + itemRows + '</tbody></table></div>';
  html += totalsHTML;
  html += giftMessageHTML;
  html += '<div class="footer"><div class="logo-area">The Sweet Tooth Chocolate Factory</div><div class="print-timestamp">Printed: ' + printTimestamp + '</div></div>';
  html += '</div></body></html>';

  return html;
}

module.exports = {
  extractOrderData: extractOrderData,
  generateInvoiceHTML: generateInvoiceHTML
};