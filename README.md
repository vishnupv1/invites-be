# Vellum API

Stores hosts, one-time purchases, invites, greetings, and uploaded media in MongoDB. The site is in [invites](https://github.com/vishnupv1/invites).

```bash
cp .env.example .env
npm install
npm run dev
```

MongoDB must already be running at the URI in `.env` (default `mongodb://127.0.0.1:27017/vellum`).

The API listens on port 4010. Card numbers stay in the browser; this service only records that a template was bought.
