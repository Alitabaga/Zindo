// Mot de passe admin oublié ?
// Usage : npm run reset-password
// Supprime le mot de passe choisi dans l'admin : le mot de passe du fichier .env (ADMIN_PASSWORD) redevient valable.
// Toutes les sessions sont fermées.
import { db } from './lib/db.js';

const removed = db.prepare("DELETE FROM settings WHERE key = 'admin_password_hash'").run().changes;
const sessions = db.prepare('DELETE FROM sessions').run().changes;
console.log(removed
  ? '✅ Mot de passe réinitialisé : utilisez maintenant celui du fichier .env (ADMIN_PASSWORD).'
  : "ℹ️ Aucun mot de passe personnalisé : c'est déjà celui du fichier .env qui s'applique.");
console.log(`   ${sessions} session(s) fermée(s). Redémarrez le site si besoin.`);
