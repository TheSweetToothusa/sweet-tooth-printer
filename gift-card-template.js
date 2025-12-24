// =============================================================================
// GIFT CARD MESSAGE HTML GENERATION
// Based on Mike Card template from PrintNode
// Size: 4.2" x 8.5" - folds in half horizontally
// =============================================================================

function generateGiftCardHTML(data) {
  const { giftReceiver, giftMessage, giftSender, recipient, fontFamily, fontSize } = data;

  // Use recipient name if no separate gift receiver specified
  const receiverName = giftReceiver || recipient.name;
  
  // Format address lines separately
  const addressLine1 = [recipient.address1, recipient.address2].filter(Boolean).join(', ');
  const addressLine2 = recipient.city ? `${recipient.city}, ${recipient.province} ${recipient.zip}` : '';

  // Default font settings
  const messageFontFamily = fontFamily || 'Arial, sans-serif';
  const messageFontSize = fontSize || '12pt';

  return `<!DOCTYPE html>
<html dir="ltr">
<head>
  <title>Gift Card - ${receiverName}</title>
  <meta charset="UTF-8">
  <style>
    @page {
      size: 4.2in 8.5in;
      margin: 0;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background: white;
    }
    
    .card {
      width: 4.2in;
      height: 8.5in;
      position: relative;
      background: white;
    }
    
    /* TOP SECTION - Recipient Name & Address */
    .top-section {
      position: absolute;
      top: 0.5in;
      left: 0;
      right: 0;
      text-align: center;
      padding: 0 0.3in;
    }
    
    .recipient-name {
      font-size: 14pt;
      font-weight: bold;
      margin-bottom: 16px;
      color: #000;
    }
    
    .recipient-address {
      font-size: 12pt;
      font-weight: bold;
      line-height: 1.4;
      color: #000;
    }
    
    /* MESSAGE SECTION - Centered in bottom half */
    /* Fold line is at 4.25in, message centered below */
    .message-section {
      position: absolute;
      top: 4.8in;
      left: 0;
      right: 0;
      text-align: center;
      padding: 0 0.4in;
    }
    
    .gift-message {
      font-family: ${messageFontFamily};
      font-size: ${messageFontSize};
      font-weight: bold;
      line-height: 1.5;
      color: #000;
    }
    
    .gift-sender {
      margin-top: 16px;
      font-family: ${messageFontFamily};
      font-size: ${messageFontSize};
      font-weight: bold;
      color: #000;
    }
  </style>
</head>
<body>
  <div class="card">
    <!-- TOP: Recipient Name & Address -->
    <div class="top-section">
      <div class="recipient-name">${receiverName}</div>
      <div class="recipient-address">
        ${addressLine1}${addressLine2 ? '<br>' + addressLine2 : ''}
      </div>
    </div>
    
    <!-- BOTTOM: Gift Message (centered in bottom half) -->
    <div class="message-section">
      <div class="gift-message">${giftMessage.replace(/\n/g, '<br>')}</div>
      ${giftSender ? \`<div class="gift-sender">${giftSender}</div>\` : ''}
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  generateGiftCardHTML
};
