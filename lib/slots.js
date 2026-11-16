// Créneaux de livraison (matin / soir) et dates.
export const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const SLOTS = ['matin', 'soir'];
export const slotHour = (s, slot) => (slot === 'soir' ? s.evening_start_hour : s.start_hour);

export function nextDeliveryDate(s, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + (now.getHours() >= s.cutoff_hour ? 2 : 1));
  return localDate(d);
}

// Règles des créneaux :
//  - MATIN : jamais le jour même. Pour demain matin, commander la veille avant cutoff_hour (24 = minuit).
//  - SOIR  : possible le jour même jusqu'à same_day_evening_cutoff (15h), ou les jours suivants.
// On propose au client les 3 prochains créneaux ouverts.
function slotOpen(s, offset, slot, now) {
  const h = now.getHours();
  if (slot === 'matin') return offset >= 2 || (offset === 1 && h < s.cutoff_hour);
  return offset >= 1 || h < s.same_day_evening_cutoff;
}

export function availableSlots(s, now = new Date()) {
  const out = [];
  for (let offset = 0; offset <= 2 && out.length < 3; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    for (const slot of SLOTS) {
      if (out.length < 3 && slotOpen(s, offset, slot, now)) {
        out.push({ date: localDate(d), slot, startHour: slotHour(s, slot), today: offset === 0, tomorrow: offset === 1 });
      }
    }
  }
  return out;
}
