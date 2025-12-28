function generateGiftCardHTML(data) {
  var giftReceiver = data.giftReceiver;
  var giftMessage = data.giftMessage;
  var giftSender = data.giftSender;
  var recipient = data.recipient;
  var fontFamily = data.fontFamily || 'Arial, sans-serif';
  var fontSize = data.fontSize || '12pt';
  var fontWeight = data.fontWeight || 'bold';
  var fontStyle = data.fontStyle || 'normal';
  var topPosition = data.topPosition || '0.5in';
  var messagePosition = data.messagePosition || '3.8in';

  var receiverName = giftReceiver || recipient.name;
  var addressLine1 = [recipient.address1, recipient.address2].filter(Boolean).join(', ');
  var addressLine2 = recipient.city ? (recipient.city + ', ' + recipient.province + ' ' + recipient.zip) : '';
  var senderDiv = giftSender ? '<div class="gift-sender">' + giftSender + '</div>' : '';
  var formattedMessage = (giftMessage || '').replace(/\n/g, '<br>');

  // Convert px values to inches for print (72px = 1in approximately for preview scale)
  var topInches = topPosition;
  var msgInches = messagePosition;
  if (topPosition.indexOf('px') > -1) {
    topInches = (parseFloat(topPosition) / 72) + 'in';
  }
  if (messagePosition.indexOf('px') > -1) {
    msgInches = (parseFloat(messagePosition) / 72) + 'in';
  }

  var html = '<!DOCTYPE html><html><head>';
  html += '<title>Gift Card</title><meta charset="UTF-8">';
  html += '<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Poppins:ital,wght@0,400;0,700;1,400;1,700&family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Inter:wght@0,400;0,700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">';
  html += '<style>';
  html += '@page { size: 4.2in 8.5in; margin: 0; }';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { margin: 0; padding: 0; font-family: Arial, sans-serif; background: white; }';
  html += '.card { width: 4.2in; height: 8.5in; position: relative; background: white; }';
  html += '.top-section { position: absolute; top: ' + topInches + '; left: 0; right: 0; text-align: center; padding: 0 0.5in; }';
  html += '.recipient-name { font-size: 14pt; font-weight: bold; margin-bottom: 16px; color: #000; }';
  html += '.recipient-address { font-size: 11pt; font-weight: bold; line-height: 1.4; color: #000; }';
  html += '.message-section { position: absolute; top: ' + msgInches + '; left: 0; right: 0; text-align: center; padding: 0 0.5in; }';
  html += '.gift-message { font-family: ' + fontFamily + '; font-size: ' + fontSize + '; font-weight: ' + fontWeight + '; font-style: ' + fontStyle + '; line-height: 1.5; color: #000; }';
  html += '.gift-sender { margin-top: 16px; font-family: ' + fontFamily + '; font-size: ' + fontSize + '; font-weight: ' + fontWeight + '; font-style: ' + fontStyle + '; color: #000; }';
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
