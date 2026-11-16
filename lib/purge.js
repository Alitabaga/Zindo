// Nettoyage automatique : supprime les données de plus de N jours.
// Conservé : produits, photos utilisées, paramètres, mot de passe admin,
// commandes à venir, et les TOTAUX de ventes par jour (sans données personnelles).
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, getSettings, UPLOAD_DIR } from './db.js';
import { localDate } from './slots.js';

export function purgeOldData(days = getSettings().retention_days) {
  days = Math.floor(Number(days));
  if (!days || days < 1) return { skipped: true };
  const d = new Date();
  d.setDate(d.getDate() - days);
  const cutoff = localDate(d); // tout ce qui est strictement avant cette date

  const r = tx(() => {
    // 1. On garde les totaux (par jour et par créneau) avant de supprimer le détail
    db.prepare(`INSERT INTO daily_summary (day, slot, orders, sales, fees, total, collected)
      SELECT delivery_date, slot, COUNT(*), SUM(subtotal), SUM(delivery_fee), SUM(total),
             SUM(CASE WHEN status = 'livree' THEN total ELSE 0 END)
      FROM orders WHERE delivery_date < ? AND status != 'annulee'
      GROUP BY delivery_date, slot
      ON CONFLICT(day, slot) DO UPDATE SET orders = orders + excluded.orders, sales = sales + excluded.sales,
        fees = fees + excluded.fees, total = total + excluded.total, collected = collected + excluded.collected`).run(cutoff);
    db.prepare(`INSERT INTO product_summary (day, name, qty, sales)
      SELECT o.delivery_date, oi.name, SUM(oi.quantity), SUM(oi.line_total)
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.delivery_date < ? AND o.status != 'annulee'
      GROUP BY o.delivery_date, oi.name
      ON CONFLICT(day, name) DO UPDATE SET qty = qty + excluded.qty, sales = sales + excluded.sales`).run(cutoff);

    // 2. Suppression du détail
    const old = db.prepare('SELECT id FROM orders WHERE delivery_date < ?').all(cutoff).map((o) => o.id);
    for (const id of old) db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    const orders = db.prepare('DELETE FROM orders WHERE delivery_date < ?').run(cutoff).changes;
    const messages = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes;
    const sessions = db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - 30 * 86400e3).changes;
    return { orders, messages, sessions };
  });

  // 3. Photos qui ne servent plus à aucun produit (plus d'un jour, pour ne pas gêner un envoi en cours)
  const used = new Set(db.prepare('SELECT image FROM products WHERE image IS NOT NULL').all().map((p) => path.basename(p.image)));
  let photos = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.join(UPLOAD_DIR, f);
    if (!used.has(f) && Date.now() - fs.statSync(full).mtimeMs > 86400e3) { fs.rmSync(full); photos++; }
  }

  // 4. Récupère la place sur le disque
  if (r.orders || r.messages) db.exec('VACUUM');
  return { cutoff, days, ...r, photos };
}
