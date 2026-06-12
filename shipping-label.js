// ============================================================
// shipping-label.js  —  SEPARATE module (does NOT touch invoice/gift-card flows)
// Buys the label for the service the customer chose (via Shippo) and
// returns it as a base64 PDF for PrintNode to print on the 4x6 label printer.
// ============================================================
const fetch = require('node-fetch');

const SHIPPO_TOKEN = process.env.SHIPPO_API_TOKEN;

// Store origin (North Miami Beach) — label "from" address.
const STORE_ADDRESS = {
  name: 'The Sweet Tooth',
  street1: '18435 NE 19th Ave',
  city: 'North Miami Beach',
  state: 'FL',
  zip: '33179',
  country: 'US',
  phone: process.env.STORE_PHONE || '3056821400',
  email: 'orders@thesweettooth.com'
};

// Orders that ship NO label (handled in-store / by local driver).
function isNonShipping(title) {
  var t = (title || '').toLowerCase();
  return t.indexOf('local delivery') > -1 || t.indexOf('pick up') > -1 || t.indexOf('pickup') > -1;
}

// Default box if we ever need one — weight is real (from the order), dims are a safe default
// because Shopify doesn't store per-product box dimensions.
const DEFAULT_BOX = { length: '10', width: '8', height: '6', distance_unit: 'in' };

// Map the Shopify shipping-line title -> Shippo servicelevel_token.
// Falls back to null (we then just buy the cheapest rate from the same carrier).
function mapServiceToken(title) {
  var t = (title || '').toLowerCase();
  if (t.indexOf('priority mail express') > -1) return 'usps_priority_express';
  if (t.indexOf('next day') > -1) {
    if (t.indexOf('saver') > -1) return 'ups_next_day_air_saver';
    if (t.indexOf('early') > -1) return 'ups_next_day_air_early_am';
    return 'ups_next_day_air';
  }
  if (t.indexOf('2nd day') > -1 || t.indexOf('second day') > -1) return 'ups_second_day_air';
  if (t.indexOf('ground advantage') > -1) return 'usps_ground_advantage';
  if (t.indexOf('priority') > -1) return 'usps_priority';
  if (t.indexOf('ground') > -1) return 'ups_ground';
  return null;
}

function carrierHint(title) {
  var t = (title || '').toLowerCase();
  if (t.indexOf('usps') > -1 || t.indexOf('priority') > -1 || t.indexOf('ground advantage') > -1) return 'usps';
  if (t.indexOf('ups') > -1) return 'ups';
  return null;
}

// Sum the real order weight (grams) -> ounces for Shippo. Fallback 48oz (3lb).
function orderWeightOz(order) {
  var grams = 0;
  (order.line_items || []).forEach(function (li) {
    grams += (li.grams || 0) * (li.quantity || 1);
  });
  if (!grams) grams = 1361; // 3 lb fallback
  return Math.max(1, Math.round(grams / 28.3495));
}

function shippoAddressFromOrder(order) {
  var a = order.shipping_address || {};
  return {
    name: a.name || ((a.first_name || '') + ' ' + (a.last_name || '')).trim() || 'Customer',
    street1: a.address1 || '',
    street2: a.address2 || '',
    city: a.city || '',
    state: a.province_code || '',
    zip: a.zip || '',
    country: a.country_code || 'US',
    phone: a.phone || order.phone || '0000000000'
  };
}

async function shippo(path, body) {
  var res = await fetch('https://api.goshippo.com' + path, {
    method: 'POST',
    headers: {
      'Authorization': 'ShippoToken ' + SHIPPO_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  var json = await res.json();
  if (!res.ok) throw new Error('Shippo ' + path + ' error ' + res.status + ': ' + JSON.stringify(json));
  return json;
}

// Match ONLY the exact service the customer chose. Never substitute a slower/other
// service (that could melt). Returns the matching rate, or null if not found.
function matchRate(rates, chosenTitle) {
  if (!rates || !rates.length) return null;
  var token = mapServiceToken(chosenTitle);
  if (!token) return null;
  var match = rates.filter(function (r) { return r.servicelevel && r.servicelevel.token === token; });
  if (!match.length) return null;
  match.sort(function (a, b) { return parseFloat(a.amount) - parseFloat(b.amount); });
  return match[0];
}

async function urlToBase64(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('Label download failed: ' + res.status);
  var buf = await res.buffer();
  return buf.toString('base64');
}

// Main entry: returns { labelBase64, tracking, carrier, service, amount }
async function buyLabelForOrder(order) {
  if (!SHIPPO_TOKEN) throw new Error('SHIPPO_API_TOKEN not set');
  var chosenTitle = (order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].title) || '';
  if (isNonShipping(chosenTitle)) {
    return { skipped: true, needsManual: false, reason: 'Local delivery / pickup — no label', chosenTitle: chosenTitle };
  }

  var shipment = await shippo('/shipments/', {
    address_from: STORE_ADDRESS,
    address_to: shippoAddressFromOrder(order),
    parcels: [{
      length: DEFAULT_BOX.length, width: DEFAULT_BOX.width, height: DEFAULT_BOX.height,
      distance_unit: DEFAULT_BOX.distance_unit,
      weight: String(orderWeightOz(order)), mass_unit: 'oz'
    }],
    async: false
  });

  var rate = matchRate(shipment.rates, chosenTitle);
  if (!rate) {
    return {
      skipped: true, needsManual: true,
      reason: 'Couldn\'t match "' + chosenTitle + '" in Shippo — buy this label manually',
      chosenTitle: chosenTitle
    };
  }

  // Safety cap: don't auto-buy if Shippo's label is more than $CAP over what the customer paid.
  // (Free-shipping orders, where the customer paid $0, are intentionally absorbed — no cap.)
  var CAP = parseFloat(process.env.LABEL_PRICE_CAP || '5');
  var customerPaid = parseFloat((order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].price) || 0);
  if (customerPaid > 0 && parseFloat(rate.amount) > customerPaid + CAP) {
    return {
      skipped: true, needsManual: true,
      reason: 'Shippo $' + rate.amount + ' is over the $' + CAP + ' cap (customer paid $' + customerPaid.toFixed(2) + ')',
      amount: rate.amount, customerPaid: customerPaid.toFixed(2),
      carrier: rate.provider, service: rate.servicelevel && rate.servicelevel.name,
      chosenTitle: chosenTitle
    };
  }

  var txn = await shippo('/transactions/', {
    rate: rate.object_id,
    label_file_type: 'PDF_4x6',
    async: false
  });
  if (txn.status !== 'SUCCESS') {
    throw new Error('Shippo transaction failed: ' + JSON.stringify(txn.messages || txn));
  }

  return {
    labelBase64: await urlToBase64(txn.label_url),
    tracking: txn.tracking_number,
    carrier: rate.provider,
    service: rate.servicelevel && rate.servicelevel.name,
    amount: rate.amount,
    chosenTitle: chosenTitle
  };
}

module.exports = { buyLabelForOrder, mapServiceToken, orderWeightOz };
