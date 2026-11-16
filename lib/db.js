import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'zindo.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price INTEGER NOT NULL,
    unit TEXT DEFAULT 'sachet',
    image TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT DEFAULT '',
    note TEXT DEFAULT '',
    lat REAL,
    lng REAL,
    distance_km REAL,
    subtotal INTEGER NOT NULL,
    delivery_fee INTEGER NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'nouvelle',
    delivery_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(delivery_date);

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER,
    name TEXT NOT NULL,
    unit TEXT,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    line_total INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    subject TEXT NOT NULL,
    order_code TEXT DEFAULT '',
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'nouveau',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migration : créneau de livraison (matin / soir)
if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'slot')) {
  db.exec(`ALTER TABLE orders ADD COLUMN slot TEXT NOT NULL DEFAULT 'matin'`);
}

export const DEFAULT_SETTINGS = {
  shop_name: 'Zindo',
  shop_phone: '',        // numéro WhatsApp de la boutique
  country_code: '226',   // indicatif pays (Burkina Faso)
  shop_lat: null,        // position de départ (boutique / cuisine)
  shop_lng: null,
  default_lat: 12.3714,  // centre de carte par défaut si la boutique n'est pas encore placée
  default_lng: -1.5197,
  delivery_fee: 250,     // frais de livraison (tarif unique)
  max_km: 0,             // distance max acceptée (0 = pas de limite)
  cutoff_hour: 24,       // heure limite (la veille) pour être livré le lendemain matin (24 = minuit)
  start_hour: 7,         // début de la tournée du matin
  evening_start_hour: 16,// début de la tournée du soir
  same_day_evening_cutoff: 15, // commandes acceptées pour le soir même jusqu'à cette heure
  minutes_per_stop: 8,   // temps passé à chaque arrêt
  speed_kmh: 25          // vitesse moyenne (moto)
};

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in DEFAULT_SETTINGS) s[row.key] = JSON.parse(row.value);
  }
  return s;
}

export function saveSettings(obj) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(obj)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  }
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Quelques produits d'exemple au premier lancement (supprimables depuis l'admin)
if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT INTO products (name, description, price, unit, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  [
    ['Gombo coupé', 'Gombo frais lavé et coupé, prêt pour la sauce', 500, 'sachet'],
    ['Feuilles d\'oseille lavées', 'Triées, lavées et égouttées', 300, 'botte'],
    ['Épinards hachés', 'Lavés et finement hachés', 400, 'sachet'],
    ['Mix légumes sauce', 'Tomate, oignon, poivron, aubergine découpés', 1000, 'barquette'],
    ['Aubergines coupées', 'Aubergines locales en morceaux', 500, 'sachet'],
    ['Oignons émincés', 'Oignons épluchés et émincés', 300, 'sachet']
  ].forEach((p) => ins.run(...p, now));
}
