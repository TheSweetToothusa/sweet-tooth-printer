function generateGiftCardHTML(data) {
  var giftReceiver = data.giftReceiver;
  var giftMessage = data.giftMessage;
  var giftSender = data.giftSender;
  var recipient = data.recipient;
  var topPosition = data.topPosition || '0.25in';
  // Message position moved down 0.75in (was 3.8in, now 4.55in)
  var messagePosition = data.messagePosition || '4.55in';

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
  html += '<title> </title><meta charset="UTF-8">';
  html += '<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">';
  html += '<style>';
  html += '@page { size: 4.2in 8.5in; margin: 0; }';
  html += '* { margin: 0; padding: 0; box-sizing: border-box; }';
  html += 'body { margin: 0; padding: 0; font-family: Montserrat, Arial, sans-serif; background: white; }';
  html += '.card { width: 4.2in; height: 8.5in; position: relative; background: white; }';
  html += '.top-section { position: absolute; top: ' + topInches + '; left: 0; right: 0; text-align: center; padding: 0 0.5in; }';
  // Recipient name: 14pt reduced by 15% = 11.9pt, Montserrat Regular (400)
  html += '.recipient-name { font-family: Montserrat, sans-serif; font-size: 11.9pt; font-weight: 400; margin-bottom: 16px; color: #000; }';
  // Recipient address: 11pt reduced by 15% = 9.35pt, Montserrat Regular (400)
  html += '.recipient-address { font-family: Montserrat, sans-serif; font-size: 9.35pt; font-weight: 400; line-height: 1.4; color: #000; }';
  html += '.message-section { position: absolute; top: ' + msgInches + '; left: 0; right: 0; text-align: center; padding: 0 0.5in; }';
  // Gift message: 12pt reduced by 15% = 10.2pt, Montserrat Bold (700)
  html += '.gift-message { font-family: Montserrat, sans-serif; font-size: 10.2pt; font-weight: 700; font-style: normal; line-height: 1.5; color: #000; }';
  // Gift sender: same as message - 10.2pt, Montserrat Bold (700)
  html += '.gift-sender { margin-top: 16px; font-family: Montserrat, sans-serif; font-size: 10.2pt; font-weight: 700; font-style: normal; color: #000; }';
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
