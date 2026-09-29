# Vellum API

Stores hosts, one-time purchases, invites, greetings, and uploaded media in MongoDB. The site is in [invites](https://github.com/vishnupv1/invites).

```bash
cp .env.example .env
npm install
npm run dev
```

MongoDB must already be running at the URI in `.env` (default `mongodb://127.0.0.1:27017/vellum`).

Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to `.env` (and to the deployed environment). The API creates Razorpay orders and verifies successful payments before recording a purchase; card details are handled by Razorpay Checkout.

The API listens on port 4010.
