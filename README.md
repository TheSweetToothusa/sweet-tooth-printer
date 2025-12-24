# Sweet Tooth Order Printer

Automatic invoice and gift card printing for The Sweet Tooth. Replaces Print Out Designer.

## Features

- ✅ Automatic printing when orders come in
- ✅ Three invoice templates: Local Delivery, Pickup, Shipping
- ✅ Black & white optimized (Manrope font)
- ✅ Prominent delivery type badge + city name
- ✅ NO tips printed (ever!)
- ✅ Recipient phone highlighted
- ✅ Special instructions at bottom
- ✅ Gift card message printing with live preview editor

## How It Works

```
Order placed on Shopify
        ↓
Webhook → Render (always on)
        ↓
Generate PDF (Puppeteer)
        ↓
Send to PrintNode API
        ↓
Print at shop
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| GET / | App status |
| GET /health | Health check |
| GET /dashboard | Gift card management dashboard |
| GET /print/:orderId | Manually print specific order |
| GET /print-recent/:count | Print last N orders |

## Environment Variables

Set these in your Render dashboard (Settings → Environment):

- `SHOPIFY_API_TOKEN` - Your Shopify Admin API token
- `SHOPIFY_STORE_URL` - Your store URL (e.g., yourstore.myshopify.com)
- `SHOPIFY_WEBHOOK_SECRET` - Webhook signing secret from Shopify
- `PRINTNODE_API_KEY` - Your PrintNode API key
- `PRINTNODE_INVOICE_PRINTER_ID` - Printer ID for invoices
- `PRINTNODE_GIFTCARD_PRINTER_ID` - Printer ID for gift cards

## Shopify Webhook Setup

1. Shopify Admin → Settings → Notifications → Webhooks
2. Click **Create webhook**
3. Configure:
   - Event: Order creation
   - URL: `https://your-app.onrender.com/webhook/orders/create`
   - Format: JSON
4. Save

## Dashboard

Access the gift card dashboard at `/dashboard` to:
- View recent orders with gift messages
- Preview gift cards before printing
- Edit recipient info, message, and fonts
- Reprint gift cards
