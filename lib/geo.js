// Calculs géographiques : distance, frais de livraison, optimisation de tournée.

// Les routes ne sont pas en ligne droite : on applique un facteur moyen.
export const ROAD_FACTOR = 1.3;

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const roadKm = (a, b) => haversineKm(a, b) * ROAD_FACTOR;

/**
 * Frais de livraison : tarif unique. La distance depuis le point de base est
 * calculée pour l'admin et pour la limite de zone (max_km), si elle est définie.
 */
export function deliveryFee(s, point) {
  if (s.shop_lat == null || s.shop_lng == null) {
    return { fee: s.delivery_fee, distanceKm: null, outOfZone: false };
  }
  const d = roadKm({ lat: s.shop_lat, lng: s.shop_lng }, point);
  return {
    fee: s.delivery_fee,
    distanceKm: Math.round(d * 10) / 10,
    outOfZone: s.max_km > 0 && d > s.max_km
  };
}

/**
 * Ordonne les arrêts pour minimiser la distance totale, en partant de `start`
 * (position de l'admin / livreur). Trajet ouvert : on ne revient pas au départ.
 *  1) plus proche voisin  2) amélioration 2-opt
 */
export function planRoute(start, stops) {
  if (stops.length <= 1) return stops.slice();

  // 1. Plus proche voisin
  const remaining = stops.slice();
  const ordered = [];
  let cur = start;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineKm(cur, p);
      if (d < bestD) { bestD = d; best = i; }
    });
    cur = remaining.splice(best, 1)[0];
    ordered.push(cur);
  }

  // 2. 2-opt (le point 0 = départ est fixe, la fin est libre)
  const pts = [start, ...ordered];
  const n = pts.length;
  const d = (a, b) => haversineKm(pts[a], pts[b]);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const before = d(i - 1, i) + (k + 1 < n ? d(k, k + 1) : 0);
        const after = d(i - 1, k) + (k + 1 < n ? d(i, k + 1) : 0);
        if (after < before - 1e-9) {
          // inverse le segment i..k
          for (let a = i, b = k; a < b; a++, b--) [pts[a], pts[b]] = [pts[b], pts[a]];
          improved = true;
        }
      }
    }
  }
  return pts.slice(1);
}
