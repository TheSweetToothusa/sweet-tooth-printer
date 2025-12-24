# Sweet Tooth Order Printer

Automatic invoice and gift card printing for The Sweet Tooth. Replaces Print Out Designer.

## How It Works

```
Order placed on Shopify
        ↓
Webhook → Railway (this app, always on)
        ↓
App calls PrintNode API
        ↓
PrintNode → Shop computer (running PrintNode client)
        ↓
Invoice prints automatically 🖨️
```

## Features

- ✅ Automatic printing when orders come in
- ✅ Three invoice templates: Local Delivery, Pickup, Shipping
- ✅ Black & white optimized (Manrope font)
- ✅ Prominent delivery type badge + city name
- ✅ NO tips printed (ever!)
- ✅ Recipient phone highlighted
- ✅ Special instructions at bottom
- 🚧 Gift card message printing (template coming)

---

## Deploy to Railway (5 minutes)

### Step 1: Push to GitHub

1. Create a new GitHub repo (e.g., `sweet-tooth-printer`)
2. Upload these files to it

### Step 2: Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `sweet-tooth-printer` repo
4. Railway will auto-detect Node.js and start building

### Step 3: Add Environment Variables

In Railway dashboard → your project → **Variables** tab, add:

```
SHOPIFY_API_TOKEN=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
SHOPIFY_STORE_URL=thesweettoothfl.myshopify.com
SHOPIFY_WEBHOOK_SECRET=5fc833e682ec658cafb6cb68e6806d09d60b6905c3716c24a07fcbdd396858fa
PRINTNODE_API_KEY=RwBYBjIY7sGvqw2aKg4eD_f_GsoBQS8h4AC7yize9nE
PRINTNODE_INVOICE_PRINTER_ID=<your_printer_id>
```

**To get your printer ID:**
- Run locally: `npm install && npm run list-printers`
- Or check PrintNode dashboard

### Step 4: Get Your Railway URL

1. In Railway → **Settings** → **Networking**
2. Click **Generate Domain**
3. You'll get something like: `sweet-tooth-printer-production.up.railway.app`

### Step 5: Set Up Shopify Webhook

1. Shopify Admin → **Settings** → **Notifications** → **Webhooks**
2. Click **Create webhook**
3. Configure:
   - **Event:** Order creation
   - **URL:** `https://YOUR-RAILWAY-URL.up.railway.app/webhook/orders/create`
   - **Format:** JSON
4. Save

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | App status |
| `GET /health` | Health check |
| `GET /print/:orderId` | Manually print specific order |
| `GET /print-recent/:count` | Print last N orders |
| `POST /webhook/orders/create` | Shopify webhook |
| `POST /webhook/orders/paid` | Shopify webhook (alt) |

---

## Invoice Layout

```
┌─────────────────────────────────────────────────────┐
│ ┌──────────────────┐                    MIAMI BEACH │
│ │ LOCAL DELIVERY   │                   Delivering To│
│ └──────────────────┘                                │
├─────────────────────────────────────────────────────┤
│ Order #33979                      Delivery Date     │
│                                   Dec 24, 2024      │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────┐  ┌────────────────────────┐ │
│ │ RECIPIENT           │  │ GIFT FROM              │ │
│ │ ═══════════════════ │  │ ────────────────────── │ │
│ │ Sarah Johnson       │  │ David Thompson         │ │
│ │ ┌─────────────────┐ │  │ david@company.com      │ │
│ │ │ ☎ (305) 555-1234│ │  │ (786) 555-9876         │ │
│ │ └─────────────────┘ │  │                        │ │
│ │ 1200 Collins Ave    │  │                        │ │
│ │ Miami Beach, FL     │  │                        │ │
│ └─────────────────────┘  └────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ ORDER ITEMS                                         │
│ ─────────────────────────────────────────────────── │
│ Item                      SKU          Qty    Price │
│ Holiday Gift Basket       HGB-LG       1    $125.00 │
│ Truffle Box              TRF-12        2     $45.00 │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│ ⚠ SPECIAL INSTRUCTIONS                              │
│ Leave with front desk. Call before delivery.        │
└─────────────────────────────────────────────────────┘
```

---

## Shop Computer Setup

1. Download PrintNode client from [printnode.com](https://www.printnode.com/en/download)
2. Install and sign in with your PrintNode account
3. Select the printer you want to use for invoices
4. Keep the computer on during business hours

---

## Testing

**Test the health endpoint:**
```
curl https://YOUR-RAILWAY-URL.up.railway.app/health
```

**Manually print most recent order:**
```
curl https://YOUR-RAILWAY-URL.up.railway.app/print-recent/1
```

---

## Files

- `index.js` - Main server with webhook handling
- `order-utils.js` - Order extraction and HTML generation
- `list-printers.js` - Utility to list PrintNode printers
- `test-print.js` - Test script for local preview
