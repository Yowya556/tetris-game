# Neon Tetris authoritative server

1. Copy `.env.example` to `.env` and load it with your process manager. Never put the service-role key or Stripe secret in `index.html`.
2. Run `npm install` and `npm start`.
3. Set `SERVER_API_URL` and `ONLINE_SOCKET_URL` in `index.html` to the deployed HTTPS/WSS origins.
4. Run `supabase.sql` in the Supabase SQL editor.
5. Enable Google Auth in Supabase and configure the exact production origin in `ALLOWED_ORIGINS`.
6. Configure Stripe webhook delivery to `/api/stripe/webhook` and provide the signing secret. Checkout products must use the configured Stripe price IDs.

The browser requests a one-time `/api/ws-ticket`, then sends authenticated action intent only over `/ws`. The server simulates Tetris, derives scores and garbage, validates JWT identity, and uses database transactions for idempotent score and purchase writes. Set `SERVER_API_URL` and `ONLINE_SOCKET_URL` in the HTML to this deployment.

Before production, add TLS termination, structured logging/metrics, a distributed rate limiter, room capacity/TTL limits, Redis or another shared room store for multiple instances, and a complete server-side replay/game rules test suite against the browser engine.
