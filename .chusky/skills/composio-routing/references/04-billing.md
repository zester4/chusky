# Billing & finance

Use Jev's exact billing route and inspect live source objects before drafting
or changing anything. Payment, refund, invoice, subscription, and account
changes remain approval-gated by policy; confirm the provider receipt and final
state rather than trusting a tool success response.

| Prefer | Typical use |
|--------|-------------|
| `STRIPE_` | Subscriptions, invoices, customers, payment links |
| `QUICKBOOKS_` | Accounting |
| `XERO_` | Accounting |
| `PAYSTACK_` | Payments |
| `RAZORPAY_` | Payments |
| `CHARGEBEE_` | Subscription billing (if present) |
| `RECURLY_` | Subscriptions |
| `QUADERO_` | Tax/invoicing |
| `SEVDESK_` | Invoicing |
| `MONEYBIRD_` | Invoicing |
| `YNAB_` | Personal budget (owner only) |

**Skill pairing:** billing-ops-pro, voice-call-pro collections, retention-pro.

Never approximate amounts — read live objects first.
