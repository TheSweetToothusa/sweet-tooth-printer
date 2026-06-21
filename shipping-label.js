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

// Default box for small/unmatched items (chocolates etc.) — they rarely get DIM surcharges.
const DEFAULT_BOX = [10, 8, 6];

// Real shipping box (in) + packed weight (lb) for the big/heavy items that actually get
// surcharged. Matched by keyword in the line-item title, most specific first. Measured 2026-06.
const PARCEL_TABLE = [
  { match: ['candy apple'], weightLb: 15, box: [12, 8, 5] },   // 6-pack: 6x (4x4x4) in a brown box
  { match: ['supreme'], weightLb: 22, box: [30, 30, 10] },
  { match: ['penultimate'], weightLb: 18, box: [26, 26, 8] },
  { match: ['jumbo'], weightLb: 12, box: [27, 17, 9] },
  { match: ['grand oval'], weightLb: 10, box: [27, 17, 9] },
  { match: ['extra large'], weightLb: 7, box: [18, 18, 7] },
  { match: ['large oval'], weightLb: 5, box: [21.5, 14.5, 8.5] },
  { match: ['medium round'], weightLb: 5, box: [14.5, 14.5, 8.5] },
  { match: ['small round'], weightLb: 5, box: [14.5, 14.5, 8.5] }
];

function lookupParcel(title) {
  var t = (title || '').toLowerCase();
  for (var i = 0; i < PARCEL_TABLE.length; i++) {
    if (PARCEL_TABLE[i].match.every(function (m) { return t.indexOf(m) > -1; })) return PARCEL_TABLE[i];
  }
  return null;
}

// Choose the parcel: real box + packed weight for matched big items, else grams + default box.
function buildParcel(order) {
  var items = order.line_items || [];
  var best = null, bestVol = -1, weightLb = 0, matched = false;
  items.forEach(function (li) {
    var p = lookupParcel(li.title || li.name);
    if (p) {
      matched = true;
      weightLb += p.weightLb * (li.quantity || 1);
      var vol = p.box[0] * p.box[1] * p.box[2];
      if (vol > bestVol) { bestVol = vol; best = p; }
    }
  });
  if (matched && best) return { box: best.box, weightOz: Math.max(1, Math.round(weightLb * 16)) };
  return { box: DEFAULT_BOX, weightOz: orderWeightOz(order) };
}

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

  var parcel = buildParcel(order);
  var shipment = await shippo('/shipments/', {
    address_from: STORE_ADDRESS,
    address_to: shippoAddressFromOrder(order),
    parcels: [{
      length: String(parcel.box[0]), width: String(parcel.box[1]), height: String(parcel.box[2]),
      distance_unit: 'in',
      weight: String(parcel.weightOz), mass_unit: 'oz'
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
    trackingUrl: txn.tracking_url_provider || null,
    carrier: rate.provider,
    service: rate.servicelevel && rate.servicelevel.name,
    amount: rate.amount,
    chosenTitle: chosenTitle
  };
}

module.exports = { buyLabelForOrder, mapServiceToken, orderWeightOz };
