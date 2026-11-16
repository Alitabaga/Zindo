// ===== Zindo — côté client =====
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR') + ' F';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d + 'T00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const SLOT_ICON = { matin: '🌅', soir: '🌇' };
const slotTitle = (x) => {
  const part = x.slot === 'soir' ? 'soir' : 'matin';
  if (x.today) return `Ce ${part}`;
  if (x.tomorrow) return `Demain ${part}`;
  const day = fmtDate(x.date);
  return `${day.charAt(0).toUpperCase() + day.slice(1)} ${part}`;
};
const STATUS_LABELS = { nouvelle: 'Reçue', confirmee: 'Confirmée', en_livraison: 'En cours de livraison', livree: 'Livrée', annulee: 'Annulée' };

function intlPhone(phone, cc) {
  const raw = String(phone || '').trim();
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  // Burkina : numéros à 8 chiffres, le 0 initial fait partie du numéro (ex. 05 04 00 40)
  if (d.length <= 8) return cc + d;
  if (d.startsWith(cc)) return d;
  return cc + d.replace(/^0+/, '');
}
const shopWa = (text) => `https://wa.me/${intlPhone(config.shopPhone, config.countryCode)}?text=${encodeURIComponent(text)}`;

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur réseau');
  return data;
}

let config = null;
let products = [];
let cart = JSON.parse(localStorage.getItem('zindo_cart') || '{}'); // { productId: quantité }
let map, marker;
let picked = null;   // { lat, lng }
let feeInfo = null;  // { fee, outOfZone }
let chosenSlot = null; // { date, slot, startHour }

const saveCart = () => localStorage.setItem('zindo_cart', JSON.stringify(cart));
const cartLines = () => products.filter((p) => cart[p.id]).map((p) => ({ ...p, qty: cart[p.id] }));
const subtotal = () => cartLines().reduce((a, l) => a + l.price * l.qty, 0);

function setQty(id, qty) {
  qty = Math.max(0, Math.min(99, qty));
  if (qty === 0) delete cart[id]; else cart[id] = qty;
  saveCart();
  renderCatalog();
  renderCart();
}

// ---------- rendu ----------
function renderBanner() {
  $('#shopName').textContent = config.shopName;
  document.title = `${config.shopName} — Légumes préparés livrés chez vous`;
  const set = (sel, v) => document.querySelectorAll(sel).forEach((el) => (el.textContent = v));
  set('[data-h="morning"]', config.startHour);
  set('[data-h="evening"]', config.eveningStartHour);
  set('[data-cut="morning"]', config.morningCutoff >= 24 ? 'minuit' : config.morningCutoff + 'h');
  set('[data-cut="evening"]', config.eveningCutoff + 'h');
  set('[data-fee]', fmt(config.deliveryFee));
  set('[data-shop]', config.shopName);
  $('#year').textContent = new Date().getFullYear();
  renderContact();
  if (config.shopPhone) {
    $('#footerContact').innerHTML = `<a href="#contact" data-wa-shop target="_blank" rel="noopener">WhatsApp ${esc(config.shopPhone)}</a>`;
    $('#sideWhatsapp').href = '#contact';
    $('#sideWhatsapp').setAttribute('data-wa-shop', '');
    $('#sideWhatsapp').classList.remove('hidden');
  }
}

// ---------- service client ----------
function renderContact() {
  const has = !!config.shopPhone;
  const tel = has ? `tel:+${intlPhone(config.shopPhone, config.countryCode)}` : '#';
  $('#contactPhone').textContent = has ? config.shopPhone : 'Bientôt disponible';
  $('#contactPhone').href = tel;
  $('#contactCall').href = tel;
  $('#contactWa').href = '#contact';
  $('#contactWa').setAttribute('data-wa-shop', '');
  $('#contactCall').classList.toggle('hidden', !has);
  $('#contactWa').classList.toggle('hidden', !has);
  if (!has) $('#contactHint').textContent = 'Utilisez le formulaire, nous vous recontactons au plus vite.';
  if (has) {
    $('#sideCall').href = tel;
    $('#sidePhone').textContent = config.shopPhone;
    $('#sideCall').classList.remove('hidden');
  }
}

// Message WhatsApp vers la boutique : toujours avec le nom (et le téléphone) du client
function customerIdentity() {
  const saved = JSON.parse(localStorage.getItem('zindo_customer') || '{}');
  return {
    name: $('#mName').value.trim() || $('#cName').value.trim() || saved.name || '',
    phone: $('#mPhone').value.trim() || $('#cPhone').value.trim() || saved.phone || ''
  };
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-wa-shop]');
  if (!a || !config?.shopPhone) return;
  const { name, phone } = customerIdentity();
  if (!name) {
    // On demande d'abord le nom au client, dans le formulaire de contact
    e.preventDefault();
    closeMenu?.();
    $('#contact').scrollIntoView({ behavior: 'smooth' });
    $('#mError').textContent = 'Indiquez votre nom (et votre téléphone) ci-dessous, puis appuyez à nouveau sur WhatsApp.';
    setTimeout(() => $('#mName').focus(), 400);
    return;
  }
  const subject = $('#mSubject').value;
  const order = $('#mOrder').value.trim();
  const msg = $('#mMessage').value.trim();
  let text = `Bonjour ${config.shopName}, je suis ${name}${phone ? ` (${phone})` : ''}.`;
  if (msg) text += `\nSujet : ${subject}${order ? `\nCommande : ${order}` : ''}\n${msg}`;
  else text += order ? `\nJ'ai une question au sujet de ma commande ${order} :` : `\nJ'ai une question :`;
  a.href = shopWa(text);
  a.target = '_blank';
  $('#mError').textContent = '';
});

$('#contactForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#mError').textContent = '';
  $('#mOk').classList.add('hidden');
  $('#mSend').disabled = true;
  try {
    await api('/api/messages', { method: 'POST', body: JSON.stringify({
      name: $('#mName').value, phone: $('#mPhone').value, subject: $('#mSubject').value,
      orderCode: $('#mOrder').value, message: $('#mMessage').value
    }) });
    $('#mMessage').value = ''; $('#mOrder').value = '';
    $('#mOk').classList.remove('hidden');
  } catch (err) {
    $('#mError').textContent = err.message;
  } finally {
    $('#mSend').disabled = false;
  }
};

// Illustration par défaut selon le nom du produit (quand il n'y a pas de photo)
const EMOJIS = [
  [/gombo|okra/i, '🌿'], [/oseille|bissap|feuille|épinard|epinard|salade|chou|laitue/i, '🥬'],
  [/aubergine/i, '🍆'], [/tomate/i, '🍅'], [/oignon/i, '🧅'], [/ail/i, '🧄'], [/piment/i, '🌶️'],
  [/poivron/i, '🫑'], [/carotte/i, '🥕'], [/concombre|courgette/i, '🥒'], [/patate|pomme de terre|igname/i, '🥔'],
  [/maïs|mais/i, '🌽'], [/mix|sauce|soupe|légumes|legumes/i, '🍲']
];
const productEmoji = (name) => (EMOJIS.find(([re]) => re.test(name)) || [, '🥬'])[1];
const productVisual = (p) => p.image
  ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
  : `<span class="emo">${productEmoji(p.name)}</span>`;

function renderCatalog() {
  const el = $('#catalog');
  if (!products.length) { el.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="big">🌱</div>Aucun produit disponible pour le moment. Revenez bientôt !</div>'; return; }
  el.innerHTML = products.map((p) => {
    const q = cart[p.id] || 0;
    return `<article class="card">
      <div class="img tint-${p.id % 4}">${productVisual(p)}${q ? `<span class="in-cart">✓ ${q} au panier</span>` : ''}</div>
      <div class="body">
        <span class="name">${esc(p.name)}</span>
        ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
        <div class="foot">
          <span class="price">${fmt(p.price)}<br><small>/ ${esc(p.unit)}</small></span>
          ${q
            ? `<div class="qty"><button data-dec="${p.id}" aria-label="Moins">−</button><span>${q}</span><button data-inc="${p.id}" aria-label="Plus">+</button></div>`
            : `<button class="add-btn" data-inc="${p.id}" aria-label="Ajouter ${esc(p.name)} au panier">+</button>`}
        </div>
      </div>
    </article>`;
  }).join('');
}

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((a, l) => a + l.qty, 0);
  $('#cartCount').textContent = count;
  $('#cartCount').classList.toggle('hidden', !count);
  $('#cartItems').innerHTML = lines.length
    ? lines.map((l) => `<div class="cart-line">
        <div class="thumb tint-${l.id % 4}">${productVisual(l)}</div>
        <div class="info">
          <div class="line-top"><b>${esc(l.name)}</b><button class="remove" data-remove="${l.id}" title="Retirer du panier" aria-label="Retirer ${esc(l.name)}">✕</button></div>
          <div class="muted">${fmt(l.price)} / ${esc(l.unit)}</div>
          <div class="line-bottom">
            <div class="qty"><button data-dec="${l.id}" aria-label="Moins">−</button><span>${l.qty}</span><button data-inc="${l.id}" aria-label="Plus">+</button></div>
            <b>${fmt(l.price * l.qty)}</b>
          </div>
        </div>
      </div>`).join('')
    : '<div class="empty"><div class="big">🧺</div><b>Votre panier est vide</b><p>Ajoutez quelques légumes préparés pour commencer.</p></div>';
  $('#cartSubtotal').textContent = fmt(subtotal());
  $('#cartFeeHint').textContent = fmt(config.deliveryFee);
  $('#checkoutBtn').disabled = !lines.length;
  $('#cartBarCount').textContent = count;
  $('#cartBarTotal').textContent = fmt(subtotal());
  $('#cartBar').classList.toggle('show', count > 0);
  $('#sideCartCount').textContent = count;
  $('#sideCartTotal').textContent = fmt(subtotal());
  renderMiniCart(lines, count);
}

// Panier affiché à côté des produits pendant la sélection
let lastAdded = null;
function renderMiniCart(lines, count) {
  const sub = subtotal();
  $('#miniCount').textContent = `${count} article${count > 1 ? 's' : ''}`;
  $('#miniLines').innerHTML = lines.length
    ? lines.map((l) => `<div class="mini-line${l.id === lastAdded ? ' just-added' : ''}">
        <div class="thumb tint-${l.id % 4}">${productVisual(l)}</div>
        <div class="info">
          <div class="line-top"><b>${esc(l.name)}</b><button class="remove" data-remove="${l.id}" aria-label="Retirer ${esc(l.name)}">✕</button></div>
          <div class="line-bottom">
            <div class="qty sm"><button data-dec="${l.id}" aria-label="Moins">−</button><span>${l.qty}</span><button data-inc="${l.id}" aria-label="Plus">+</button></div>
            <b>${fmt(l.price * l.qty)}</b>
          </div>
        </div>
      </div>`).join('')
    : '<div class="mini-empty"><div class="big">🧺</div>Votre panier est vide.<br>Appuyez sur <b>+</b> pour ajouter des légumes.</div>';
  $('#miniSubtotal').textContent = fmt(sub);
  $('#miniFee').textContent = fmt(config.deliveryFee);
  $('#miniTotal').textContent = fmt(lines.length ? sub + config.deliveryFee : 0);
  $('#miniCheckout').disabled = !lines.length;
  lastAdded = null;
}

// Accueil : si des produits ont une photo, on les montre en mosaïque
function renderHeroVisual() {
  const withPhoto = products.filter((p) => p.image).slice(0, 3);
  if (!withPhoto.length) return; // sinon on garde le panneau vert « Frais · Lavés · Coupés · Livrés »
  $('#heroVisual').innerHTML = `<div class="mosaic">${withPhoto.map((p) =>
    `<figure><img src="${esc(p.image)}" alt="${esc(p.name)}"><figcaption>${esc(p.name)}</figcaption></figure>`).join('')}</div>`;
  if (withPhoto.length < 3) $('#heroVisual .mosaic').style.gridTemplateRows = '1fr';
}

// Clics +/−/retirer (catalogue et panier)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-inc],[data-dec],[data-remove]');
  if (!t) return;
  if (t.dataset.inc) {
    lastAdded = +t.dataset.inc;
    setQty(+t.dataset.inc, (cart[t.dataset.inc] || 0) + 1);
    const b = $('#openCart2'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
  }
  if (t.dataset.dec) setQty(+t.dataset.dec, (cart[t.dataset.dec] || 0) - 1);
  if (t.dataset.remove) setQty(+t.dataset.remove, 0);
});

// ---------- tiroir panier ----------
const openCart = () => { $('#cart').classList.add('open'); $('#overlay').classList.remove('hidden'); };
const closeCart = () => { $('#cart').classList.remove('open'); $('#overlay').classList.add('hidden'); };
$('#openCart').onclick = openCart;
$('#openCart2').onclick = openCart;
$('#cartBar').onclick = openCart;
$('#closeCart').onclick = closeCart;
$('#overlay').onclick = closeCart;
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

// ---------- validation / carte ----------
function updateTotals() {
  const sub = subtotal();
  $('#coSubtotal').textContent = fmt(sub);
  $('#coFee').textContent = feeInfo ? fmt(feeInfo.fee) : '—';
  $('#coTotal').textContent = fmt(sub + (feeInfo ? feeInfo.fee : 0));
  $('#coDelivery').textContent = chosenSlot
    ? `Livraison ${slotTitle(chosenSlot).toLowerCase()} (${fmtDate(chosenSlot.date)}), à partir de ${chosenSlot.startHour}h. Paiement à la livraison.`
    : 'Choisissez votre créneau de livraison. Paiement à la livraison.';
}

function renderSlots() {
  const saved = JSON.parse(localStorage.getItem('zindo_customer') || '{}');
  chosenSlot = chosenSlot && config.slots.find((x) => x.date === chosenSlot.date && x.slot === chosenSlot.slot);
  if (!chosenSlot) {
    // présélectionne le créneau habituel du client (matin par défaut) pour le prochain jour de livraison
    chosenSlot = config.slots.find((x) => x.slot === saved.slot) || config.slots[0];
  }
  $('#slotChoices').innerHTML = config.slots.map((x, i) => `
    <label class="slot-opt"><input type="radio" name="slot" value="${i}" ${x === chosenSlot ? 'checked' : ''}>
      <b>${SLOT_ICON[x.slot]} ${esc(slotTitle(x))}</b>
      <span class="muted">${x.today || x.tomorrow ? esc(fmtDate(x.date)) + ' · ' : ''}dès ${x.startHour}h</span></label>`).join('');
  document.querySelectorAll('[name=slot]').forEach((r) => (r.onchange = () => { chosenSlot = config.slots[+r.value]; updateTotals(); }));
}

async function setPoint(lat, lng, label) {
  picked = { lat, lng };
  if (!marker) {
    marker = L.marker([lat, lng], { draggable: true }).addTo(map);
    marker.on('dragend', () => { const p = marker.getLatLng(); setPoint(p.lat, p.lng, 'Point déplacé'); });
  } else marker.setLatLng([lat, lng]);
  $('#locateStatus').textContent = `✅ ${label}. Vous pouvez déplacer le marqueur pour ajuster.`;
  try {
    feeInfo = await api(`/api/delivery-fee?lat=${lat}&lng=${lng}`);
    $('#coError').textContent = feeInfo.outOfZone ? 'Ce point est hors de notre zone de livraison.' : '';
  } catch (e) { feeInfo = null; $('#coError').textContent = e.message; }
  updateTotals();
}

function initMap() {
  if (map) return;
  map = L.map('map').setView([config.mapCenter.lat, config.mapCenter.lng], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  map.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng, 'Point placé sur la carte'));
}

function locate() {
  if (!navigator.geolocation) { $('#locateStatus').textContent = 'La géolocalisation n\'est pas disponible : touchez la carte.'; return; }
  $('#locateStatus').textContent = '⏳ Recherche de votre position…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      map.setView([latitude, longitude], 16);
      setPoint(latitude, longitude, `Position trouvée (précision ± ${Math.round(accuracy)} m)`);
    },
    () => { $('#locateStatus').textContent = '⚠️ Position refusée ou indisponible. Touchez la carte pour placer votre point.'; },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}
$('#locateBtn').onclick = locate;

$('#miniCheckout').onclick = () => $('#checkoutBtn').click();
$('#checkoutBtn').onclick = () => {
  closeCart();
  const saved = JSON.parse(localStorage.getItem('zindo_customer') || '{}');
  $('#cName').value ||= saved.name || '';
  $('#cPhone').value ||= saved.phone || '';
  $('#cAddress').value ||= saved.address || '';
  $('#coError').textContent = '';
  $('#checkout').showModal();
  renderSlots();
  initMap();
  setTimeout(() => {
    map.invalidateSize();
    if (!picked && saved.lat != null) {
      map.setView([saved.lat, saved.lng], 16);
      setPoint(saved.lat, saved.lng, 'Votre dernière adresse de livraison');
    }
  }, 100);
  updateTotals();
};

$('#checkoutForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#coError').textContent = '';
  if (!picked) { $('#coError').textContent = 'Indiquez votre position de livraison (bouton ou carte).'; return; }
  const body = {
    name: $('#cName').value, phone: $('#cPhone').value,
    address: $('#cAddress').value, note: $('#cNote').value,
    lat: picked.lat, lng: picked.lng,
    date: chosenSlot.date, slot: chosenSlot.slot,
    items: cartLines().map((l) => ({ productId: l.id, quantity: l.qty }))
  };
  $('#submitOrder').disabled = true;
  const ordered = cartLines();
  try {
    const r = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
    localStorage.setItem('zindo_customer', JSON.stringify({ name: body.name, phone: body.phone, address: body.address, lat: picked.lat, lng: picked.lng, slot: body.slot }));
    localStorage.setItem('zindo_last_order', JSON.stringify({ code: r.code, phone: body.phone }));
    cart = {}; saveCart(); renderCatalog(); renderCart();
    $('#cNote').value = '';
    $('#checkout').close();
    // Message de commande complet, envoyé au WhatsApp de la boutique
    const slotTxt = `${fmtDate(r.deliveryDate)} ${r.slot === 'soir' ? 'soir' : 'matin'} (dès ${r.startHour}h)`;
    const waText =
      `🛒 NOUVELLE COMMANDE ${r.code}\n` +
      `Bonjour ${config.shopName}, je suis ${body.name.trim()} (${body.phone.trim()}).\n\n` +
      ordered.map((l) => `• ${l.qty} × ${l.name} — ${fmt(l.price * l.qty)}`).join('\n') +
      `\n\nSous-total : ${fmt(r.subtotal)}\nLivraison : ${fmt(r.deliveryFee)}\n*Total : ${fmt(r.total)}*` +
      `\n\n📅 Livraison : ${slotTxt}` +
      `\n📍 Repère : ${body.address || '-'}` +
      (body.note ? `\n📝 Remarque : ${body.note}` : '') +
      `\n🗺️ Position : https://maps.google.com/?q=${body.lat},${body.lng}`;
    const waUrl = config.shopPhone ? shopWa(waText) : null;

    $('#successBody').innerHTML = `
      <div class="success-hero"><div class="check">✓</div></div>
      <div class="dlg-body" style="text-align:center">
      <h2 style="margin-top:.6rem">Merci, c'est commandé ! 🎉</h2>
      ${waUrl ? `<div class="wa-auto" id="waAuto">
          <div class="spinner"></div>
          <div><b>Ouverture de WhatsApp…</b><br><span class="muted">Votre commande est déjà écrite : appuyez simplement sur <b>Envoyer</b> ➤</span></div>
        </div>
        <p><a class="btn block whatsapp xl" id="waSend" href="${esc(waUrl)}">💬 Envoyer ma commande sur WhatsApp</a></p>` : ''}
      <p>Votre code de suivi : <span class="code">${esc(r.code)}</span></p>
      <p>Total à payer à la livraison : <b>${fmt(r.total)}</b>
         <span class="muted">(dont livraison ${fmt(r.deliveryFee)})</span></p>
      <p>${SLOT_ICON[r.slot]} Livraison <b>${esc(slotTxt)}</b>.</p>
      <button class="btn secondary" data-close>Fermer</button>
      ${config.shopPhone ? `<p class="muted" style="margin-top:1rem">Une question ? Appelez-nous au <a href="tel:+${intlPhone(config.shopPhone, config.countryCode)}">${esc(config.shopPhone)}</a></p>` : ''}
      </div>`;
    $('#successBody [data-close]').onclick = () => $('#success').close();
    $('#success').showModal();
    if (waUrl) {
      // On garde la commande pour l'afficher au retour de WhatsApp
      sessionStorage.setItem('zindo_wa_pending', JSON.stringify({ code: r.code, total: r.total, url: waUrl, at: Date.now() }));
      // Ouverture automatique de WhatsApp vers le numéro de la boutique
      setTimeout(() => {
        $('#waAuto')?.classList.add('done');
        window.location.href = waUrl;
      }, 1800);
    }
    $('#trackCode').value = r.code; $('#trackPhone').value = body.phone;
  } catch (err) {
    $('#coError').textContent = err.message;
    if (/créneau/.test(err.message)) { config = await api('/api/config').catch(() => config); renderSlots(); updateTotals(); }
  } finally {
    $('#submitOrder').disabled = false;
  }
};

// ---------- suivi ----------
$('#trackForm').onsubmit = async (e) => {
  e.preventDefault();
  const el = $('#trackResult');
  try {
    const o = await api(`/api/orders/track?code=${encodeURIComponent($('#trackCode').value)}&phone=${encodeURIComponent($('#trackPhone').value)}`);
    el.innerHTML = `<div class="order" style="margin-top:1rem">
      <div class="order-head"><b>Commande ${esc(o.code)}</b><span class="status st-${o.status}">${STATUS_LABELS[o.status]}</span></div>
      <div class="muted">${SLOT_ICON[o.slot]} Livraison ${esc(fmtDate(o.deliveryDate))} ${o.slot === 'soir' ? 'soir' : 'matin'}, dès ${o.startHour}h</div>
      <ul>${o.items.map((i) => `<li>${i.quantity} × ${esc(i.name)} — ${fmt(i.lineTotal)}</li>`).join('')}</ul>
      <div>Livraison : ${fmt(o.deliveryFee)} · <b>Total : ${fmt(o.total)}</b></div></div>`;
  } catch (err) {
    el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
};

// ---------- effets de la page d'accueil ----------
// Menu latéral : tiroir sur mobile
const sidebar = $('#sidebar');
const closeMenu = () => { sidebar.classList.remove('open'); $('#sideOverlay').classList.add('hidden'); };
$('#menuBtn').onclick = () => { sidebar.classList.add('open'); $('#sideOverlay').classList.remove('hidden'); };
$('#sideOverlay').onclick = closeMenu;
sidebar.addEventListener('click', (e) => { if (e.target.closest('a[href^="#"], #openCart2')) closeMenu(); });

// Lien actif dans le menu selon la section visible
const navLinks = [...document.querySelectorAll('.side-nav a')];
if ('IntersectionObserver' in window) {
  const spy = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('main section[id]').forEach((s) => spy.observe(s));
}
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: 0.15 })
  : null;
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 3) * 90}ms`;
  io ? io.observe(el) : el.classList.add('in');
});

// Retour sur le site après WhatsApp : on confirme la commande
function showWaReturn() {
  const p = JSON.parse(sessionStorage.getItem('zindo_wa_pending') || 'null');
  if (!p || Date.now() - p.at > 2 * 3600e3) return;
  const box = document.createElement('div');
  box.className = 'wa-return';
  box.innerHTML = `<div><b>✅ Commande ${esc(p.code)} enregistrée</b> · ${fmt(p.total)}<br>
    <span class="muted">Le message WhatsApp n'est pas parti ?</span> <a href="${esc(p.url)}">Le renvoyer</a></div>
    <button class="close" aria-label="Fermer">×</button>`;
  box.querySelector('button').onclick = () => { box.remove(); sessionStorage.removeItem('zindo_wa_pending'); };
  document.body.append(box);
}

// ---------- démarrage ----------
(async function init() {
  try {
    [config, products] = await Promise.all([api('/api/config'), api('/api/products')]);
  } catch {
    $('#catalog').innerHTML = '<p class="error">Impossible de charger les produits. Vérifiez votre connexion.</p>';
    return;
  }
  // retire du panier les produits qui ne sont plus disponibles
  for (const id of Object.keys(cart)) if (!products.some((p) => p.id === +id)) delete cart[id];
  saveCart();
  const last = JSON.parse(localStorage.getItem('zindo_last_order') || 'null');
  if (last) { $('#trackCode').value = last.code; $('#trackPhone').value = last.phone; $('#mOrder').value = last.code; }
  const me = JSON.parse(localStorage.getItem('zindo_customer') || '{}');
  if (me.name) $('#mName').value = me.name;
  if (me.phone) $('#mPhone').value = me.phone;
  renderBanner();
  renderHeroVisual();
  showWaReturn();
  renderCatalog();
  renderCart();
})();
