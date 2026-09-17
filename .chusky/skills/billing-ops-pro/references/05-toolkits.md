# Toolkits for billing ops

| Need | Toolkit family |
|------|----------------|
| Subscriptions / invoices / payment links | `STRIPE_` first |
| Regional payments | `PAYSTACK_`, `RAZORPAY_` |
| Accounting sync | `QUICKBOOKS_`, `XERO_` |
| Dunning email | `GMAIL_`, `CUSTOMER_IO_`, `POSTMARK_` / `RESEND_` |
| Collections call | voice-call-pro + call brief (not random SMS spam) |

Always read live invoice/customer objects before stating amounts.
