// ===== Zindo — administration =====
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR') + ' F';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d + 'T00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const STATUS = { nouvelle: 'Nouvelle', confirmee: 'Confirmée', en_livraison: 'En livraison', livree: 'Livrée', annulee: 'Annulée' };
const SLOT = { matin: '🌅 Matin', soir: '🌇 Soir' };
const slotHour = (slot) => (slot === 'soir' ? settings?.evening_start_hour ?? 16 : settings?.start_hour ?? 7);
const gmaps = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

let token = localStorage.getItem('zindo_admin_token');
let settings = null;

// ---------- WhatsApp (liens wa.me : ouvre WhatsApp avec le message pré-rempli) ----------
function intlPhone(phone, cc) {
  const raw = String(phone || '').trim();
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  // Burkina : numéros à 8 chiffres, le 0 initial fait partie du numéro (ex. 05 04 00 40)
  if (d.length <= 8) return cc + d;
  if (d.startsWith(cc)) return d;
  return cc + d.replace(/^0+/, '');
}
const waLink = (phone, text) => `https://wa.me/${intlPhone(phone, settings?.country_code || '226')}?text=${encodeURIComponent(text)}`;
const shopName = () => settings?.shop_name || 'Zindo';
const itemsText = (o) => o.items.map((i) => `• ${i.quantity} × ${i.name}`).join('\n');
const WA = {
  confirm: (o) =>
    `Bonjour ${o.customer_name}, ici ${shopName()} 🥬\n` +
    `Votre commande ${o.code} est bien reçue ✅\n${itemsText(o)}\n` +
    `Total à payer à la livraison : ${fmt(o.total)} (livraison incluse).\n` +
    `Livraison ${fmtDate(o.delivery_date)} ${o.slot === 'soir' ? 'soir' : 'matin'}, à partir de ${slotHour(o.slot)}h. Merci !`,
  enRoute: (o) =>
    `Bonjour ${o.customer_name}, votre livreur ${shopName()} est en route 🛵` +
    (o.eta ? `\nArrivée prévue vers ${o.eta}.` : '') +
    `\nMontant à prévoir : ${fmt(o.total)}. À tout de suite !`,
  thanks: (o) => `Merci ${o.customer_name} pour votre commande ${shopName()} ! Bonne cuisine et à bientôt 🥬`
};
const waButtons = (o, kinds) => kinds.map(([k, label]) =>
  `<a class="btn secondary small" style="flex:0 0 auto" target="_blank" rel="noopener" href="${esc(waLink(o.phone, WA[k](o)))}"
      data-wa="${k}" data-order="${o.id}" data-cur="${o.status}">${label}</a>`).join('');

// Envoyer « confirmation » / « en route » met aussi à jour le statut
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-wa]');
  if (!a) return;
  const next = { confirm: a.dataset.cur === 'nouvelle' ? 'confirmee' : null, enRoute: ['nouvelle', 'confirmee'].includes(a.dataset.cur) ? 'en_livraison' : null }[a.dataset.wa];
  if (next) {
    api(`/api/admin/orders/${a.dataset.order}`, { method: 'PATCH', body: JSON.stringify({ status: next }) })
      .then(() => setTimeout(() => loaders[currentTab]?.(), 800)).catch(() => {});
  }
});

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Session expirée'); }
  if (!r.ok) throw new Error(data.error || 'Erreur');
  return data;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Géolocalisation indisponible sur cet appareil.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('Position refusée ou indisponible. Autorisez la localisation (le site doit être en HTTPS).')),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

// Lit « 12.3714, -1.5197 », « 12.3714 -1.5197 » ou un lien Google Maps (…@12.37,-1.52,15z / ?q=12.37,-1.52)
function parseCoords(text) {
  const m = /(-?\d{1,2}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)/.exec(String(text || '').replace(/%2C/gi, ','));
  if (!m) return null;
  const lat = Number(m[1]); const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function makeMap(id, center, zoom = 13) {
  const m = L.map(id).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
  return m;
}
const numIcon = (n, cls = '') => L.divIcon({ className: `num-marker ${cls}`, html: String(n), iconSize: [28, 28] });

// ---------- connexion ----------
function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#pwd').value }) });
    token = r.token; localStorage.setItem('zindo_admin_token', token);
    $('#pwd').value = '';
    start();
  } catch (err) { $('#loginError').textContent = err.message; }
};
$('#logoutBtn2').onclick = () => $('#logoutBtn').click();
$('#logoutBtn').onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('zindo_admin_token'); token = null; showLogin();
};

// ---------- onglets ----------
const loaders = {};
let currentTab = 'orders';
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
function openTab(tab) {
  currentTab = tab;
  window.scrollTo({ top: 0 });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  loaders[tab]?.();
}

// ======================================================================
//  COMMANDES
// ======================================================================
async function loadOrders() {
  const date = $('#oDate').value;
  const status = $('#oStatus').value;
  const slot = $('#oSlot').value;
  const orders = await api(`/api/admin/orders?date=${date}&status=${status}&slot=${slot}`);

  // Résumé + quantités à préparer pour la journée
  const valid = orders.filter((o) => o.status !== 'annulee');
  const prep = {};
  for (const o of valid) for (const i of o.items) {
    prep[i.name] ??= { qty: 0, unit: i.unit };
    prep[i.name].qty += i.quantity;
  }
  $('#oSummary').innerHTML = `
    <div class="row" style="align-items:flex-start">
      <div><div class="muted">Commandes</div><b style="font-size:1.4rem">${valid.length}</b></div>
      <div><div class="muted">Produits</div><b style="font-size:1.4rem">${fmt(valid.reduce((a, o) => a + o.subtotal, 0))}</b></div>
      <div><div class="muted">Livraisons</div><b style="font-size:1.4rem">${fmt(valid.reduce((a, o) => a + o.delivery_fee, 0))}</b></div>
      <div><div class="muted">Total à encaisser</div><b style="font-size:1.4rem">${fmt(valid.reduce((a, o) => a + o.total, 0))}</b></div>
    </div>
    ${Object.keys(prep).length ? `<h4 style="margin:1rem 0 .3rem">🔪 À préparer</h4>
      <div>${Object.entries(prep).sort((a, b) => b[1].qty - a[1].qty)
        .map(([n, p]) => `<span class="status st-confirmee" style="margin:2px">${p.qty} × ${esc(n)}${p.unit ? ` (${esc(p.unit)})` : ''}</span>`).join(' ')}</div>` : ''}`;

  $('#oList').innerHTML = orders.length ? orders.map(orderCard).join('') : '<p class="muted panel">Aucune commande pour ce filtre.</p>';
}

function orderCard(o) {
  return `<div class="order">
    <div class="order-head">
      <div><b>${esc(o.customer_name)}</b> · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>
        <div class="muted">${esc(o.code)} · commandé le ${esc(o.created_at)} · livraison ${esc(fmtDate(o.delivery_date))}</div></div>
      <span><span class="status st-confirmee">${SLOT[o.slot]} · ${slotHour(o.slot)}h</span> <span class="status st-${o.status}">${STATUS[o.status]}</span></span>
    </div>
    ${o.address ? `<div>📍 ${esc(o.address)}</div>` : ''}
    ${o.note ? `<div>📝 ${esc(o.note)}</div>` : ''}
    <ul>${o.items.map((i) => `<li>${i.quantity} × ${esc(i.name)} — ${fmt(i.line_total)}</li>`).join('')}</ul>
    <div>Produits ${fmt(o.subtotal)} + livraison ${fmt(o.delivery_fee)}${o.distance_km != null ? ` (≈${o.distance_km} km)` : ''} = <b>${fmt(o.total)}</b></div>
    <div class="row" style="margin-top:.6rem">
      <select data-status="${o.id}" style="max-width:200px">
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      ${o.lat != null ? `<a class="btn secondary small" style="flex:0 0 auto" href="${gmaps(o.lat, o.lng)}" target="_blank">🗺 Itinéraire</a>` : ''}
    </div>
    <div class="row" style="margin-top:.4rem">
      ${waButtons(o, [['confirm', '💬 Confirmer sur WhatsApp'], ['enRoute', '💬 En route'], ['thanks', '💬 Merci']])}
    </div>
  </div>`;
}

document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  try {
    await api(`/api/admin/orders/${sel.dataset.status}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
    toast('Statut mis à jour');
    loaders[currentTab]?.();
  } catch (err) { toast(err.message); }
});
$('#oDate').onchange = loadOrders;
$('#oStatus').onchange = loadOrders;
$('#oSlot').onchange = loadOrders;
$('#oRefresh').onclick = loadOrders;
loaders.orders = loadOrders;

// ======================================================================
//  TOURNÉE
// ======================================================================
let rMap, rLayer, lastStart = null;

async function loadRoute(start) {
  if (start !== undefined) lastStart = start;
  const q = new URLSearchParams({ date: $('#rDate').value, slot: $('#rSlot').value });
  if (lastStart) { q.set('lat', lastStart.lat); q.set('lng', lastStart.lng); }
  let r;
  try { r = await api(`/api/admin/route?${q}`); }
  catch (err) { $('#rInfo').textContent = '⚠️ ' + err.message; return; }

  $('#rInfo').textContent = `Départ : ${lastStart ? 'le point choisi' : 'votre point de base'} · ${fmtDate(r.date)} · ${SLOT[r.slot]} dès ${slotHour(r.slot)}h · touchez la carte pour changer de point de départ.`;
  if (!r.stops.length) {
    $('#rSummary').innerHTML = `<p class="panel muted">Aucune livraison en attente pour ce créneau (${SLOT[r.slot]}).</p>`;
    $('#rStops').innerHTML = '';
    ensureRouteMap(r.start);
    rLayer?.remove();
    rLayer = L.layerGroup().addTo(rMap);
    L.marker([r.start.lat, r.start.lng], { icon: numIcon('D', 'start-marker') }).addTo(rLayer).bindPopup('Départ');
    rMap.setView([r.start.lat, r.start.lng], 14);
    return;
  }

  // Liens Google Maps pour toute la tournée (max 9 étapes intermédiaires par lien)
  const links = [];
  let from = r.start;
  for (let i = 0; i < r.stops.length; i += 10) {
    const chunk = r.stops.slice(i, i + 10);
    const dest = chunk[chunk.length - 1];
    const way = chunk.slice(0, -1).map((s) => `${s.lat},${s.lng}`).join('|');
    links.push(`https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${dest.lat},${dest.lng}` +
      (way ? `&waypoints=${encodeURIComponent(way)}` : '') + '&travelmode=driving');
    from = dest;
  }

  $('#rSummary').innerHTML = `<div class="kpis">
    <div class="kpi"><div class="muted">Arrêts</div><div class="v">${r.stops.length}</div></div>
    <div class="kpi"><div class="muted">Distance estimée</div><div class="v">${r.totalKm} km</div></div>
    <div class="kpi"><div class="muted">Fin estimée</div><div class="v">${r.endTime}</div></div>
    <div class="kpi"><div class="muted">À encaisser</div><div class="v">${fmt(r.toCollect)}</div></div>
  </div>
  <div class="panel row">
    ${links.map((l, i) => `<a class="btn" target="_blank" href="${l}" style="flex:0 0 auto">🧭 Ouvrir la tournée dans Google Maps${links.length > 1 ? ` (partie ${i + 1})` : ''}</a>`).join('')}
    <button class="btn secondary" id="rStartAll" style="flex:0 0 auto">🛵 Passer tout « en livraison »</button>
  </div>`;

  $('#rStops').innerHTML = r.stops.map((s) => `<div class="stop">
    <div class="num">${s.seq}</div>
    <div class="info">
      <div class="order-head"><b>${esc(s.customer_name)}</b><span><b>~${s.eta}</b> <span class="status st-${s.status}">${STATUS[s.status]}</span></span></div>
      <div><a href="tel:${esc(s.phone)}">📞 ${esc(s.phone)}</a> · +${s.legKm} km (cumul ${s.cumKm} km)</div>
      ${s.address ? `<div>📍 ${esc(s.address)}</div>` : ''}
      ${s.note ? `<div>📝 ${esc(s.note)}</div>` : ''}
      <div class="muted">${s.items.map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ')}</div>
      <div>À encaisser : <b>${fmt(s.total)}</b></div>
      <div class="row" style="margin-top:.5rem">
        <a class="btn secondary small" style="flex:0 0 auto" target="_blank" href="${gmaps(s.lat, s.lng)}">🗺 Itinéraire</a>
        ${waButtons(s, [['enRoute', '💬 Prévenir (en route)']])}
        <button class="btn small" style="flex:0 0 auto" data-delivered="${s.id}">✅ Livrée</button>
      </div>
    </div></div>`).join('');

  // Carte
  ensureRouteMap(r.start);
  rLayer?.remove();
  rLayer = L.layerGroup().addTo(rMap);
  L.marker([r.start.lat, r.start.lng], { icon: numIcon('D', 'start-marker') }).addTo(rLayer).bindPopup('Départ');
  for (const s of r.stops) {
    L.marker([s.lat, s.lng], { icon: numIcon(s.seq) }).addTo(rLayer)
      .bindPopup(`<b>${s.seq}. ${esc(s.customer_name)}</b><br>${esc(s.address)}<br>~${s.eta} · ${fmt(s.total)}`);
  }
  const line = [[r.start.lat, r.start.lng], ...r.stops.map((s) => [s.lat, s.lng])];
  L.polyline(line, { color: '#2f7d32', weight: 3, dashArray: '6 6' }).addTo(rLayer);
  rMap.fitBounds(line, { padding: [30, 30] });

  $('#rStartAll').onclick = async () => {
    for (const s of r.stops.filter((x) => x.status !== 'en_livraison')) {
      await api(`/api/admin/orders/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'en_livraison' }) });
    }
    toast('Tournée démarrée'); loadRoute();
  };
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-delivered]');
  if (!b) return;
  await api(`/api/admin/orders/${b.dataset.delivered}`, { method: 'PATCH', body: JSON.stringify({ status: 'livree' }) });
  toast('Commande livrée ✅');
  // Recalcule la suite de la tournée depuis la position actuelle si possible
  getPosition().then((p) => loadRoute(p)).catch(() => loadRoute());
});

$('#rFromMe').onclick = async () => {
  $('#rInfo').textContent = '⏳ Récupération de votre position…';
  try { loadRoute(await getPosition()); } catch (err) { $('#rInfo').textContent = '⚠️ ' + err.message; }
};
$('#rFromShop').onclick = () => loadRoute(null);
$('#rCoordsBtn').onclick = () => {
  const p = parseCoords($('#rCoords').value);
  if (!p) { $('#rInfo').textContent = '⚠️ Coordonnées non reconnues. Exemple : 12.3714, -1.5197'; return; }
  loadRoute(p);
};
$('#rDate').onchange = () => loadRoute();
$('#rSlot').onchange = () => loadRoute();

function ensureRouteMap(center) {
  if (!rMap) {
    rMap = makeMap('rMap', center);
    rMap.on('click', (e) => loadRoute({ lat: e.latlng.lat, lng: e.latlng.lng }));
  }
  setTimeout(() => rMap.invalidateSize(), 50);
}
loaders.route = () => {
  ensureRouteMap(settings.shop_lat != null ? { lat: settings.shop_lat, lng: settings.shop_lng } : { lat: settings.default_lat, lng: settings.default_lng });
  if (lastStart || settings.shop_lat != null) loadRoute();
};

// ======================================================================
//  PRODUITS
// ======================================================================
let productsCache = [];

async function loadProducts() {
  productsCache = await api('/api/admin/products');
  $('#pList').innerHTML = productsCache.length ? productsCache.map((p) => `<div class="prod-row">
    <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="">` : '🥬'}</div>
    <div class="info"><b>${esc(p.name)}</b> ${p.available ? '' : '<span class="status st-annulee">Masqué</span>'}
      <div class="muted">${fmt(p.price)} / ${esc(p.unit)}${p.description ? ' · ' + esc(p.description) : ''}</div></div>
    <div class="row" style="flex:0 0 auto">
      <button class="btn secondary small" data-toggle="${p.id}">${p.available ? 'Masquer' : 'Afficher'}</button>
      <button class="btn secondary small" data-edit="${p.id}">Modifier</button>
      <button class="btn danger small" data-del="${p.id}">Supprimer</button>
    </div></div>`).join('') : '<p class="muted">Aucun produit.</p>';
}

function resetProductForm() {
  $('#pForm').reset(); $('#pId').value = ''; $('#pAvailable').checked = true;
  $('#pFormTitle').textContent = 'Ajouter un produit';
  $('#pCancel').classList.add('hidden'); $('#pError').textContent = '';
}

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  // Redimensionne la photo (max 900 px) pour qu'elle charge vite sur mobile
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 900 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    resolve(c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = () => reject(new Error('Image illisible.'));
  img.src = URL.createObjectURL(file);
});

$('#pForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#pError').textContent = '';
  const id = $('#pId').value;
  const body = {
    name: $('#pName').value, price: Number($('#pPrice').value), unit: $('#pUnit').value,
    description: $('#pDesc').value, available: $('#pAvailable').checked
  };
  try {
    const f = $('#pImage').files[0];
    if (f) body.imageData = await fileToDataUrl(f);
    await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    toast(id ? 'Produit modifié' : 'Produit ajouté');
    resetProductForm(); loadProducts();
  } catch (err) { $('#pError').textContent = err.message; }
};
$('#pCancel').onclick = resetProductForm;

$('#pList').onclick = async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const p = productsCache.find((x) => x.id === Number(t.dataset.edit || t.dataset.del || t.dataset.toggle));
  if (!p) return;
  if (t.dataset.edit) {
    $('#pId').value = p.id; $('#pName').value = p.name; $('#pPrice').value = p.price;
    $('#pUnit').value = p.unit; $('#pDesc').value = p.description; $('#pAvailable').checked = !!p.available;
    $('#pFormTitle').textContent = `Modifier « ${p.name} »`;
    $('#pCancel').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (t.dataset.del) {
    if (!confirm(`Supprimer définitivement « ${p.name} » ? (l'historique des ventes est conservé)`)) return;
    await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
    toast('Produit supprimé'); loadProducts();
  } else if (t.dataset.toggle) {
    await api(`/api/admin/products/${p.id}`, { method: 'PUT', body: JSON.stringify({ available: !p.available }) });
    loadProducts();
  }
};
loaders.products = loadProducts;

// ======================================================================
//  VENTES
// ======================================================================
async function loadStats() {
  const s = await api(`/api/admin/stats?days=${$('#sDays').value}`);
  const t = s.totals;
  $('#sKpis').innerHTML = [
    ['Chiffre d\'affaires produits', fmt(t.sales)],
    ['Frais de livraison', fmt(t.fees)],
    ['Total facturé', fmt(t.total)],
    ['Déjà encaissé (livré)', fmt(t.collected)],
    ['Commandes', t.orders],
    ['Panier moyen', fmt(t.avgBasket)],
    ['Clients différents', t.customers],
    ...['matin', 'soir'].map((k) => {
      const x = s.bySlot.find((b) => b.slot === k) || { orders: 0, total: 0 };
      return [`Livraisons ${SLOT[k]}`, `${x.orders} <span class="muted" style="font-size:.85rem">· ${fmt(x.total)}</span>`];
    })
  ].map(([k, v]) => `<div class="kpi"><div class="muted">${k}</div><div class="v">${v}</div></div>`).join('');

  const max = Math.max(1, ...s.byDay.map((d) => d.sales));
  $('#sChart').innerHTML = s.byDay.length
    ? `<div class="bars">${s.byDay.map((d) => `<div class="bar" style="height:${(d.sales / max) * 100}%"
         title="${fmtDate(d.day)} : ${fmt(d.sales)} (${d.orders} cmd)"></div>`).join('')}</div>
       <div class="bar-labels">${s.byDay.map((d) => `<span>${d.day.slice(8)}/${d.day.slice(5, 7)}</span>`).join('')}</div>`
    : '<p class="muted">Pas encore de ventes sur la période.</p>';

  $('#sTop').innerHTML = s.topProducts.length
    ? `<table><tr><th>Produit</th><th>Qté</th><th>Ventes</th></tr>${s.topProducts.map((p) =>
        `<tr><td>${esc(p.name)}</td><td>${p.qty}</td><td>${fmt(p.sales)}</td></tr>`).join('')}</table>`
    : '<p class="muted">—</p>';
  $('#sCustomers').innerHTML = s.topCustomers.length
    ? `<table><tr><th>Client</th><th>Cmd</th><th>Total</th></tr>${s.topCustomers.map((c) =>
        `<tr><td>${esc(c.name)}<div class="muted">${esc(c.phone)}</div></td><td>${c.orders}</td><td>${fmt(c.total)}</td></tr>`).join('')}</table>`
    : '<p class="muted">—</p>';
}
$('#sDays').onchange = loadStats;
loaders.stats = loadStats;

// ======================================================================
//  PARAMÈTRES
// ======================================================================
const TEXT_FIELDS = ['shop_name', 'shop_phone', 'country_code'];
const SET_FIELDS = ['shop_name', 'shop_phone', 'country_code', 'delivery_fee', 'max_km',
  'start_hour', 'evening_start_hour', 'same_day_evening_cutoff', 'cutoff_hour', 'minutes_per_stop', 'speed_kmh'];
let setMap, shopMarker, shopPoint = null;

function placeShop(lat, lng) {
  shopPoint = { lat, lng };
  if (!shopMarker) shopMarker = L.marker([lat, lng], { icon: numIcon('🏠', 'start-marker') }).addTo(setMap);
  else shopMarker.setLatLng([lat, lng]);
  $('#shopPos').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}


async function loadSettings() {
  settings = await api('/api/admin/settings');
  for (const k of SET_FIELDS) $('#s_' + k).value = settings[k];
  const center = settings.shop_lat != null ? { lat: settings.shop_lat, lng: settings.shop_lng } : { lat: settings.default_lat, lng: settings.default_lng };
  if (!setMap) {
    setMap = makeMap('setMap', center, 14);
    setMap.on('click', (e) => placeShop(e.latlng.lat, e.latlng.lng));
  }
  setTimeout(() => setMap.invalidateSize(), 50);
  if (settings.shop_lat != null) placeShop(settings.shop_lat, settings.shop_lng);
  else $('#shopPos').textContent = 'Point de base non défini : la tournée partira de votre position du moment.';
}

$('#shopCoordsBtn').onclick = () => {
  const p = parseCoords($('#shopCoords').value);
  if (!p) { toast('Coordonnées non reconnues. Exemple : 12.3714, -1.5197'); return; }
  setMap.setView([p.lat, p.lng], 16); placeShop(p.lat, p.lng);
};

$('#setShopHere').onclick = async () => {
  try { const p = await getPosition(); setMap.setView([p.lat, p.lng], 16); placeShop(p.lat, p.lng); }
  catch (err) { toast(err.message); }
};

$('#setForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#setError').textContent = '';
  const body = {};
  for (const k of SET_FIELDS) body[k] = TEXT_FIELDS.includes(k) ? $('#s_' + k).value : Number($('#s_' + k).value);
  if (shopPoint) { body.shop_lat = shopPoint.lat; body.shop_lng = shopPoint.lng; }
  try { settings = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) }); toast('Paramètres enregistrés'); }
  catch (err) { $('#setError').textContent = err.message; }
};
loaders.settings = loadSettings;

$('#backupBtn').onclick = async () => {
  const b = $('#backupBtn');
  b.disabled = true;
  try {
    const r = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error('Sauvegarde impossible');
    const name = (/filename="?([^"]+)"?/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'zindo-sauvegarde.db';
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Sauvegarde téléchargée ✅');
  } catch (err) { toast(err.message); }
  finally { b.disabled = false; }
};

// ======================================================================
//  MESSAGES (service client)
// ======================================================================
function setMsgBadge(n) {
  $('#msgBadge').textContent = n;
  $('#msgBadge').classList.toggle('hidden', !n);
}

async function loadMessages() {
  const r = await api(`/api/admin/messages?status=${$('#msgFilter').value}`);
  setMsgBadge(r.unread);
  $('#msgList').innerHTML = r.messages.length ? r.messages.map((m) => {
    const reply = `Bonjour ${m.name}, ici ${shopName()}. Suite à votre message${m.order_code ? ` (commande ${m.order_code})` : ''} : `;
    return `<div class="order ${m.status === 'traite' ? 'msg-done' : ''}">
      <div class="order-head">
        <div><b>${esc(m.name)}</b> · <a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>
          <div class="muted">${esc(m.created_at)} · ${esc(m.subject)}${m.order_code ? ` · commande <b>${esc(m.order_code)}</b>` : ''}</div></div>
        <span class="status ${m.status === 'traite' ? 'st-livree' : 'st-nouvelle'}">${m.status === 'traite' ? 'Traité' : 'À traiter'}</span>
      </div>
      <p class="msg-text">${esc(m.message)}</p>
      <div class="row">
        <a class="btn secondary small" style="flex:0 0 auto" href="tel:${esc(m.phone)}">📞 Appeler</a>
        <a class="btn secondary small" style="flex:0 0 auto" target="_blank" rel="noopener" href="${esc(waLink(m.phone, reply))}">💬 Répondre sur WhatsApp</a>
        ${m.order_code ? `<button class="btn secondary small" style="flex:0 0 auto" data-find-order="${esc(m.order_code)}">🧾 Voir la commande</button>` : ''}
        <button class="btn small" style="flex:0 0 auto" data-msg="${m.id}" data-next="${m.status === 'traite' ? 'nouveau' : 'traite'}">${m.status === 'traite' ? '↩ Rouvrir' : '✓ Marquer traité'}</button>
        <button class="btn danger small" style="flex:0 0 auto" data-msg-del="${m.id}">Supprimer</button>
      </div>
    </div>`;
  }).join('') : '<p class="panel muted">Aucun message pour le moment. 🎉</p>';
}

$('#msgList').onclick = async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.msg) {
    await api(`/api/admin/messages/${t.dataset.msg}`, { method: 'PATCH', body: JSON.stringify({ status: t.dataset.next }) });
    loadMessages();
  } else if (t.dataset.msgDel) {
    if (!confirm('Supprimer ce message ?')) return;
    await api(`/api/admin/messages/${t.dataset.msgDel}`, { method: 'DELETE' });
    loadMessages();
  } else if (t.dataset.findOrder) {
    // ouvre l'onglet Commandes sur toutes les dates pour retrouver la commande
    $('#oDate').value = ''; $('#oStatus').value = ''; $('#oSlot').value = '';
    openTab('orders');
    setTimeout(() => {
      const card = [...document.querySelectorAll('#oList .order')].find((c) => c.textContent.includes(t.dataset.findOrder));
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('flash'); }
      else toast('Commande introuvable');
    }, 600);
  }
};
$('#msgFilter').onchange = loadMessages;
$('#msgRefresh').onclick = loadMessages;
loaders.messages = loadMessages;

// Compteur de nouveaux messages, rafraîchi chaque minute
async function refreshMsgBadge() {
  try { const r = await api('/api/admin/messages?status=nouveau'); setMsgBadge(r.unread); } catch {}
}
setInterval(() => { if (token && !$('#app').classList.contains('hidden')) refreshMsgBadge(); }, 60000);

// ---------- démarrage ----------
async function start() {
  try { settings = await api('/api/admin/settings'); } catch { return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
  // Par défaut : les commandes de demain (on prend les commandes la veille)
  const cfg = await fetch('/api/config').then((r) => r.json());
  $('#oDate').value = cfg.slots[0].date; // prochain créneau à préparer
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // Le matin de la tournée, on livre les commandes du jour
  $('#rDate').value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  $('#rSlot').value = today.getHours() < 13 ? 'matin' : 'soir';
  openTab('orders');
  refreshMsgBadge();
  if (settings.shop_lat == null) toast('Pensez à définir votre point de base dans Paramètres');
}

if (token) start(); else showLogin();
