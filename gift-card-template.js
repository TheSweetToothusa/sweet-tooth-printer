function generateGiftCardHTML(data) {
  var giftReceiver = data.giftReceiver;
  var giftMessage = data.giftMessage;
  var giftSender = data.giftSender;
  var recipient = data.recipient;
  var orderNumber = data.orderNumber || '';
  // Default positions
  var topPosition = data.topPosition || '0.15in';
  var messagePosition = data.messagePosition || '4.30in';
  var receiverName = giftReceiver || recipient.name;
  var addressLine1 = [recipient.address1, recipient.address2].filter(Boolean).join(', ');
  var addressLine2 = recipient.city ? (recipient.city + ', ' + recipient.province + ' ' + recipient.zip) : '';
  var senderDiv = giftSender ? '<div class="gift-sender">' + giftSender + '</div>' : '';

  // Enforce 300 character max on gift messages
  var truncatedMessage = (giftMessage || '');
  if (truncatedMessage.length > 300) {
    truncatedMessage = truncatedMessage.substring(0, 300);
  }
  var formattedMessage = truncatedMessage.replace(/\n/g, '<br>');

  // Dynamic font sizing based on message length so it always fits
  var msgLen = truncatedMessage.length;
  var messageFontSize = '10.2pt';
  var messageLineHeight = '1.5';
  if (msgLen > 250) {
    messageFontSize = '8pt';
    messageLineHeight = '1.3';
  } else if (msgLen > 200) {
    messageFontSize = '8.5pt';
    messageLineHeight = '1.35';
  } else if (msgLen > 150) {
    messageFontSize = '9pt';
    messageLineHeight = '1.4';
  } else if (msgLen > 100) {
    messageFontSize = '9.5pt';
    messageLineHeight = '1.45';
  }

  // Allow editor override of font size, family, weight, style
  if (data.messageFontSize) {
    messageFontSize = data.messageFontSize;
  }
  if (data.messageLineHeight) {
    messageLineHeight = data.messageLineHeight;
  }
  var messageFontFamily = data.messageFontFamily || 'Montserrat';
  var messageFontWeight = data.messageFontWeight || '700';
  var messageFontStyle  = data.messageFontStyle  || 'normal';

  // Convert px values to inches for print
  var topInches = topPosition;
  var msgInches = messagePosition;
  if (topPosition.indexOf('px') > -1) {
    topInches = (parseFloat(topPosition) / 72) + 'in';
  }
  if (messagePosition.indexOf('px') > -1) {
    msgInches = (parseFloat(messagePosition) / 72) + 'in';
  }

  // FIX: Wider margins (0.55in each side) and hard overflow constraints
  // Card width reduced to 4.15in with overflow:hidden on all text containers
  var html = '<!DOCTYPE html><html><head>';
  html += '<title> </title><meta charset="UTF-8">';
  html += '<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Dancing+Script:wght@400;700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&family=Great+Vibes&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Raleway:ital,wght@0,400;0,700;1,400;1,700&family=Pacifico&family=EB+Garamond:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">';
  html += '<style>';
  html += '@page { size: 4.15in 8.5in; margin: 0; }';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { margin: 0; padding: 0; font-family: Montserrat, Arial, sans-serif; background: white; }';
  html += '.card { width: 4.15in; height: 8.5in; position: relative; background: white; overflow: hidden; }';
  html += '.top-section { position: absolute; top: ' + topInches + '; left: 0.55in; right: 0.55in; text-align: center; overflow: hidden; }';
  html += '.recipient-name { font-family: Montserrat, sans-serif; font-size: 11.9pt; font-weight: 400; margin-bottom: 12px; color: #000; word-wrap: break-word; overflow-wrap: break-word; }';
  html += '.recipient-address { font-family: Montserrat, sans-serif; font-size: 9.35pt; font-weight: 400; line-height: 1.4; color: #000; word-wrap: break-word; overflow-wrap: break-word; }';
  html += '.message-section { position: absolute; top: ' + msgInches + '; left: 0.55in; right: 0.55in; text-align: center; overflow: hidden; }';
  html += '.gift-message { font-family: ' + messageFontFamily + ', sans-serif; font-size: ' + messageFontSize + '; font-weight: ' + messageFontWeight + '; font-style: ' + messageFontStyle + '; line-height: ' + messageLineHeight + '; color: #000; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }';
  html += '.gift-sender { margin-top: 12px; font-family: ' + messageFontFamily + ', sans-serif; font-size: ' + messageFontSize + '; font-weight: ' + messageFontWeight + '; font-style: ' + messageFontStyle + '; color: #000; word-wrap: break-word; overflow-wrap: break-word; }';
  // Order number at bottom of the card - 6pt light gray, barely visible
  html += '.order-code { position: absolute; bottom: 0.15in; left: 0; right: 0; text-align: center; font-family: Arial, sans-serif; font-size: 6pt; color: #ccc; }';
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
  // Always show order number if present
  if (orderNumber) {
    html += '<div class="order-code">' + orderNumber + '</div>';
  }
  html += '</div>';
  html += '</body></html>';
  return html;
}
module.exports = { generateGiftCardHTML };
