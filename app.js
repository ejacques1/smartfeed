// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
// Supabase anon key is designed to be public (RLS protects data)
const SUPABASE_URL      = 'https://seyildptkabaukqkgahg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNleWlsZHB0a2FiYXVrcWtnYWhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MTUxMTEsImV4cCI6MjA4ODk5MTExMX0.UYZdZo7DS0WSQ_3yVR38lN8RUu8b-HOj6u7_prtlNKc';

let sb;
try {
  const { createClient } = supabase;
  let canPersist = false;
  try { localStorage.setItem('_test', '1'); localStorage.removeItem('_test'); canPersist = true; } catch (_) {}
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: canPersist, autoRefreshToken: canPersist }
  });
} catch (e) {
  console.warn('Supabase unavailable:', e.message);
  // Stub so the rest of the app doesn't crash
  const _noop = () => Promise.resolve({ data: null, error: null });
  const _noopAuth = { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signUp: _noop, signInWithPassword: _noop, signOut: _noop, getSession: _noop, resetPasswordForEmail: _noop };
  sb = { from: () => ({ select: _noop, insert: _noop, upsert: _noop, update: _noop, delete: _noop,
    eq: function() { return this; }, single: _noop, order: function() { return this; } }), auth: _noopAuth };
}

let currentUser   = null;
let userProfile   = null;
let userFavorites = [];
let dailyTargets  = null;

// ═══════════════════════════════════════════════════════
// AUTH STATE
// ═══════════════════════════════════════════════════════
try {
  sb.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user ?? null;
    _updateNav();
    if (currentUser) { await loadProfile(); await loadFavorites(); }
  });
} catch (e) {
  console.warn('Auth listener unavailable (private browsing mode)');
  _updateNav();
}

function _updateNav() {
  const in_ = !!currentUser;
  document.getElementById('nav-auth').style.display  = in_ ? 'none' : 'flex';
  document.getElementById('nav-user').style.display  = in_ ? 'flex' : 'none';
  if (in_) document.getElementById('user-greeting').textContent = '👋 ' + currentUser.email.split('@')[0];
}

// ═══════════════════════════════════════════════════════
// VIEWS
// ═══════════════════════════════════════════════════════
function showHome() {
  el('profile-section').style.display = 'none';
  el('result-section').style.display  = 'none';
  document.querySelector('.hero').style.display = 'flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showProfile() {
  document.querySelector('.hero').style.display  = 'none';
  el('result-section').style.display  = 'none';
  el('profile-section').style.display = 'block';
  _renderTargets();
  _renderFavorites();
  if (userProfile) {
    el('pref-diet').value   = userProfile.dietary_preference || 'No preference';
    el('pref-budget').value = userProfile.weekly_budget || 'Under $25';
  }
}

// ═══════════════════════════════════════════════════════
// AUTH ACTIONS
// ═══════════════════════════════════════════════════════
async function signUp() {
  const email    = val('su-email'), password = val('su-pw');
  const age      = parseInt(val('su-age'))    || null;
  const gender   = val('su-gender');
  const weight   = parseFloat(val('su-weight')) || null;
  const height   = parseFloat(val('su-height')) || null;
  const activity = parseFloat(val('su-activity'));
  const diet     = val('su-diet'), budget = val('su-budget');
  if (!email || !password) { showErr('su-err', 'Email and password required.'); return; }
  if (!document.getElementById('su-terms').checked) { showErr('su-err', 'Please agree to the Terms of Service & Privacy Policy.'); return; }
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { showErr('su-err', error.message); return; }
  if (data.user) {
    await sb.from('profiles').upsert({
      id: data.user.id, email, age, gender,
      weight_lbs: weight, height_inches: height, activity_factor: activity,
      dietary_preference: diet, weekly_budget: budget
    });
  }
  closeModal('modal-signup');
  toast('Account created! Check your email to confirm 🎉');
}

async function signIn() {
  const email = val('li-email'), password = val('li-pw');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { showErr('li-err', error.message); return; }
  closeModal('modal-login');
  toast('Welcome back! 👋');
}

async function signOut() {
  await sb.auth.signOut();
  currentUser = null; userProfile = null; userFavorites = []; dailyTargets = null;
  el('profile-section').style.display = 'none';
  document.querySelector('.hero').style.display = 'flex';
  toast('Signed out.');
}

// ═══════════════════════════════════════════════════════
// PROFILE & CALORIE CALCULATOR (Mifflin-St Jeor)
// ═══════════════════════════════════════════════════════
async function loadProfile() {
  if (!currentUser) return;
  const { data } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();
  if (data) { userProfile = data; _calcTargets(); }
}

function _calcTargets() {
  if (!userProfile) return;
  const { age, gender, weight_lbs, height_inches, activity_factor } = userProfile;
  if (!age || !weight_lbs || !height_inches) { dailyTargets = null; return; }
  const wKg = weight_lbs * 0.453592, hCm = height_inches * 2.54;
  const bmr = gender === 'male'
    ? (10 * wKg) + (6.25 * hCm) - (5 * age) + 5
    : (10 * wKg) + (6.25 * hCm) - (5 * age) - 161;
  const tdee = Math.round(bmr * (activity_factor || 1.2));
  dailyTargets = {
    calories: tdee,
    protein:  Math.round(tdee * 0.25 / 4),
    carbs:    Math.round(tdee * 0.50 / 4),
    fat:      Math.round(tdee * 0.25 / 9)
  };
}

function _renderTargets() {
  if (!dailyTargets) {
    ['pc','pp','pcar','pf'].forEach(id => el(id).textContent = '—');
    return;
  }
  el('pc').textContent   = dailyTargets.calories.toLocaleString();
  el('pp').textContent   = dailyTargets.protein + 'g';
  el('pcar').textContent = dailyTargets.carbs + 'g';
  el('pf').textContent   = dailyTargets.fat + 'g';
}

async function saveGoals() {
  if (!currentUser) return;
  const age      = parseInt(val('g-age'))    || null;
  const gender   = val('g-gender');
  const weight   = parseFloat(val('g-weight')) || null;
  const height   = parseFloat(val('g-height')) || null;
  const activity = parseFloat(val('g-activity'));
  const { error } = await sb.from('profiles')
    .update({ age, gender, weight_lbs: weight, height_inches: height, activity_factor: activity })
    .eq('id', currentUser.id);
  if (error) { showErr('g-err', error.message); return; }
  userProfile = { ...userProfile, age, gender, weight_lbs: weight, height_inches: height, activity_factor: activity };
  _calcTargets(); _renderTargets();
  closeModal('modal-goals');
  toast('Goals updated! 💪');
}

async function savePrefs() {
  if (!currentUser) return;
  await sb.from('profiles')
    .update({ dietary_preference: val('pref-diet'), weekly_budget: val('pref-budget') })
    .eq('id', currentUser.id);
  toast('Preferences saved ✅');
}

// ═══════════════════════════════════════════════════════
// FAVORITES
// ═══════════════════════════════════════════════════════
async function loadFavorites() {
  if (!currentUser) return;
  const { data } = await sb.from('favorites').select('*').eq('user_id', currentUser.id);
  if (data) userFavorites = data;
}

async function saveFavorite(name, address, type, lat, lng) {
  if (!currentUser) { toast('Log in to save favorites!'); openModal('modal-login'); return; }
  const { error } = await sb.from('favorites')
    .insert({ user_id: currentUser.id, name, address, type, lat, lng });
  if (!error) { await loadFavorites(); toast('❤️ Saved to favorites!'); }
}

async function removeFavorite(id) {
  await sb.from('favorites').delete().eq('id', id);
  await loadFavorites();
  _renderFavorites();
  toast('Removed from favorites.');
}

function _renderFavorites() {
  const list = el('fav-list');
  if (!userFavorites.length) {
    list.innerHTML = '<div class="empty-state">No favorites yet.<br>Search your area and save places you love!</div>';
    return;
  }
  list.innerHTML = userFavorites.map(f => `
    <div class="fav-item">
      <div><div class="fav-name">${f.name}</div><div class="fav-type">${f.type || 'Food Spot'}</div></div>
      <button class="btn-rmfav" onclick="removeFavorite('${f.id}')">✕</button>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
// SEARCH & RESOURCES
// ═══════════════════════════════════════════════════════
function _distMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function _fetchMarkets(lat, lng) {
  const grid = el('markets-grid');
  const loading = el('markets-loading');
  grid.innerHTML = '';
  loading.style.display = 'flex';

  try {
    const res = await fetch('https://data.cityofnewyork.us/resource/8vwk-6iz2.json?$limit=1000');
    const markets = await res.json();

    // Calculate distance and sort by nearest
    const nearby = markets
      .filter(m => m.latitude && m.longitude)
      .map(m => ({
        ...m,
        dist: _distMiles(lat, lng, parseFloat(m.latitude), parseFloat(m.longitude))
      }))
      .filter(m => m.dist <= 5) // within 5 miles
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 12);

    loading.style.display = 'none';

    if (!nearby.length) {
      grid.innerHTML = '<p class="markets-empty">No farmers markets found within 5 miles. Try the resources below for more food options.</p>';
      return;
    }

    grid.innerHTML = nearby.map((m, i) => `
      <div class="market-card" style="animation-delay:${i * 0.05}s">
        <div class="market-name">${m.marketname}</div>
        <div class="market-addr">📍 ${m.streetaddress} — ${m.dist.toFixed(1)} mi</div>
        <div class="market-hours">🕐 ${m.daysoperation} ${m.hoursoperations || ''}</div>
        <div class="market-tags">
          ${m.accepts_ebt === 'Yes' ? '<span class="mtag ebt">Accepts EBT</span>' : ''}
          ${m.open_year_round === 'Yes' ? '<span class="mtag year">Year-Round</span>' : '<span class="mtag seasonal">Seasonal</span>'}
        </div>
      </div>
    `).join('');
  } catch (e) {
    loading.style.display = 'none';
    grid.innerHTML = '<p class="markets-empty">Could not load farmers markets. Try the resources below.</p>';
  }
}

async function _runSearch(lat, lng, address) {
  // Show results immediately
  el('result-section').style.display = 'block';
  el('result-section').scrollIntoView({ behavior: 'smooth' });

  // Fetch farmers markets (non-blocking UI)
  _fetchMarkets(lat, lng);

  // Log search in background
  sb.from('searches').insert({ address, lat, lng, user_id: currentUser?.id || null }).then(() => {}).catch(() => {});
}

// ═══════════════════════════════════════════════════════
// GEOCODING & ZONE DETECTION
// ═══════════════════════════════════════════════════════
async function detectZone() {
  const addr = el('address-input').value.trim();
  if (!addr) { toast('Please enter an address or zip code first.'); return; }
  _setLoading(true);
  try {
    let lat, lng;
    // Check if input looks like a zip code (5 digits)
    if (/^\d{5}$/.test(addr)) {
      const res = await fetch(`https://api.zippopotam.us/us/${addr}`);
      if (!res.ok) throw new Error('Zip not found');
      const data = await res.json();
      const place = data.places?.[0];
      if (!place) throw new Error('Zip not found');
      lat = parseFloat(place.latitude);
      lng = parseFloat(place.longitude);
    } else {
      // Full address — use Census geocoder
      const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`);
      const data = await res.json();
      const match = data?.result?.addressMatches?.[0];
      if (!match) throw new Error('Not found');
      lat = match.coordinates.y;
      lng = match.coordinates.x;
    }
    await _runSearch(lat, lng, addr);
  } catch {
    toast('Address not found. Try a zip code or full address with city and state.');
  }
  _setLoading(false);
}

function useGPS() {
  if (!navigator.geolocation) { toast('Geolocation not supported by your browser.'); return; }
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    el('address-input').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    _setLoading(true);
    await _runSearch(lat, lng, `${lat},${lng}`);
    _setLoading(false);
  }, () => toast('Location denied. Please enter your address manually.'));
}

// ═══════════════════════════════════════════════════════
// NUTRITION LABEL SCANNER
// ═══════════════════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.scan-tab').forEach((t, i) =>
    t.classList.toggle('active', (i === 0 && tab === 'photo') || (i === 1 && tab === 'search')));
  el('tab-photo').classList.toggle('active', tab === 'photo');
  el('tab-search').classList.toggle('active', tab === 'search');
}

async function _resizeImage(file, maxDim = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      // Output JPEG at 0.85 quality for good balance of size vs quality
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function handleLabelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const preview  = el('preview-img');
  const loading  = el('scan-loading');
  preview.src    = URL.createObjectURL(file);
  preview.style.display = 'block';
  loading.style.display = 'flex';

  try {
    // Resize image before upload to stay under Vercel's 4.5MB body limit
    const { base64, mediaType } = await _resizeImage(file);

    const response = await fetch('/api/scan-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mediaType })
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();

    // Check for API errors (Anthropic error, missing content, etc.)
    if (data.error) {
      throw new Error(data.error.message || data.error);
    }
    const text = data.content?.[0]?.text;
    if (!text) {
      throw new Error('No text in response');
    }

    const cleaned = text.replace(/```json|```/g, '').trim();
    const nutrition = JSON.parse(cleaned);

    // Validate we got real data
    if (!nutrition.product && nutrition.calories === undefined) {
      throw new Error('Label could not be read');
    }

    loading.style.display = 'none';
    _showNutrition(nutrition);
  } catch (e) {
    loading.style.display = 'none';
    console.error('Label scan error:', e);
    toast('Could not read label. Try a clearer photo or use the Search tab.');
  }
}

async function searchProduct() {
  const query = el('product-search').value.trim();
  if (!query) return;
  try {
    const res  = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=1`);
    const data = await res.json();
    const p    = data.products?.[0];
    if (!p) { toast('Product not found. Try a different name.'); return; }
    const n = p.nutriments;
    const nutrition = {
      product:      p.product_name || query,
      calories:     Math.round(n['energy-kcal_serving'] || n['energy-kcal_100g'] || 0),
      protein_g:    Math.round(n.proteins_serving       || n.proteins_100g       || 0),
      carbs_g:      Math.round(n.carbohydrates_serving  || n.carbohydrates_100g  || 0),
      fat_g:        Math.round(n.fat_serving            || n.fat_100g            || 0),
      serving_size: p.serving_size || 'per serving'
    };
    _showNutrition(nutrition);
    // Fetch swaps in background, then update
    _fetchSwaps(nutrition.product, nutrition.calories, nutrition.protein_g, nutrition.carbs_g, nutrition.fat_g)
      .then(swaps => { if (swaps.length) { nutrition.swaps = swaps; _showNutrition(nutrition); } });
  } catch { toast('Search failed. Please try again.'); }
}

function _showNutrition(n) {
  const targets = dailyTargets || { calories: 2000, protein: 125, carbs: 250, fat: 55 };
  el('nutr-name').textContent = `${n.product} — ${n.serving_size || 'per serving'}`;
  const macros = [
    { label: 'Calories', val: n.calories,  target: targets.calories, unit: 'kcal', cls: 'cal' },
    { label: 'Protein',  val: n.protein_g, target: targets.protein,  unit: 'g',    cls: 'pro' },
    { label: 'Carbs',    val: n.carbs_g,   target: targets.carbs,    unit: 'g',    cls: 'car' },
    { label: 'Fat',      val: n.fat_g,     target: targets.fat,      unit: 'g',    cls: 'fat' }
  ];
  el('nutr-bars').innerHTML = macros.map(m => {
    const pct = Math.min(Math.round((m.val / m.target) * 100), 100);
    return `<div class="mrow">
      <div class="mlabel">${m.label}</div>
      <div class="mtrack"><div class="mbar ${m.cls}" style="width:${pct}%"></div></div>
      <div class="mnums">${m.val}${m.unit} <span style="color:#bbb">(${pct}%)</span></div>
    </div>`;
  }).join('');
  const calPct = Math.round((n.calories / targets.calories) * 100);
  el('nutr-summary').textContent =
    `This uses ${calPct}% of your ${targets.calories.toLocaleString()} daily calorie goal. ` +
    (dailyTargets ? 'Based on your personal profile.' : 'Log in to personalize this to your own stats.');

  // Whole Food Swaps
  const swapContainer = el('nutr-swaps');
  if (n.swaps && n.swaps.length > 0) {
    swapContainer.innerHTML = `
      <div class="swap-header">
        <h4>🥬 Whole Food Swaps</h4>
        <p class="swap-disclaimer">Educational information, not dietary advice.</p>
      </div>
      <div class="swap-grid">${n.swaps.map(s => `
        <div class="swap-card">
          <div class="swap-name">${s.food}</div>
          <div class="swap-macros">
            <span>${s.calories} cal</span>
            <span>${s.protein_g}g protein</span>
            <span>${s.carbs_g}g carbs</span>
            <span>${s.fat_g}g fat</span>
          </div>
          <div class="swap-why">${s.why}</div>
        </div>`).join('')}
      </div>`;
    swapContainer.style.display = 'block';
  } else {
    swapContainer.style.display = 'none';
  }

  el('nutr-result').style.display = 'block';
}

async function _fetchSwaps(product, calories, protein_g, carbs_g, fat_g) {
  try {
    const response = await fetch('/api/scan-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swapOnly: true, product, calories, protein_g, carbs_g, fat_g })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    return result.swaps || [];
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
const el  = id => document.getElementById(id);
const val = id => el(id).value.trim();

function _setLoading(on) {
  el('btn-spinner').style.display = on ? 'inline-block' : 'none';
  el('btn-text').textContent = on ? '' : 'Detect';
  el('detect-btn').disabled = on;
}

function showErr(id, msg) {
  const e = el(id);
  e.textContent = msg;
  e.style.display = 'block';
}

function openModal(id) { el(id).classList.add('open'); }

function closeModal(id) {
  el(id).classList.remove('open');
  el(id).querySelectorAll('.err').forEach(e => e.style.display = 'none');
}

document.querySelectorAll('.modal-bg').forEach(bg =>
  bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); })
);

let _toastT;
function toast(msg, dur = 3500) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), dur);
}

document.addEventListener('DOMContentLoaded', () => {
  el('address-input').addEventListener('keydown', e => { if (e.key === 'Enter') detectZone(); });
  el('product-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchProduct(); });
});
