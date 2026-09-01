import crypto from 'node:crypto';
import express from 'express';
import Stripe from 'stripe';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { TetrisEngine, verifyReplayPayload, ACTIONS } from './tetris-engine.mjs';

const app = express();
const port = Number(process.env.PORT || 8787);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Missing required server environment variables');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PRODUCT_GRANTS = { coinPouch: { coins: 500 }, megaVault: { coins: 2500 }, eliteThemePack: { theme: 'elite' } };
const MAX_MESSAGES_PER_SECOND = 30;
const PRICE_IDS = { coinPouch: process.env.STRIPE_PRICE_COIN_POUCH, megaVault: process.env.STRIPE_PRICE_MEGA_VAULT, eliteThemePack: process.env.STRIPE_PRICE_ELITE_THEME };
const httpRateLimits = new Map();
const wsTickets = new Map();

function originAllowed(origin) { return !origin || (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).includes(origin); }
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(originAllowed(origin) ? 204 : 403);
  next();
});
async function requireUser(req, res, next) {
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: 'origin_denied' });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const { data: { user }, error } = token ? await supabase.auth.getUser(token) : { data: {}, error: true };
  if (error || !user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => req.path === '/stripe/webhook' ? next() : express.json({ limit: '8kb' })(req, res, next));
app.use('/api', (req, res, next) => {
  const key = req.ip; const now = Date.now(); const current = httpRateLimits.get(key) || { start: now, count: 0 };
  if (now - current.start >= 60000) { current.start = now; current.count = 0; }
  current.count += 1; httpRateLimits.set(key, current);
  if (current.count > 120) return res.status(429).json({ error: 'rate_limited' });
  next();
});
app.get('/api/scores', async (req, res) => {
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: 'origin_denied' });
  const { data, error } = await supabase.from('scores').select('player_name, score, created_at').order('score', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'read_failed' });
  res.json(data);
});

app.post('/api/ws-ticket', requireUser, (req, res) => {
  const ticket = crypto.randomBytes(32).toString('base64url');
  wsTickets.set(ticket, { userId: req.user.id, expiresAt: Date.now() + 60000 });
  res.json({ ticket });
});

app.post('/api/checkout', requireUser, async (req, res) => {
  const productId = req.body?.productId;
  if (!Object.hasOwn(PRODUCT_GRANTS, productId) || !PRICE_IDS[productId]) return res.status(400).json({ error: 'invalid_product' });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', line_items: [{ price: PRICE_IDS[productId], quantity: 1 }],
    client_reference_id: req.user.id,
    metadata: { product_id: productId },
    success_url: process.env.CHECKOUT_SUCCESS_URL,
    cancel_url: process.env.CHECKOUT_CANCEL_URL
  });
  res.json({ url: session.url });
});

app.post('/api/scores', requireUser, async (req, res) => {
  const { replay, idempotencyKey } = req.body || {};
  if (typeof replay !== 'string' || replay.length > 12000 || !/^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey || '')) return res.status(400).json({ error: 'invalid_request' });
  // Verify the replay in a trusted deterministic simulator before inserting. Do not trust score/name from the client.
  const result = verifyReplayPayload(replay);
  if (!result.valid || result.score < 0 || result.score > 100000000) return res.status(422).json({ error: 'invalid_result' });
  const { error } = await supabase.rpc('submit_verified_score', { p_user_id: req.user.id, p_player_name: (req.user.user_metadata?.full_name || req.user.email || 'Player').slice(0, 24), p_score: result.score, p_replay_hash: result.hash, p_idempotency_key: idempotencyKey });
  if (error) return res.status(409).json({ error: 'duplicate_or_rejected' });
  res.status(201).json({ accepted: true });
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('invalid_signature'); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const productId = session.metadata?.product_id;
    const grant = PRODUCT_GRANTS[productId];
    if (!userId || !grant || session.payment_status !== 'paid') return res.status(400).send('invalid_payment');
    const { error } = await supabase.rpc('grant_purchase_once', { p_user_id: userId, p_provider_event_id: event.id, p_product_id: productId, p_coins: grant.coins || 0, p_theme: grant.theme || null });
    if (error) return res.status(500).send('fulfillment_failed');
  }
  res.json({ received: true });
});

const server = app.listen(port, () => console.log(`API listening on ${port}`));
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();
wss.on('error', (error) => console.error('WebSocket server error', error));
wss.on('connection', async (socket, request) => {
  if (!originAllowed(request.headers.origin)) return socket.close(1008, 'origin denied');
  const ticket = new URL(request.url, 'http://localhost').searchParams.get('ticket');
  const ticketData = ticket ? wsTickets.get(ticket) : null;
  if (ticketData) wsTickets.delete(ticket);
  const { data: { user } } = ticketData && ticketData.expiresAt > Date.now() ? await supabase.auth.admin.getUserById(ticketData.userId) : { data: {} };
  if (!user) return socket.close(1008, 'authentication required');
  let room = null; let slot = null; let lastSequence = -1; let windowStart = Date.now(); let messageCount = 0;
  const leave = () => { if (room) { room.clients.delete(socket); room.engines.delete(socket); room.slots.delete(socket); if (!room.clients.size) rooms.delete(room.code); room = null; } };
  socket.on('message', (raw) => {
    if (raw.length > 8192) return socket.close(1009, 'message too large');
    const now = Date.now(); if (now - windowStart >= 1000) { windowStart = now; messageCount = 0; }
    if (++messageCount > MAX_MESSAGES_PER_SECOND) return socket.close(1008, 'rate limit');
    let message; try { message = JSON.parse(raw.toString('utf8')); } catch { return socket.close(1003, 'invalid json'); }
    if (message.type === 'create_room' || message.type === 'join_room') {
      if (room || typeof message.room !== 'string' || !/^[A-Z0-9]{4}$/.test(message.room)) return;
      if (message.type === 'create_room') {
        if (rooms.has(message.room)) return socket.send(JSON.stringify({ type: 'room_error', message: 'Room already exists' }));
        room = { code: message.room, seed: typeof message.seed === 'string' ? message.seed.slice(0, 32) : '12345', clients: new Set(), engines: new Map(), slots: new Map(), lastTick: now };
        rooms.set(room.code, room);
      } else room = rooms.get(message.room);
      if (!room || room.clients.size >= 2) return socket.send(JSON.stringify({ type: 'room_error', message: 'Room unavailable' }));
      if (message.type === 'join_room' && typeof message.seed === 'string' && message.seed.slice(0, 32) !== room.seed) return socket.send(JSON.stringify({ type: 'room_error', message: 'Room seed mismatch' }));
      slot = room.clients.size + 1; room.clients.add(socket); room.engines.set(socket, new TetrisEngine(room.seed)); room.slots.set(socket, slot);
      if (room.clients.size === 2) for (const client of room.clients) client.send(JSON.stringify({ type: 'match_start' }));
      return;
    }
    if (!room || !room.clients.has(socket) || message.room !== room.code) return;
    const engine = room.engines.get(socket);
    if (message.type === 'action' && typeof message.action === 'string' && ACTIONS.has(message.action)) {
      if (typeof message.seq !== 'number' || !Number.isInteger(message.seq) || message.seq <= lastSequence) return;
      lastSequence = message.seq;
      engine.action(message.action);
      const attack = engine.lastAttack || 0; engine.lastAttack = 0;
      if (attack > 0) for (const [client, targetEngine] of room.engines) if (client !== socket) targetEngine.pendingGarbage = Math.min(8, targetEngine.pendingGarbage + attack);
      for (const client of room.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: 'state', playerSlot: slot, state: engine.snapshot() }));
    } else if (message.type === 'state') {
      return;
    }
  });
  socket.on('close', leave); socket.on('error', leave);
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const delta = Math.min(250, now - room.lastTick); room.lastTick = now;
    for (const [owner, engine] of room.engines) {
      engine.tick(delta);
      if (engine.lastAttack) {
        const attack = engine.lastAttack; engine.lastAttack = 0;
        for (const [client, targetEngine] of room.engines) if (client !== owner) targetEngine.pendingGarbage = Math.min(8, targetEngine.pendingGarbage + attack);
      }
      for (const client of room.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: 'state', playerSlot: room.slots.get(owner), state: engine.snapshot() }));
    }
  }
}, 50);
