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

// ═══════════════════════════════════════════════════════
// FLYER VISIT TRACKING
// ═══════════════════════════════════════════════════════
(function logFlyerVisit() {
  const params = new URLSearchParams(window.location.search);
  const src = params.get('src');
  if (!src) return;
  // Only log once per session so reloads don't inflate the count
  const key = `flyer_logged_${src}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch (_) {}
  sb.from('flyer_visits').insert({ source: src }).then(() => {}).catch(() => {});
})();

// ═══════════════════════════════════════════════════════
// LIVE HOMEPAGE STATS
// ═══════════════════════════════════════════════════════
async function loadLiveStats() {
  try {
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const iso = sevenDaysAgo.toISOString();

    // Total signups
    const { count: signups } = await sb.from('profiles').select('*', { count: 'exact', head: true });

    // Meals logged this week
    const { count: meals } = await sb.from('food_log').select('*', { count: 'exact', head: true }).gte('logged_at', iso);

    // Active 7-Day challenges (unique users with food_log entries in last 7 days)
    const { data: recentEntries } = await sb.from('food_log').select('user_id').gte('logged_at', iso);
    const activeUsers = new Set((recentEntries || []).map(e => e.user_id)).size;

    const elSignups = document.getElementById('stat-signups');
    const elMeals   = document.getElementById('stat-meals');
    const elActive  = document.getElementById('stat-active');
    if (elSignups) elSignups.textContent = (signups || 0).toLocaleString();
    if (elMeals)   elMeals.textContent   = (meals || 0).toLocaleString();
    if (elActive)  elActive.textContent  = (activeUsers || 0).toLocaleString();
  } catch (e) {
    // Silently fail — stats are non-critical
  }
}
// Load stats when page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadLiveStats);
} else {
  loadLiveStats();
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
  loadTodayLog();
  loadChallengeProgress();
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
  if (error) {
    console.error('signUp error:', error);
    showErr('su-err', error.message);
    toast(`Couldn't sign up: ${error.message}`);
    return;
  }
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
  if (error) {
    console.error('signIn error:', error);
    showErr('li-err', error.message);
    toast(`Couldn't log in: ${error.message}`);
    return;
  }
  closeModal('modal-login');
  toast('Welcome back! 👋');
}

async function signOut() {
  // Update UI synchronously first — if sb.auth.signOut() hangs or throws
  // (network issues, blocked storage, stale token), the user still sees the
  // logged-out state immediately.
  currentUser = null; userProfile = null; userFavorites = []; dailyTargets = null;
  el('profile-section').style.display = 'none';
  document.querySelector('.hero').style.display = 'flex';
  _updateNav();
  toast('Signed out.');
  try { await sb.auth.signOut(); } catch (e) { console.warn('signOut error:', e); }
  // Belt-and-suspenders: nuke any persisted Supabase session so a refresh
  // doesn't restore the user.
  try {
    Object.keys(localStorage).forEach(k => { if (k.startsWith('sb-')) localStorage.removeItem(k); });
  } catch (_) {}
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
  if (!currentUser) { toast('Please log in first.'); return; }
  const age      = parseInt(val('g-age'))    || null;
  const gender   = val('g-gender');
  const weight   = parseFloat(val('g-weight')) || null;
  const height   = parseFloat(val('g-height')) || null;
  const activity = parseFloat(val('g-activity'));
  const { error } = await sb.from('profiles')
    .update({ age, gender, weight_lbs: weight, height_inches: height, activity_factor: activity })
    .eq('id', currentUser.id);
  if (error) {
    console.error('saveGoals error:', error);
    showErr('g-err', `Couldn't save: ${error.message}`);
    toast(`Couldn't save goals: ${error.message}`);
    return;
  }
  userProfile = { ...userProfile, age, gender, weight_lbs: weight, height_inches: height, activity_factor: activity };
  _calcTargets(); _renderTargets();
  closeModal('modal-goals');
  toast('Goals updated! 💪');
}

async function savePrefs() {
  if (!currentUser) { toast('Please log in first.'); return; }
  const { error } = await sb.from('profiles')
    .update({ dietary_preference: val('pref-diet'), weekly_budget: val('pref-budget') })
    .eq('id', currentUser.id);
  if (error) {
    console.error('savePrefs error:', error);
    toast(`Couldn't save preferences: ${error.message}`);
    return;
  }
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
    // Fetch only the latest year's data to avoid duplicate historical entries
    const res = await fetch('https://data.cityofnewyork.us/resource/8vwk-6iz2.json?$limit=1000&$order=year%20DESC');
    const markets = await res.json();

    // Dedupe by market name (keep the first/most recent occurrence)
    const seen = new Set();
    const unique = markets.filter(m => {
      if (!m.marketname || seen.has(m.marketname)) return false;
      seen.add(m.marketname);
      return true;
    });

    // Calculate distance and sort by nearest
    const nearby = unique
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

  // "Add to today's log" button (only for logged-in users)
  const logBtn = el('nutr-log-btn');
  if (logBtn) {
    if (currentUser) {
      logBtn.style.display = 'block';
      logBtn.onclick = () => logFood(n);
    } else {
      logBtn.style.display = 'none';
    }
  }

  el('nutr-result').style.display = 'block';
}

// ═══════════════════════════════════════════════════════
// 7-DAY CHALLENGE & FOOD LOG
// ═══════════════════════════════════════════════════════
async function logFood(n) {
  if (!currentUser) { toast('Please log in to save your food log.'); return; }
  const entry = {
    user_id: currentUser.id,
    product: n.product || 'Unknown',
    calories: n.calories || 0,
    protein_g: n.protein_g || 0,
    carbs_g: n.carbs_g || 0,
    fat_g: n.fat_g || 0,
    serving_size: n.serving_size || 'per serving'
  };
  const { error } = await sb.from('food_log').insert(entry);
  if (error) {
    console.error('logFood error:', error);
    toast(`Couldn't add to log: ${error.message}`);
    return;
  }
  toast('✅ Added to today\'s log!');
}

async function loadTodayLog() {
  if (!currentUser) return;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: entries } = await sb.from('food_log')
    .select('*')
    .eq('user_id', currentUser.id)
    .gte('logged_at', startOfDay.toISOString())
    .order('logged_at', { ascending: false });

  _renderTodayLog(entries || []);
}

function _renderTodayLog(entries) {
  const targets = dailyTargets || { calories: 2000, protein: 125, carbs: 250, fat: 55 };
  const totals = entries.reduce((acc, e) => ({
    calories: acc.calories + (e.calories || 0),
    protein:  acc.protein  + (e.protein_g || 0),
    carbs:    acc.carbs    + (e.carbs_g || 0),
    fat:      acc.fat      + (e.fat_g || 0)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  const macros = [
    { label: 'Calories', val: totals.calories, target: targets.calories, unit: 'kcal', cls: 'cal' },
    { label: 'Protein',  val: totals.protein,  target: targets.protein,  unit: 'g',    cls: 'pro' },
    { label: 'Carbs',    val: totals.carbs,    target: targets.carbs,    unit: 'g',    cls: 'car' },
    { label: 'Fat',      val: totals.fat,      target: targets.fat,      unit: 'g',    cls: 'fat' }
  ];

  el('today-bars').innerHTML = entries.length ? macros.map(m => {
    const pct = Math.min(Math.round((m.val / m.target) * 100), 100);
    return `<div class="mrow">
      <div class="mlabel">${m.label}</div>
      <div class="mtrack"><div class="mbar ${m.cls}" style="width:${pct}%"></div></div>
      <div class="mnums">${m.val}${m.unit} / ${m.target}${m.unit} <span style="color:#bbb">(${pct}%)</span></div>
    </div>`;
  }).join('') : '';

  const list = el('today-items');
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">Nothing logged yet today. Head to the home page to scan a food label!</div>';
    return;
  }
  list.innerHTML = entries.map(e => `
    <div class="log-item">
      <div class="log-item-name">${e.product}</div>
      <div class="log-item-macros">${e.calories} cal · ${e.protein_g}g P · ${e.carbs_g}g C · ${e.fat_g}g F</div>
      <button class="log-item-del" onclick="deleteLogEntry('${e.id}')" aria-label="Remove entry">✕</button>
    </div>`).join('');
}

async function deleteLogEntry(id) {
  const { error } = await sb.from('food_log').delete().eq('id', id);
  if (error) { toast('Could not delete entry.'); return; }
  loadTodayLog();
  loadChallengeProgress();
}

async function loadChallengeProgress() {
  if (!currentUser) return;
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const { data: entries } = await sb.from('food_log')
    .select('logged_at, calories, protein_g, carbs_g, fat_g')
    .eq('user_id', currentUser.id)
    .gte('logged_at', sevenDaysAgo.toISOString());

  if (!entries) return;

  // Get unique days logged (in user's local timezone)
  const daysLogged = new Set();
  const dailyTotals = {};
  entries.forEach(e => {
    const d = new Date(e.logged_at);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    daysLogged.add(dayKey);
    if (!dailyTotals[dayKey]) dailyTotals[dayKey] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyTotals[dayKey].calories += e.calories || 0;
    dailyTotals[dayKey].protein  += e.protein_g || 0;
    dailyTotals[dayKey].carbs    += e.carbs_g || 0;
    dailyTotals[dayKey].fat      += e.fat_g || 0;
  });

  const dayCount = daysLogged.size;
  el('challenge-days').textContent = Math.min(dayCount, 7);

  // Render dots for each day of the last 7 days
  const dots = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const filled = daysLogged.has(key);
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' });
    dots.push(`<div class="challenge-dot ${filled ? 'filled' : ''}" title="${d.toLocaleDateString()}"><div class="dot-label">${dayLabel[0]}</div></div>`);
  }
  el('challenge-dots').innerHTML = dots.join('');

  // Update subtitle based on progress
  const sub = el('challenge-sub');
  if (dayCount === 0) sub.textContent = 'Log what you eat for 7 days to learn your eating patterns.';
  else if (dayCount < 7) sub.textContent = `Keep going! ${7 - dayCount} more day${7 - dayCount === 1 ? '' : 's'} to complete the challenge.`;
  else sub.textContent = '🎉 Challenge complete! Here\'s what you learned:';

  // Show week in review once 7 days are logged
  if (dayCount >= 7) _renderWeekInReview(dailyTotals);
  else el('week-review').style.display = 'none';
}

function _renderWeekInReview(dailyTotals) {
  const days = Object.values(dailyTotals);
  const avg = days.reduce((acc, d) => ({
    calories: acc.calories + d.calories / days.length,
    protein:  acc.protein  + d.protein  / days.length,
    carbs:    acc.carbs    + d.carbs    / days.length,
    fat:      acc.fat      + d.fat      / days.length
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  const targets = dailyTargets || { calories: 2000, protein: 125, carbs: 250, fat: 55 };
  const calDiff = avg.calories - targets.calories;

  // Macro percentages of total calories (protein 4cal/g, carbs 4cal/g, fat 9cal/g)
  const pCal = avg.protein * 4;
  const cCal = avg.carbs * 4;
  const fCal = avg.fat * 9;
  const totalCal = pCal + cCal + fCal || 1;
  const pPct = Math.round(pCal / totalCal * 100);
  const cPct = Math.round(cCal / totalCal * 100);
  const fPct = Math.round(fCal / totalCal * 100);

  // Plain-English takeaway
  let takeaway;
  if (Math.abs(calDiff) < 100) {
    takeaway = `You averaged ${Math.round(avg.calories)} cal/day — right in line with your target of ${targets.calories}. Nice balance!`;
  } else if (calDiff > 0) {
    const daysPerPound = Math.round(3500 / calDiff);
    takeaway = `You averaged ${Math.round(avg.calories)} cal/day — ${Math.round(calDiff)} above your target. At this rate, you'd gain about 1 lb every ${daysPerPound} days.`;
  } else {
    const daysPerPound = Math.round(3500 / Math.abs(calDiff));
    takeaway = `You averaged ${Math.round(avg.calories)} cal/day — ${Math.round(Math.abs(calDiff))} below your target. At this rate, you'd lose about 1 lb every ${daysPerPound} days.`;
  }

  el('week-review').innerHTML = `
    <div class="review-box">
      <h5>Your Week in Review</h5>
      <div class="review-stat">${takeaway}</div>
      <div class="review-macros">
        <div class="review-macro"><div class="review-pct p">${pPct}%</div><div class="review-lbl">Protein</div></div>
        <div class="review-macro"><div class="review-pct c">${cPct}%</div><div class="review-lbl">Carbs</div></div>
        <div class="review-macro"><div class="review-pct f">${fPct}%</div><div class="review-lbl">Fat</div></div>
      </div>
      <p class="review-note">A balanced split is roughly 25% protein / 50% carbs / 25% fat. Use what you learned — no need to keep logging forever.</p>
    </div>`;
  el('week-review').style.display = 'block';
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
function toast(msg, dur) {
  const t = el('toast');
  const isError = /couldn'?t|could not|error|failed|denied|violates/i.test(msg);
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), dur || (isError ? 8000 : 3500));
}

document.addEventListener('DOMContentLoaded', () => {
  el('address-input').addEventListener('keydown', e => { if (e.key === 'Enter') detectZone(); });
  el('product-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchProduct(); });
});
