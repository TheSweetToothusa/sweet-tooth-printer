// =============================================================================
// GIFT CARD MESSAGE HTML GENERATION
// Based on Mike Card template from PrintNode
// Size: 4.2" x 8.5" - folds in half horizontally
// =============================================================================

function generateGiftCardHTML(data) {
  const { giftReceiver, giftMessage, giftSender, recipient } = data;

  var receiverName = giftReceiver || recipient.name;
  var addressLine1 = [recipient.address1, recipient.address2].filter(Boolean).join(', ');
  var addressLine2 = recipient.city ? (recipient.city + ', ' + recipient.province + ' ' + recipient.zip) : '';
  var senderDiv = giftSender ? '<div class="gift-sender">' + giftSender + '</div>' : '';
  var formattedMessage = (giftMessage || '').replace(/\n/g, '<br>');

  var html = '<!DOCTYPE html><html dir="ltr"><head>';
  html += '<title>Gift Card</title><meta charset="UTF-8">';
  html += '<style>';
  html += '@page { size: 4.2in 8.5in; margin: 0; }';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { margin: 0; padding: 0; font-family: Arial, sans-serif; background: white; }';
  html += '.card { width: 4.2in; height: 8.5in; position: relative; background: white; }';
  html += '.top-section { position: absolute; top: 0.5in; left: 0; right: 0; text-align: center; padding: 0 0.3in; }';
  html += '.recipient-name { font-size: 14pt; font-weight: bold; margin-bottom: 16px; color: #000; }';
  html += '.recipient-address { font-size: 12pt; font-weight: bold; line-height: 1.4; color: #000; }';
  html += '.message-section { position: absolute; top: 4.8in; left: 0; right: 0; text-align: center; padding: 0 0.4in; }';
  html += '.gift-message { font-size: 12pt; font-weight: bold; line-height: 1.5; color: #000; }';
  html += '.gift-sender { margin-top: 16px; font-size: 12pt; font-weight: bold; color: #000; }';
  html += '</style></head><body>';
  html += '<div class="card">';
  html += '<div class="top-section">';
  html += '<div class="recipient-name">' + receiverName + '</div>';
  html += '<div class="recipient-address">' + addressLine1 + (addressLine2 ? '<br>' + addressLine2 : '') + '</div>';
  html += '</div>';
  html += '<div class="message-section">';
  html += '<div class="gift-message">' + formattedMessage + '</div>';
  html += senderDiv;
  html += '</div>';
  html += '</div>';
  html += '</body></html>';

  return html;
}

module.exports = { generateGiftCardHTML };
