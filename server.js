import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, getSettings, saveSettings, DEFAULT_SETTINGS, UPLOAD_DIR } from './lib/db.js';
import { deliveryFee, planRoute, roadKm } from './lib/geo.js';
import { SLOTS, slotHour, availableSlots, nextDeliveryDate, localDate, pad } from './lib/slots.js';
import { purgeOldData } from './lib/purge.js';

process.env.TZ ||= 'Africa/Ouagadougou';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.IP || process.env.HOST || '0.0.0.0'; // alwaysdata fournit IP et PORT
const IS_PROD = process.env.NODE_ENV === 'production';
if (IS_PROD && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 10)) {
  console.error('❌ En production, définissez ADMIN_PASSWORD (10 caractères minimum).');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'zindo2026';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD non défini : mot de passe admin par défaut "zindo2026". Changez-le en production.');
}

const STATUSES = ['nouvelle', 'confirmee', 'en_livraison', 'livree', 'annulee'];
const ACTIVE_STATUSES = ['nouvelle', 'confirmee', 'en_livraison'];

const app = express();
// Derrière l'hébergeur (proxy HTTPS) : pour connaître la vraie adresse IP des visiteurs
app.set('trust proxy', 1);
app.disable('x-powered-by');
const STARTED_AT = new Date().toISOString();
app.get('/health', (req, res) => res.json({ ok: true, startedAt: STARTED_AT, proto: req.get('x-forwarded-proto') || null }));
// En ligne : toujours passer en https (indispensable pour la géolocalisation sur téléphone).
// L'hébergeur envoie « x-forwarded-proto: https » pour les visites sécurisées, et rien en http.
// (/health est déclaré avant : il reste accessible sans redirection.)
app.use((req, res, next) => {
  if (IS_PROD && req.get('x-forwarded-proto') !== 'https') {
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
});
app.use(express.json({ limit: '6mb' }));
// no-cache : le navigateur revalide les fichiers à chaque visite,
// pour que les clients aient toujours la dernière version après une mise à jour.
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res, file) => {
    if (/\.(html|js|css|svg)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// ---------- utilitaires ----------
const localDateTime = (d = new Date()) => `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

function parsePoint(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === '' || lat == null || lng === '' || lng == null) return null;
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

function newOrderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = 'Z';
    for (const b of crypto.randomBytes(6)) c += alphabet[b % alphabet.length];
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(c)) return c;
  }
}

function attachItems(orders) {
  if (!orders.length) return orders;
  const ids = orders.map((o) => o.id);
  const items = db
    .prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const byOrder = new Map(ids.map((id) => [id, []]));
  for (const it of items) byOrder.get(it.order_id).push(it);
  return orders.map((o) => ({ ...o, items: byOrder.get(o.id) }));
}

function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Image invalide (PNG, JPG ou WEBP).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Image trop lourde (4 Mo max).');
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

function removeImage(url) {
  if (url && url.startsWith('/uploads/')) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(url)), () => {});
  }
}

function publicConfig(s) {
  return {
    shopName: s.shop_name,
    shopPhone: s.shop_phone,
    countryCode: s.country_code,
    // La position de la boutique reste privée : les clients ne voient que le centre-ville.
    mapCenter: { lat: s.default_lat, lng: s.default_lng },
    deliveryFee: s.delivery_fee,
    morningCutoff: s.cutoff_hour,
    eveningCutoff: s.same_day_evening_cutoff,
    startHour: s.start_hour,
    eveningStartHour: s.evening_start_hour,
    cutoffHour: s.cutoff_hour,
    nextDeliveryDate: nextDeliveryDate(s),
    slots: availableSlots(s)
  };
}

// ======================================================================
//  API CLIENT
// ======================================================================
app.get('/api/config', (req, res) => res.json(publicConfig(getSettings())));

app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, price, unit, image FROM products WHERE available = 1 ORDER BY name').all());
});

app.get('/api/delivery-fee', (req, res) => {
  const p = parsePoint(req.query.lat, req.query.lng);
  if (!p) return bad(res, 'Position invalide.');
  // On ne renvoie pas la distance : elle permettrait de retrouver la position de la boutique.
  const { fee, outOfZone } = deliveryFee(getSettings(), p);
  res.json({ fee, outOfZone });
});

app.post('/api/orders', (req, res) => {
  const s = getSettings();
  const b = req.body || {};
  const name = str(b.name, 80);
  const phone = str(b.phone, 20).replace(/[\s.-]/g, '');
  const address = str(b.address, 300);
  const note = str(b.note, 500);
  const point = parsePoint(b.lat, b.lng);

  if (name.length < 2) return bad(res, 'Indiquez votre nom.');
  if (!/^\+?\d{8,15}$/.test(phone)) return bad(res, 'Numéro de téléphone invalide.');
  if (!point) return bad(res, 'Indiquez votre position de livraison sur la carte.');

  // Regroupe les lignes par produit
  const wanted = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const id = Number(it.productId);
    const q = Math.floor(Number(it.quantity));
    if (Number.isInteger(id) && q > 0) wanted.set(id, Math.min(99, (wanted.get(id) || 0) + q));
  }
  if (!wanted.size) return bad(res, 'Votre panier est vide.');

  const ids = [...wanted.keys()];
  const products = db
    .prepare(`SELECT * FROM products WHERE available = 1 AND id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  if (products.length !== ids.length) {
    return bad(res, 'Un produit de votre panier n\'est plus disponible. Rechargez la page.');
  }

  const lines = products.map((p) => ({
    product_id: p.id,
    name: p.name,
    unit: p.unit,
    unit_price: p.price,
    quantity: wanted.get(p.id),
    line_total: p.price * wanted.get(p.id)
  }));
  const subtotal = lines.reduce((a, l) => a + l.line_total, 0);
  const fee = deliveryFee(s, point);
  if (fee.outOfZone) return bad(res, `Désolé, vous êtes hors de notre zone de livraison (${s.max_km} km max).`);

  const code = newOrderCode();
  const chosen = availableSlots(s).find((x) => x.date === b.date && x.slot === b.slot);
  if (!chosen) return bad(res, 'Ce créneau de livraison n\'est plus disponible, choisissez-en un autre.');
  const deliveryDate = chosen.date;
  const total = subtotal + fee.fee;

  tx(() => {
    const r = db
      .prepare(`INSERT INTO orders (code, customer_name, phone, address, note, lat, lng, distance_km,
                subtotal, delivery_fee, total, status, delivery_date, slot, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nouvelle', ?, ?, ?)`)
      .run(code, name, phone, address, note, point.lat, point.lng, fee.distanceKm,
        subtotal, fee.fee, total, deliveryDate, chosen.slot, localDateTime());
    const ins = db.prepare(`INSERT INTO order_items (order_id, product_id, name, unit, unit_price, quantity, line_total)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const l of lines) ins.run(r.lastInsertRowid, l.product_id, l.name, l.unit, l.unit_price, l.quantity, l.line_total);
  });

  res.status(201).json({ code, subtotal, deliveryFee: fee.fee, total, deliveryDate, slot: chosen.slot, startHour: chosen.startHour });
});

// Suivi de commande (code + téléphone)
app.get('/api/orders/track', (req, res) => {
  const s = getSettings();
  const code = str(req.query.code, 12).toUpperCase();
  const phone = str(req.query.phone, 20).replace(/[\s.-]/g, '');
  const o = db.prepare('SELECT * FROM orders WHERE code = ? AND phone = ?').get(code, phone);
  if (!o) return bad(res, 'Commande introuvable. Vérifiez le code et le numéro.', 404);
  const [full] = attachItems([o]);
  res.json({
    code: full.code, status: full.status, deliveryDate: full.delivery_date,
    slot: full.slot, startHour: slotHour(s, full.slot),
    subtotal: full.subtotal, deliveryFee: full.delivery_fee, total: full.total,
    items: full.items.map((i) => ({ name: i.name, quantity: i.quantity, lineTotal: i.line_total }))
  });
});

// Service client : formulaire « Nous contacter »
const SUBJECTS = ['Question sur une commande', 'Problème de livraison', 'Produits et prix', 'Suggestion', 'Autre'];
const contactHits = new Map();
app.post('/api/messages', (req, res) => {
  const now = Date.now();
  const hits = (contactHits.get(req.ip) || []).filter((t) => now - t < 10 * 60e3);
  if (hits.length >= 5) return bad(res, 'Trop de messages envoyés. Réessayez dans quelques minutes ou appelez-nous.', 429);

  const b = req.body || {};
  const name = str(b.name, 80);
  const phone = str(b.phone, 20).replace(/[\s.-]/g, '');
  const subject = SUBJECTS.includes(b.subject) ? b.subject : 'Autre';
  const orderCode = str(b.orderCode, 12).toUpperCase();
  const message = str(b.message, 1500);
  if (name.length < 2) return bad(res, 'Indiquez votre nom.');
  if (!/^\+?\d{8,15}$/.test(phone)) return bad(res, 'Numéro de téléphone invalide.');
  if (message.length < 5) return bad(res, 'Écrivez votre message.');

  db.prepare('INSERT INTO messages (name, phone, subject, order_code, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, phone, subject, orderCode, message, localDateTime());
  hits.push(now); contactHits.set(req.ip, hits);
  res.status(201).json({ ok: true });
});

// ======================================================================
//  API ADMIN
// ======================================================================
const loginAttempts = new Map();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const SESSION_DAYS = 30;

// Mot de passe admin : celui choisi dans l'admin (haché en base) sinon celui du fichier .env
const PW_KEY = 'admin_password_hash';
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function checkPassword(pw) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PW_KEY);
  if (!row) return crypto.timingSafeEqual(sha(pw), sha(ADMIN_PASSWORD));
  const [salt, hash] = JSON.parse(row.value).split(':');
  const test = crypto.scryptSync(String(pw ?? ''), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return bad(res, 'Trop de tentatives, réessayez dans 15 minutes.', 429);

  if (!checkPassword(req.body?.password)) {
    a.n++; loginAttempts.set(ip, a);
    return bad(res, 'Mot de passe incorrect.', 401);
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, Date.now());
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const row = token && db.prepare('SELECT created_at FROM sessions WHERE token = ?').get(token);
  if (!row || Date.now() - row.created_at > SESSION_DAYS * 86400e3) return bad(res, 'Non connecté.', 401);
  req.token = token;
  next();
}
app.use('/api/admin', (req, res, next) => (req.path === '/login' ? next() : requireAdmin(req, res, next)));

// Changer le mot de passe admin depuis l'admin
const pwAttempts = new Map();
app.post('/api/admin/password', (req, res) => {
  const n = pwAttempts.get(req.token) || 0;
  if (n >= 5) return bad(res, 'Trop de tentatives. Déconnectez-vous puis reconnectez-vous.', 429);
  const { current, next } = req.body || {};
  if (!checkPassword(current)) {
    pwAttempts.set(req.token, n + 1);
    return bad(res, 'Mot de passe actuel incorrect.');
  }
  const pw = String(next || '');
  if (pw.length < 10) return bad(res, 'Le nouveau mot de passe doit faire au moins 10 caractères.');
  if (pw.length > 200) return bad(res, 'Mot de passe trop long.');
  if (checkPassword(pw)) return bad(res, "Le nouveau mot de passe doit être différent de l'ancien.");
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PW_KEY, JSON.stringify(hashPassword(pw)));
  // Déconnecte tous les autres appareils
  const out = db.prepare('DELETE FROM sessions WHERE token != ?').run(req.token).changes;
  pwAttempts.delete(req.token);
  res.json({ ok: true, otherSessionsClosed: out });
});

app.post('/api/admin/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

// ---------- Produits ----------
app.get('/api/admin/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY available DESC, name').all());
});

function readProduct(b) {
  const name = str(b.name, 80);
  const price = Math.round(Number(b.price));
  if (name.length < 2) throw new Error('Nom du produit requis.');
  if (!Number.isFinite(price) || price <= 0) throw new Error('Prix invalide.');
  return {
    name, price,
    description: str(b.description, 300),
    unit: str(b.unit, 30) || 'sachet',
    available: b.available === false || b.available === 0 ? 0 : 1
  };
}

app.post('/api/admin/products', (req, res) => {
  try {
    const p = readProduct(req.body || {});
    const image = req.body.imageData ? saveImage(req.body.imageData) : null;
    const r = db.prepare('INSERT INTO products (name, description, price, unit, image, available, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.name, p.description, p.price, p.unit, image, p.available, new Date().toISOString());
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid));
  } catch (e) { bad(res, e.message); }
});

app.put('/api/admin/products/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Produit introuvable.', 404);
  try {
    const p = readProduct({ ...cur, ...req.body });
    let image = cur.image;
    if (req.body.imageData) { image = saveImage(req.body.imageData); removeImage(cur.image); }
    if (req.body.removeImage) { removeImage(cur.image); image = null; }
    db.prepare('UPDATE products SET name=?, description=?, price=?, unit=?, image=?, available=? WHERE id=?')
      .run(p.name, p.description, p.price, p.unit, image, p.available, cur.id);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(cur.id));
  } catch (e) { bad(res, e.message); }
});

app.delete('/api/admin/products/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Produit introuvable.', 404);
  // Les lignes de commande gardent le nom et le prix : l'historique des ventes reste intact.
  db.prepare('DELETE FROM products WHERE id = ?').run(cur.id);
  removeImage(cur.image);
  res.json({ ok: true });
});

// ---------- Commandes ----------
app.get('/api/admin/orders', (req, res) => {
  const where = [];
  const args = [];
  if (isDate(req.query.date)) { where.push('delivery_date = ?'); args.push(req.query.date); }
  if (STATUSES.includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
  if (SLOTS.includes(req.query.slot)) { where.push('slot = ?'); args.push(req.query.slot); }
  if (req.query.status === 'actives') where.push(`status IN (${ACTIVE_STATUSES.map((x) => `'${x}'`).join(',')})`);
  const rows = db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                           ORDER BY delivery_date DESC, slot, created_at DESC LIMIT 500`).all(...args);
  res.json(attachItems(rows));
});

app.patch('/api/admin/orders/:id', (req, res) => {
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return bad(res, 'Statut invalide.');
  const r = db.prepare('UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?')
    .run(status, status === 'livree' ? localDateTime() : null, Number(req.params.id));
  if (!r.changes) return bad(res, 'Commande introuvable.', 404);
  res.json({ ok: true });
});

// ---------- Tournée de livraison optimisée ----------
app.get('/api/admin/route', (req, res) => {
  const s = getSettings();
  const date = isDate(req.query.date) ? req.query.date : localDate();
  const start =
    parsePoint(req.query.lat, req.query.lng) ||
    (s.shop_lat != null ? { lat: s.shop_lat, lng: s.shop_lng } : null);
  if (!start) return bad(res, 'Indiquez votre position (GPS, coordonnées ou clic sur la carte) ou enregistrez votre point de base dans Paramètres.');

  const slot = SLOTS.includes(req.query.slot) ? req.query.slot : 'matin';
  const orders = db.prepare(`SELECT * FROM orders WHERE delivery_date = ? AND slot = ? AND lat IS NOT NULL
                             AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
    .all(date, slot, ...ACTIVE_STATUSES);
  const ordered = planRoute(start, attachItems(orders));

  // Heure de départ : début du créneau, ou maintenant si on est déjà en tournée
  const now = new Date();
  const t = new Date(`${date}T${pad(slotHour(s, slot))}:00:00`);
  if (date === localDate(now) && now > t) t.setTime(now.getTime());

  let prev = start;
  let cumKm = 0;
  const stops = ordered.map((o, i) => {
    const leg = roadKm(prev, o);
    cumKm += leg;
    t.setMinutes(t.getMinutes() + Math.round((leg / s.speed_kmh) * 60));
    const eta = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    t.setMinutes(t.getMinutes() + s.minutes_per_stop);
    prev = o;
    return { seq: i + 1, ...o, legKm: Math.round(leg * 10) / 10, cumKm: Math.round(cumKm * 10) / 10, eta };
  });

  res.json({
    date, slot, start, stops,
    totalKm: Math.round(cumKm * 10) / 10,
    toCollect: stops.reduce((a, o) => a + o.total, 0),
    endTime: stops.length ? `${pad(t.getHours())}:${pad(t.getMinutes())}` : null
  });
});

// ---------- Statistiques de ventes ----------
app.get('/api/admin/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const from = new Date();
  from.setDate(from.getDate() - days + 1);
  const fromStr = localDate(from);
  const slots = availableSlots(getSettings());
  const toStr = slots[slots.length - 1].date;
  const W = `delivery_date BETWEEN ? AND ? AND status != 'annulee'`;
  const R = [fromStr, toStr];

  // Commandes détaillées récentes + totaux conservés des jours plus anciens
  const LIVE = `SELECT delivery_date AS day, slot, COUNT(*) AS orders, SUM(subtotal) AS sales, SUM(delivery_fee) AS fees,
      SUM(total) AS total, SUM(CASE WHEN status='livree' THEN total ELSE 0 END) AS collected
      FROM orders WHERE ${W} GROUP BY delivery_date, slot`;
  const SUMM = `SELECT day, slot, orders, sales, fees, total, collected FROM daily_summary WHERE day BETWEEN ? AND ?`;
  const ALL = `(${LIVE} UNION ALL ${SUMM})`;

  const totals = db.prepare(`SELECT COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(sales),0) AS sales,
      COALESCE(SUM(fees),0) AS fees, COALESCE(SUM(total),0) AS total, COALESCE(SUM(collected),0) AS collected FROM ${ALL}`)
    .get(...R, ...R);
  totals.customers = db.prepare(`SELECT COUNT(DISTINCT phone) AS n FROM orders WHERE ${W}`).get(...R).n;
  totals.avgBasket = totals.orders ? Math.round(totals.sales / totals.orders) : 0;

  const byDay = db.prepare(`SELECT day, SUM(orders) AS orders, SUM(sales) AS sales FROM ${ALL} GROUP BY day ORDER BY day`)
    .all(...R, ...R);
  const bySlot = db.prepare(`SELECT slot, SUM(orders) AS orders, SUM(total) AS total FROM ${ALL} GROUP BY slot`)
    .all(...R, ...R);

  const topProducts = db.prepare(`SELECT name, SUM(qty) AS qty, SUM(sales) AS sales FROM (
      SELECT oi.name, oi.quantity AS qty, oi.line_total AS sales FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.delivery_date BETWEEN ? AND ? AND o.status != 'annulee'
      UNION ALL SELECT name, qty, sales FROM product_summary WHERE day BETWEEN ? AND ?)
      GROUP BY name ORDER BY sales DESC LIMIT 10`).all(...R, ...R);

  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM orders
      WHERE delivery_date BETWEEN ? AND ? GROUP BY status`).all(...R);

  const topCustomers = db.prepare(`SELECT customer_name AS name, phone, COUNT(*) AS orders, SUM(total) AS total
      FROM orders WHERE ${W} GROUP BY phone ORDER BY total DESC LIMIT 5`).all(...R);

  res.json({ from: fromStr, to: toStr, totals, byDay, topProducts, byStatus, topCustomers, bySlot,
    retentionDays: getSettings().retention_days });
});

// ---------- Nettoyage des anciennes données ----------
app.post('/api/admin/purge', (req, res) => res.json(purgeOldData()));

// ---------- Messages du service client ----------
app.get('/api/admin/messages', (req, res) => {
  const filter = req.query.status === 'nouveau' ? "WHERE status = 'nouveau'" : '';
  const rows = db.prepare(`SELECT * FROM messages ${filter} ORDER BY id DESC LIMIT 300`).all();
  const unread = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'nouveau'").get().n;
  res.json({ unread, messages: rows });
});

app.patch('/api/admin/messages/:id', (req, res) => {
  const status = req.body?.status === 'traite' ? 'traite' : 'nouveau';
  const r = db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, Number(req.params.id));
  if (!r.changes) return bad(res, 'Message introuvable.', 404);
  res.json({ ok: true });
});

app.delete('/api/admin/messages/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Sauvegarde : copie complète de la base, téléchargeable ----------
app.get('/api/admin/backup', (req, res) => {
  const tmp = path.join(os.tmpdir(), `rummder-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  res.download(tmp, `rummder-sauvegarde-${localDate()}.db`, () => fs.rm(tmp, () => {}));
});

// ---------- Paramètres ----------
app.get('/api/admin/settings', (req, res) => res.json(getSettings()));

app.put('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in b)) continue;
    if (k === 'shop_name' || k === 'shop_phone') out[k] = str(b[k], 60);
    else if (k === 'country_code') {
      out[k] = String(b[k] ?? '').replace(/\D/g, '').slice(0, 4);
      if (!out[k]) return bad(res, 'Indicatif pays invalide.');
    }
    else if (b[k] === null && (k === 'shop_lat' || k === 'shop_lng')) out[k] = null;
    else {
      const n = Number(b[k]);
      if (!Number.isFinite(n) || (k !== 'shop_lat' && k !== 'shop_lng' && k !== 'default_lat' && k !== 'default_lng' && n < 0)) {
        return bad(res, `Valeur invalide pour ${k}.`);
      }
      out[k] = n;
    }
  }
  const merged = { ...getSettings(), ...out };
  if (merged.start_hour > 23 || merged.evening_start_hour > 23 || merged.cutoff_hour > 24 || merged.same_day_evening_cutoff > 23) {
    return bad(res, 'Heure invalide.');
  }
  if (merged.speed_kmh <= 0) return bad(res, 'Vitesse invalide.');
  if (merged.retention_days > 365) return bad(res, 'Durée de conservation : 365 jours maximum.');
  if (merged.retention_days > 0) merged.retention_days = out.retention_days = Math.floor(merged.retention_days);
  saveSettings(out);
  res.json(getSettings());
});

app.get('/admin', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, 'public', 'admin.html')));

// Nettoyage automatique : au démarrage puis toutes les 6 heures
function runPurge() {
  try {
    const r = purgeOldData();
    if (!r.skipped && (r.orders || r.messages || r.photos)) {
      console.log(`🧹 Nettoyage : ${r.orders} commande(s), ${r.messages} message(s), ${r.photos} photo(s) supprimés (avant le ${r.cutoff})`);
    }
  } catch (e) { console.error('Nettoyage impossible :', e.message); }
}
runPurge();
setInterval(runPurge, 6 * 3600e3).unref();

app.listen(PORT, HOST, () => {
  console.log(`Rummder en ligne : http://localhost:${PORT}  (admin : http://localhost:${PORT}/admin)`);
});
