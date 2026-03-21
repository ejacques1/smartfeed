// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
// Supabase anon key is designed to be public (RLS protects data)
const SUPABASE_URL      = 'https://seyildptkabaukqkgahg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNleWlsZHB0a2FiYXVrcWtnYWhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MTUxMTEsImV4cCI6MjA4ODk5MTExMX0.UYZdZo7DS0WSQ_3yVR38lN8RUu8b-HOj6u7_prtlNKc';

// These are loaded from Vercel env vars via /api/config
let GOOGLE_MAPS_KEY = '';
let USDA_API_KEY    = '';

const { createClient } = supabase;
let sb;
try {
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: typeof localStorage !== 'undefined', autoRefreshToken: true }
  });
} catch (e) {
  // Fallback for private browsing modes that block storage
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

let mapsReady = false;
window._onMapsReady = () => { mapsReady = true; };

// Load config from server, then init Google Maps
(async function _initConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    GOOGLE_MAPS_KEY = cfg.googleMapsKey || '';
    USDA_API_KEY    = cfg.usdaApiKey || '';
  } catch (e) {
    console.warn('Could not load config, falling back to defaults');
  }
  // Load Google Maps after we have the key
  if (GOOGLE_MAPS_KEY) {
    const _gm = document.createElement('script');
    _gm.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places,geometry&callback=_onMapsReady`;
    _gm.async = true; _gm.defer = true;
    document.head.appendChild(_gm);
  }
})();

let currentUser   = null;
let userProfile   = null;
let userFavorites = [];
let dailyTargets  = null;

// Filter state
let lastSearchLat = null;
let lastSearchLng = null;
let allPlaces     = [];

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
// USDA FOOD ACCESS RESEARCH ATLAS
// ═══════════════════════════════════════════════════════
async function _getUSDA(lat, lng) {
  try {
    const cRes = await fetch(
      `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lng}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
    );
    const cData = await cRes.json();
    const tract = cData?.result?.geographies?.['Census Tracts']?.[0];
    if (!tract) return null;

    const uRes = await fetch(
      `https://api.ers.usda.gov/data/foodaccess/foodaccessresearchatlas/2019?key=${USDA_API_KEY}&state=${tract.STATE}&county=${tract.COUNTY}&tract=${tract.TRACT}`
    );
    const uData = await uRes.json();
    const d = uData?.data?.[0];
    if (!d) return null;

    const isLILA    = d.LILATracts_1And10 === 1 || d.LILATracts_halfAnd10 === 1;
    const isLimited = !isLILA && (d.lapophalfshare > 0.33);
    return { isLILA, isLimited, verified: true, raw: d };
  } catch (e) {
    console.warn('USDA unavailable, falling back to Places ratio:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// ZONE CLASSIFICATION
// ═══════════════════════════════════════════════════════
const ZONE_DATA = {
  lila:    { cls:'lila',    emoji:'⚠️', title:'Low-Income & Low-Access Area',
    desc:'Your census tract is classified as a USDA Low-Income and Low-Access (LILA) area. Residents here have limited access to supermarkets and affordable healthy food.',
    access:{v:'Low',c:'bad'}, ff:{v:'High',c:'bad'}, health:{v:'3/10',c:'bad'} },
  limited: { cls:'limited', emoji:'🟡', title:'Limited Food Access Area',
    desc:'Your area has a high share of residents who live far from supermarkets and healthy food sources, making nutritious choices harder.',
    access:{v:'Med',c:'warn'}, ff:{v:'Very High',c:'bad'}, health:{v:'5/10',c:'warn'} },
  healthy: { cls:'healthy', emoji:'🌿', title:'Adequate Food Access',
    desc:'Your area has reasonable access to grocery stores and healthy food options relative to fast food density. Nice!',
    access:{v:'Good',c:''}, ff:{v:'Low',c:''}, health:{v:'8/10',c:''} }
};

async function _classifyZone(lat, lng) {
  const usda = await _getUSDA(lat, lng);
  if (usda?.verified) {
    const zone = usda.isLILA ? 'lila' : usda.isLimited ? 'limited' : 'healthy';
    return { zone, source: 'usda' };
  }
  return new Promise(resolve => {
    const svc = new google.maps.places.PlacesService(document.createElement('div'));
    const loc = new google.maps.LatLng(lat, lng);
    let grocery = 0, fastfood = 0, done = 2;
    const finish = () => {
      if (--done > 0) return;
      let zone = 'healthy';
      if (grocery === 0) zone = 'lila';
      else if ((fastfood / Math.max(grocery, 1)) >= 3) zone = 'limited';
      resolve({ zone, source: 'google' });
    };
    svc.nearbySearch({ location: loc, radius: 1600, type: 'grocery_or_supermarket' },
      (r, s) => { grocery = s === 'OK' ? r.length : 0; finish(); });
    svc.nearbySearch({ location: loc, radius: 1600, keyword: 'fast food', type: 'restaurant' },
      (r, s) => { fastfood = s === 'OK' ? Math.min(r.length, 20) : 0; finish(); });
  });
}

function _fetchPlaces(lat, lng, dietaryKeyword) {
  const HALF_MILE_M = 805;  // half mile in meters
  const svc = new google.maps.places.PlacesService(document.createElement('div'));
  const origin = new google.maps.LatLng(lat, lng);
  const baseOpts = { location: origin, radius: HALF_MILE_M };

  // Multiple searches to cast a wide net
  const searches = [
    { ...baseOpts, type: 'grocery_or_supermarket' },
    { ...baseOpts, keyword: 'health food store' },
    { ...baseOpts, keyword: 'farmers market' },
    { ...baseOpts, keyword: 'organic food' },
  ];
  if (dietaryKeyword) {
    searches.push({ ...baseOpts, keyword: dietaryKeyword });
  }

  return new Promise(resolve => {
    const seen = new Map();
    let pending = searches.length;
    let resolved = false;

    function finish() {
      if (resolved) return;
      resolved = true;
      const combined = Array.from(seen.values())
        .map(p => ({
          ...p,
          _distM: google.maps.geometry.spherical.computeDistanceBetween(origin, p.geometry.location)
        }))
        .filter(p => p._distM <= HALF_MILE_M)
        .sort((a, b) => a._distM - b._distM)
        .slice(0, 20);
      resolve(combined);
    }

    function collect(results, status) {
      if (status === 'OK' && results) {
        results.forEach(p => {
          if (!seen.has(p.place_id)) seen.set(p.place_id, p);
        });
      }
      if (--pending === 0) finish();
    }

    // Safety timeout — resolve with whatever we have after 8 seconds
    setTimeout(finish, 8000);

    searches.forEach(opts => svc.nearbySearch(opts, collect));
  });
}

function _renderZone(zone, source) {
  const z = ZONE_DATA[zone];
  el('zone-banner').className = 'zone-banner ' + z.cls;
  el('zone-emoji').textContent = z.emoji;
  el('zone-title').textContent = z.title;
  el('zone-desc').textContent  = z.desc;
  el('usda-verified').style.display = source === 'usda' ? 'inline-flex' : 'none';
  const sa = el('score-access'), sf = el('score-ff'), sh = el('score-health');
  sa.textContent = z.access.v; sa.className = 'score-num ' + z.access.c;
  sf.textContent = z.ff.v;     sf.className = 'score-num ' + z.ff.c;
  sh.textContent = z.health.v; sh.className = 'score-num ' + z.health.c;
}

function _priceLevelLabel(level) {
  if (level === undefined || level === null) return '';
  const symbols = ['Free', '$', '$$', '$$$', '$$$$'];
  return symbols[level] || '';
}

function _renderPlaces(places, lat, lng) {
  const grid = el('places-grid');
  grid.innerHTML = '';
  if (!places.length) {
    grid.innerHTML = '<div class="places-empty">No spots match your filters. Try adjusting your dietary or budget preferences. 👆</div>';
    return;
  }
  const uLoc = new google.maps.LatLng(lat, lng);
  places.forEach((p, i) => {
    const distM = google.maps.geometry.spherical.computeDistanceBetween(uLoc, p.geometry.location);
    const dist  = (distM * 0.000621371).toFixed(1);
    const pLat  = p.geometry.location.lat();
    const pLng  = p.geometry.location.lng();
    const name  = p.name.replace(/'/g, "\\'");
    const addr  = (p.vicinity || '').replace(/'/g, "\\'");
    const type  = (p.types?.[0] || 'food spot').replace(/_/g, ' ');
    const priceLabel = _priceLevelLabel(p.price_level);
    const card  = document.createElement('div');
    card.className = 'place-card';
    card.style.animationDelay = (i * 0.07) + 's';
    card.innerHTML = `
      <div class="place-type">${type}</div>
      <div class="place-name">${p.name}</div>
      <div class="place-dist">📍 ${dist} mi away</div>
      ${p.rating ? `<div class="place-rating">⭐ ${p.rating} (${p.user_ratings_total || 0})</div>` : ''}
      <div class="place-tags">
        ${p.opening_hours?.open_now ? '<span class="tag open">Open Now</span>' : ''}
        ${priceLabel ? `<span class="tag price">${priceLabel}</span>` : ''}
        <span class="tag">Healthy Option</span>
      </div>
      <button class="btn-dir" onclick="openDir(${pLat},${pLng})">Get Directions →</button>
      <button class="btn-fav" onclick="saveFavorite('${name}','${addr}','${type}',${pLat},${pLng})">❤️ Save to Favorites</button>`;
    grid.appendChild(card);
  });
}

async function _runSearch(lat, lng, address) {
  lastSearchLat = lat;
  lastSearchLng = lng;

  const { zone, source } = await _classifyZone(lat, lng);
  _renderZone(zone, source);

  // Auto-set filters from user profile
  _autoSetFilters();

  const dietFilter = el('filter-diet')?.value || '';
  const places = await _fetchPlaces(lat, lng, dietFilter);
  allPlaces = places;

  _applyBudgetFilter();

  await sb.from('searches').insert({ address, lat, lng, zone_result: zone, user_id: currentUser?.id || null });
  el('result-section').style.display = 'block';
  el('result-section').scrollIntoView({ behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════════
// DIETARY & BUDGET FILTERS
// ═══════════════════════════════════════════════════════
function _autoSetFilters() {
  if (!userProfile) return;
  const dietEl = el('filter-diet');
  const budgetEl = el('filter-budget');

  // Map profile dietary preference to filter value
  if (dietEl && userProfile.dietary_preference && userProfile.dietary_preference !== 'No preference') {
    const pref = userProfile.dietary_preference.toLowerCase();
    for (const opt of dietEl.options) {
      if (opt.value === pref) { dietEl.value = pref; break; }
    }
  }

  // Map weekly budget to max price_level
  if (budgetEl && userProfile.weekly_budget) {
    const budgetMap = { 'Under $25': '1', '$25–$50': '2', '$50–$100': '3', '$100+': '0' };
    const mapped = budgetMap[userProfile.weekly_budget];
    if (mapped) budgetEl.value = mapped;
  }
}

function _applyBudgetFilter() {
  const maxPrice = parseInt(el('filter-budget')?.value) || 0;
  let filtered = allPlaces;

  if (maxPrice > 0) {
    filtered = allPlaces.filter(p =>
      p.price_level === undefined || p.price_level === null || p.price_level <= maxPrice
    );
  }

  _renderPlaces(filtered, lastSearchLat, lastSearchLng);
}

async function applyFilters() {
  if (!lastSearchLat || !lastSearchLng) return;

  const dietFilter = el('filter-diet')?.value || '';

  // Dietary filter: re-fetch with new keyword to get relevant results
  const grid = el('places-grid');
  grid.innerHTML = '<div class="places-empty">Updating results…</div>';

  const places = await _fetchPlaces(lastSearchLat, lastSearchLng, dietFilter);
  allPlaces = places;

  // Budget filter: client-side filter by price_level
  _applyBudgetFilter();
}

function resetFilters() {
  el('filter-diet').value = '';
  el('filter-budget').value = '0';
  applyFilters();
}

async function detectZone() {
  if (!mapsReady) { toast('Maps still loading, try again in a second.'); return; }
  const addr = el('address-input').value.trim();
  if (!addr) { toast('Please enter an address first.'); return; }
  _setLoading(true);
  try {
    await new Promise((res, rej) => {
      new google.maps.Geocoder().geocode({ address: addr }, (results, status) => {
        if (status === 'OK' && results[0]) {
          const loc = results[0].geometry.location;
          _runSearch(loc.lat(), loc.lng(), addr).then(res);
        } else rej(new Error('Not found'));
      });
    });
  } catch {
    toast('Address not found. Try a full address with city and state.');
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

function openDir(lat, lng) {
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
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

async function handleLabelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const preview  = el('preview-img');
  const loading  = el('scan-loading');
  preview.src    = URL.createObjectURL(file);
  preview.style.display = 'block';
  loading.style.display = 'flex';

  const base64 = await new Promise(res => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result.split(',')[1]);
    reader.readAsDataURL(file);
  });

  try {
    const response = await fetch('/api/scan-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mediaType: file.type })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const nutrition = JSON.parse(text.replace(/```json|```/g, '').trim());
    loading.style.display = 'none';
    _showNutrition(nutrition);
  } catch (e) {
    loading.style.display = 'none';
    toast('Could not read label. Try the Search tab instead.');
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
    _showNutrition({
      product:      p.product_name || query,
      calories:     Math.round(n['energy-kcal_serving'] || n['energy-kcal_100g'] || 0),
      protein_g:    Math.round(n.proteins_serving       || n.proteins_100g       || 0),
      carbs_g:      Math.round(n.carbohydrates_serving  || n.carbohydrates_100g  || 0),
      fat_g:        Math.round(n.fat_serving            || n.fat_100g            || 0),
      serving_size: p.serving_size || 'per serving'
    });
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
  el('nutr-result').style.display = 'block';
}

// ═══════════════════════════════════════════════════════
// COMMUNITY SUGGESTIONS
// ═══════════════════════════════════════════════════════
async function submitSuggestion() {
  const name    = val('sug-name');
  const address = val('sug-addr');
  const type    = val('sug-type');
  const notes   = val('sug-notes');
  if (!name) { showErr('sug-err', 'Place name is required.'); return; }
  const { error } = await sb.from('suggestions')
    .insert({ name, address, type, notes, submitted_by: currentUser?.id || null });
  if (error) { showErr('sug-err', error.message); return; }
  closeModal('modal-suggest');
  toast('Thanks! Suggestion submitted for review 🙌');
  ['sug-name','sug-addr','sug-notes'].forEach(id => el(id).value = '');
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
