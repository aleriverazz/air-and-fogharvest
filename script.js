/* ═══════════════════════════════════════════════════════════════════════
   FogHarvest  ·  script.js  ·  v7
   ─────────────────────────────────────────────────────────────────────
   Changes vs v5:
   §1   CFG — added API_ICON (/v1/icon), API_GFS (/v1/gfs),
              HOURLY_VARS, ARCHIVE_VARS
   §2   S   — added activeModel, activeHour fields
   §6   fetchWindField / fetchPointData completely rewritten:
        ├─ fetchPointICON   → ICON 13 km primary
        │    • requests forecast_days=2, timezone=UTC
        │    • findNearestHourIndex() picks the hourly slot
        │      whose timestamp is closest to Date.now()
        │    • on HTTP error → automatic GFS fallback
        ├─ fetchPointArchive → unchanged v5 monthly-average logic
        └─ fetchPointData   → dispatcher (current → ICON, else → archive)
   §14  renderPanel — atm grid now shows MODEL + HORA UTC rows
   §16  setStatus   — status bar shows "ICON 13km · HH:MM UTC · ALT · MES"
                      or "GFS (fallback)" when ICON was unavailable
   All other sections preserved verbatim from v5.
═══════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════
   1. CONFIG
══════════════════════════════════════════════════════ */
const CFG = {
  MT_KEY:         'YU4AkYjwr3SI0k0mKRLc',
  MT_STYLE:       'https://api.maptiler.com/maps/outdoor-v2/style.json?key=YU4AkYjwr3SI0k0mKRLc',
  MT_TERRAIN_URL: 'https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=YU4AkYjwr3SI0k0mKRLc',
  MT_GEOCODE:     'https://api.maptiler.com/geocoding',

  CENTER:      [-116.94, 32.52],
  ZOOM:        11.5,
  PITCH:       58,
  BEARING:     -18,
  TERRAIN_EXG: 1.5,

  /* ── Weather API endpoints ───────────────────────── */
  API_ICON:    'https://api.open-meteo.com/v1/icon',    // ICON 13 km — PRIMARY
  API_GFS:     'https://api.open-meteo.com/v1/gfs',     // GFS 0.25°  — FALLBACK
  API_ARCHIVE: 'https://archive-api.open-meteo.com/v1/archive',

  /* Variables requested from ICON / GFS (hourly) */
  HOURLY_VARS: [
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_speed_80m',
    'wind_direction_80m',
    'wind_speed_120m',
    'wind_direction_120m',
    'relative_humidity_2m',
    'temperature_2m',
  ].join(','),

  /* Variables requested from archive (hourly) */
  ARCHIVE_VARS: [
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_speed_80m',
    'wind_direction_80m',
    'wind_speed_120m',
    'wind_direction_120m',
    'relative_humidity_2m',
    'temperature_2m',
    'cloud_cover',
    'precipitation',
  ].join(','),

  COAST_RADIUS_KM: 30,
  GRID: { COLS: 14, ROWS: 10 },

  API_DELAY_MS:  1200,
  API_RETRY_MS:  4000,
  API_MAX_RETRY: 2,

  WIND: {
    PARTICLE_COUNT: 2200,
    FADE:       0.94,
    SPEED_SCALE: 0.38,
    LINE_WIDTH:  1.8,
    MAX_AGE:     100,
    MAX_ALPHA:   0.82,
    MIN_ALPHA:   0.32,
  },

  F: {
    FOG_H:92, FOG_M:78,
    ELV_HI_MIN:180, ELV_HI_MAX:850, ELV_ME_MIN:40, ELV_ME_MAX:180,
    WIN_HI_MIN:3,   WIN_HI_MAX:13,  WIN_ME_MIN:1,  WIN_ME_MAX:18,
    CST_HI:5, CST_ME:20,
  },

  Y: {
    EFFICIENCY:0.20, FOG_HOURS:8,
    LWC_RH_MIN:80, LWC_RH_MED:90, LWC_RH_HI:95, LWC_CAP:3.0,
    ELV_OPTIMAL_MIN:180, ELV_OPTIMAL_MAX:850, ELV_PEN_ABOVE:900,
  },
};


/* ══════════════════════════════════════════════════════
   2. STATE
══════════════════════════════════════════════════════ */
const S = {
  map:null, marker:null,
  windField:null, windParticles:[], windCanvas:null, windCtx:null, windRAF:null,
  humField:null,  humCanvas:null,   humCtx:null,
  gridSamples:[],
  selectedPoint:null, weather:null, feasibility:null, coastDist:null, waterYield:null,
  selectedMonth:'current',
  layerWind:true, layerHum:true,
  windOpacity:1.0, humOpacity:0.57,
  monthChart:null, panelOpen:true, searchTimer:null,
  apiCache:  new Map(),
  apiQueue:  Promise.resolve(),

  /* ── ICON / model tracking (v7) ── */
  activeModel: 'ICON',   // 'ICON' | 'GFS' | 'ARCHIVE'
  activeHour:  null,     // ISO string of the matched hourly slot, e.g. "2025-06-12T14:00"
};


/* ══════════════════════════════════════════════════════
   3. MAP INIT  (unchanged from v5)
══════════════════════════════════════════════════════ */
function initMap() {
  maptilersdk.config.apiKey = CFG.MT_KEY;
  S.map = new maptilersdk.Map({
    container:'map', style:CFG.MT_STYLE,
    center:CFG.CENTER, zoom:CFG.ZOOM, pitch:CFG.PITCH, bearing:CFG.BEARING,
    antialias:true,
  });
  S.map.addControl(new maptilersdk.NavigationControl({ visualizePitch:true }), 'bottom-right');
  const _t = setTimeout(()=>{ initCanvases(); showApp(); }, 10000);
  S.map.on('load', () => {
    clearTimeout(_t);
    try { if(!S.map.getSource('mt-dem')) S.map.addSource('mt-dem', { type:'raster-dem', url:CFG.MT_TERRAIN_URL, tileSize:512, maxzoom:14 }); } catch(e){}
    try { S.map.setTerrain({ source:'mt-dem', exaggeration:CFG.TERRAIN_EXG }); } catch(e){}
    try { if(!S.map.getLayer('sky')) S.map.addLayer({ id:'sky', type:'sky', paint:{ 'sky-type':'atmosphere','sky-atmosphere-sun':[0,88],'sky-atmosphere-sun-intensity':10 } }); } catch(e){}
    initCanvases();
    fetchWindField();
    showApp();
  });
  S.map.on('error', e => { console.warn('[FH]', e?.error?.message||e); });
  S.map.on('click', e => onMapClick(e.lngLat.lat, e.lngLat.lng));
  S.map.getCanvas().style.cursor = 'crosshair';
  S.map.on('moveend', debounce(fetchWindField, 1200));
  S.map.on('resize', () => {
    syncCanvasSize(S.windCanvas); syncCanvasSize(S.humCanvas);
    if(S.humField) drawHumidityCanvas();
  });
}


/* ══════════════════════════════════════════════════════
   4. SEARCH  (unchanged from v5)
══════════════════════════════════════════════════════ */
function initSearch() {
  const input    = document.getElementById('searchInput');
  const dropdown = document.getElementById('searchDropdown');
  const clearBtn = document.getElementById('searchClear');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', !q);
    clearTimeout(S.searchTimer);
    if(q.length < 2){ hideDropdown(); return; }
    S.searchTimer = setTimeout(() => geocodeSearch(q), 350);
  });
  clearBtn.addEventListener('click', () => { input.value=''; clearBtn.classList.add('hidden'); hideDropdown(); input.focus(); });
  document.addEventListener('click', e => { if(!document.getElementById('searchWrap').contains(e.target)) hideDropdown(); });
  input.addEventListener('keydown', e => {
    const items=dropdown.querySelectorAll('.search-item'), active=dropdown.querySelector('.search-item.active');
    if(e.key==='Escape'){ hideDropdown(); return; }
    if(e.key==='ArrowDown'){ e.preventDefault(); const n=active?.nextElementSibling||items[0]; if(n){ active?.classList.remove('active'); n.classList.add('active'); } }
    if(e.key==='ArrowUp'){   e.preventDefault(); const p=active?.previousElementSibling; if(p){ active.classList.remove('active'); p.classList.add('active'); } }
    if(e.key==='Enter'){ (active||items[0])?.click(); }
  });
}

async function geocodeSearch(query) {
  const dropdown = document.getElementById('searchDropdown');
  dropdown.innerHTML = `<div class="search-loading">Buscando…</div>`;
  dropdown.classList.remove('hidden');
  try {
    const res = await fetch(`${CFG.MT_GEOCODE}/${encodeURIComponent(query)}.json?key=${CFG.MT_KEY}&limit=6&language=es`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features||[];
    if(!features.length){ dropdown.innerHTML=`<div class="search-no-results">Sin resultados</div>`; return; }
    dropdown.innerHTML='';
    features.forEach(f => {
      const [lon,lat]=f.geometry.coordinates;
      const name=f.text||f.place_name||'Lugar';
      const sub=(f.place_name||'').replace(/^[^,]+,\s*/,'').trim();
      const item=document.createElement('div'); item.className='search-item';
      item.innerHTML=`<span class="si-name">${esc(name)}</span>${sub?`<span class="si-place">${esc(sub)}</span>`:''}<span class="si-coords">${lat.toFixed(4)}°, ${lon.toFixed(4)}°</span>`;
      item.addEventListener('click', () => {
        S.map.flyTo({ center:[lon,lat], zoom:13, pitch:CFG.PITCH, bearing:CFG.BEARING, duration:1400 });
        document.getElementById('searchInput').value=name;
        document.getElementById('searchClear').classList.remove('hidden');
        hideDropdown();
      });
      dropdown.appendChild(item);
    });
  } catch(err) { dropdown.innerHTML=`<div class="search-no-results">Error: ${esc(err.message)}</div>`; }
}
function hideDropdown(){ document.getElementById('searchDropdown').classList.add('hidden'); }
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


/* ══════════════════════════════════════════════════════
   5. RATE-LIMITED API  (unchanged from v5)
══════════════════════════════════════════════════════ */
function apiRequest(url, isArchive=false) {
  if(S.apiCache.has(url)) return Promise.resolve(S.apiCache.get(url));
  if(!isArchive) {
    return fetchWithRetry(url).then(d => { S.apiCache.set(url,d); return d; });
  }
  S.apiQueue = S.apiQueue.then(() => sleep(CFG.API_DELAY_MS));
  return new Promise((resolve, reject) => {
    S.apiQueue = S.apiQueue.then(async () => {
      try { const d=await fetchWithRetry(url); S.apiCache.set(url,d); resolve(d); }
      catch(e){ reject(e); }
    });
  });
}

async function fetchWithRetry(url, attempt=0) {
  const res = await fetch(url);
  if(res.status === 429) {
    if(attempt < CFG.API_MAX_RETRY){ await sleep(CFG.API_RETRY_MS*(attempt+1)); return fetchWithRetry(url, attempt+1); }
    throw new Error('Límite de peticiones (429). Espera un momento y vuelve a intentarlo.');
  }
  if(!res.ok) throw new Error(`API HTTP ${res.status}`);
  return res.json();
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }


/* ══════════════════════════════════════════════════════
   6. WIND FIELD  ← REWRITTEN FOR ICON + CORRECT HOUR
   ──────────────────────────────────────────────────────
   PRIMARY model  : ICON 13 km   → /v1/icon
   FALLBACK model : GFS 0.25°    → /v1/gfs
   HISTORICAL     : Open-Meteo archive  → /v1/archive

   Correct-hour algorithm
   ──────────────────────
   Open-Meteo returns hourly arrays in UTC.  We:
   1. Request forecast_days=2 + timezone=UTC so the current
      UTC clock time is always somewhere in the array.
   2. Call findNearestHourIndex(timeArray) which computes
      |Date.parse(slot) − Date.now()| for every entry and
      returns the index with the minimum difference.
   3. Extract speed, direction, humidity, temperature from
      that single index — no averaging, exact live slot.
══════════════════════════════════════════════════════ */

/**
 * Return the index in `timeArray` (ISO-8601 strings, UTC)
 * whose timestamp is closest to the current moment.
 * Open-Meteo omits the trailing 'Z' — we append ':00Z' so
 * Date.parse() treats the string as UTC.
 */
function findNearestHourIndex(timeArray) {
  if(!timeArray || !timeArray.length) return 0;
  const now = Date.now();
  let best = 0, bestDiff = Infinity;
  for(let i = 0; i < timeArray.length; i++) {
    /* "2025-06-12T14:00" → "2025-06-12T14:00:00Z" */
    const iso  = timeArray[i].endsWith('Z') ? timeArray[i] : timeArray[i] + ':00Z';
    const diff = Math.abs(Date.parse(iso) - now);
    if(diff < bestDiff){ bestDiff = diff; best = i; }
  }
  return best;
}

/**
 * Build an ICON or GFS URL for a single lat/lon point.
 * Always requests UTC, 2 days, hourly variables.
 */
function buildForecastURL(baseURL, lat, lon) {
  const url = new URL(baseURL);
  url.searchParams.set('latitude',        lat.toFixed(5));
  url.searchParams.set('longitude',       lon.toFixed(5));
  url.searchParams.set('hourly',          CFG.HOURLY_VARS);
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone',        'UTC');
  url.searchParams.set('forecast_days',   '2');
  return url.toString();
}

/**
 * Extract speed + direction at the nearest hour from a
 * parsed Open-Meteo hourly response, for the chosen altitude.
 */
function extractHourlyPoint(data, altMode) {
  const h   = data.hourly || {};
  const idx = findNearestHourIndex(h.time);

  let speed, dir;
  if(altMode === '10m') {
    speed = h.wind_speed_10m?.[idx]     ?? 3;
    dir   = h.wind_direction_10m?.[idx] ?? 270;
  } else if(altMode === '80m') {
    speed = h.wind_speed_80m?.[idx]     ?? h.wind_speed_10m?.[idx]     ?? 3;
    dir   = h.wind_direction_80m?.[idx] ?? h.wind_direction_10m?.[idx] ?? 270;
  } else { /* 120m */
    speed = h.wind_speed_120m?.[idx]    ?? h.wind_speed_10m?.[idx]     ?? 3;
    dir   = h.wind_direction_120m?.[idx]?? h.wind_direction_10m?.[idx] ?? 270;
  }

  return {
    speed:    speed    ?? 3,
    dir:      dir      ?? 270,
    humidity: h.relative_humidity_2m?.[idx] ?? 72,
    temp:     h.temperature_2m?.[idx]       ?? 15,
    cloud:    0,
    precip:   0,
    timeISO:  h.time?.[idx] ?? null,
    idx,
  };
}

/**
 * Fetch from ICON; automatically fall back to GFS on failure.
 * Sets S.activeModel and S.activeHour on success.
 */
async function fetchPointICON(lat, lon, altMode) {
  let data, usedModel;

  /* ── Attempt 1: ICON ── */
  try {
    data      = await apiRequest(buildForecastURL(CFG.API_ICON, lat, lon), false);
    usedModel = 'ICON';
  } catch(iconErr) {
    /* ── Attempt 2: GFS fallback ── */
    console.warn('[FH] ICON failed — trying GFS:', iconErr.message);
    try {
      data      = await apiRequest(buildForecastURL(CFG.API_GFS, lat, lon), false);
      usedModel = 'GFS';
    } catch(gfsErr) {
      throw new Error(`ICON y GFS fallaron.\nICON: ${iconErr.message}\nGFS: ${gfsErr.message}`);
    }
  }

  const result = extractHourlyPoint(data, altMode);

  /* Persist globally so status bar + export can read it */
  S.activeModel = usedModel;
  S.activeHour  = result.timeISO;

  console.log(
    `[FH] ${usedModel} idx=${result.idx} ` +
    `time=${result.timeISO} ` +
    `speed=${result.speed.toFixed(2)} m/s ` +
    `dir=${Math.round(result.dir)}° ` +
    `RH=${Math.round(result.humidity)}%`
  );

  return result;
}

/**
 * Fetch monthly-average data from the ERA5 archive.
 * Behaviour unchanged from v5 — averages the whole month.
 */
async function fetchPointArchive(lat, lon, altMode, month) {
  const year = new Date().getFullYear() - 1;
  const m    = parseInt(month, 10);
  const url  = new URL(CFG.API_ARCHIVE);
  url.searchParams.set('latitude',        lat.toFixed(5));
  url.searchParams.set('longitude',       lon.toFixed(5));
  url.searchParams.set('start_date',      `${year}-${pad(m)}-01`);
  url.searchParams.set('end_date',        `${year}-${pad(m)}-${daysInMonth(year,m)}`);
  url.searchParams.set('hourly',          CFG.ARCHIVE_VARS);
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone',        'auto');
  const data = await apiRequest(url.toString(), true);

  const hAvg = k => {
    const a = data.hourly?.[k];
    if(!a?.length) return null;
    const v = a.filter(x => x != null);
    return v.length ? v.reduce((s,x) => s+x, 0)/v.length : null;
  };

  let speed, dir;
  if(altMode === '10m')      { speed=hAvg('wind_speed_10m') ??3; dir=hAvg('wind_direction_10m') ??270; }
  else if(altMode === '80m') { speed=hAvg('wind_speed_80m') ??hAvg('wind_speed_10m') ??3; dir=hAvg('wind_direction_80m') ??hAvg('wind_direction_10m') ??270; }
  else                       { speed=hAvg('wind_speed_120m')??hAvg('wind_speed_10m') ??3; dir=hAvg('wind_direction_120m')??hAvg('wind_direction_10m')??270; }

  S.activeModel = 'ARCHIVE';
  S.activeHour  = null;

  return {
    speed:    speed   ??3,
    dir:      dir     ??270,
    humidity: hAvg('relative_humidity_2m') ??72,
    temp:     hAvg('temperature_2m')       ??15,
    cloud:    hAvg('cloud_cover')          ??0,
    precip:   hAvg('precipitation')        ??0,
  };
}

/**
 * Public dispatcher: current month → ICON (+ GFS fallback);
 * historical month → ERA5 archive.
 */
async function fetchPointData(lat, lon, altMode, month) {
  altMode = altMode || document.getElementById('selAlt').value;
  month   = month   || S.selectedMonth;
  return (month === 'current')
    ? fetchPointICON(lat, lon, altMode)
    : fetchPointArchive(lat, lon, altMode, month);
}


/* ── Wind field orchestration (unchanged grid logic) ── */
async function fetchWindField() {
  const map = S.map;
  if(!map || !map.isStyleLoaded()) return;
  setStatus('loading');

  const month = S.selectedMonth;
  const alt   = document.getElementById('selAlt').value;
  const b=map.getBounds(), sw=b.getSouthWest(), ne=b.getNorthEast();

  const SCOLS=4, SROWS=3, pts=[];
  for(let r=0;r<SROWS;r++)
    for(let c=0;c<SCOLS;c++)
      pts.push({ lat:sw.lat+(r/(SROWS-1))*(ne.lat-sw.lat), lon:sw.lng+(c/(SCOLS-1))*(ne.lng-sw.lng) });

  try {
    /* ICON / forecast: fire in parallel; archive: serialise */
    const fetched = (month === 'current')
      ? await Promise.all(pts.map(pt => fetchPointData(pt.lat, pt.lon, alt, month)))
      : await seqMap(pts, pt => fetchPointData(pt.lat, pt.lon, alt, month));

    pts.forEach((pt, i) => { pt.speed=fetched[i].speed; pt.dir=fetched[i].dir; pt.humidity=fetched[i].humidity; });
    S.gridSamples = pts;

    const { COLS, ROWS } = CFG.GRID;
    S.windField = { cols:COLS, rows:ROWS, uv:buildUVGrid(pts, sw, ne, COLS, ROWS), bounds:{sw,ne} };
    S.humField  = { cols:COLS, rows:ROWS, h: buildHumGrid(pts, sw, ne, COLS, ROWS), bounds:{sw,ne} };

    if(S.layerHum)  drawHumidityCanvas();
    if(S.layerWind) startWindParticles();
    setStatus('active', alt, month);
  } catch(err) {
    console.error('[FH] Wind fetch:', err);
    setStatus('error');
  }
}

async function seqMap(arr, fn){ const out=[]; for(const item of arr) out.push(await fn(item)); return out; }

/* ── Grid builders (unchanged) ── */
function buildUVGrid(samples, sw, ne, cols, rows) {
  const uv = new Float32Array(cols*rows*2);
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) {
    const lat=sw.lat+(r/(rows-1))*(ne.lat-sw.lat), lon=sw.lng+(c/(cols-1))*(ne.lng-sw.lng);
    const { speed, dir } = idwVec(lat, lon, samples), rad=(dir*Math.PI)/180, idx=(r*cols+c)*2;
    uv[idx]=speed*Math.sin(rad); uv[idx+1]=-speed*Math.cos(rad);
  }
  return uv;
}
function buildHumGrid(samples, sw, ne, cols, rows) {
  const h = new Float32Array(cols*rows);
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) {
    const lat=sw.lat+(r/(rows-1))*(ne.lat-sw.lat), lon=sw.lng+(c/(cols-1))*(ne.lng-sw.lng);
    h[r*cols+c] = idwScalar(lat, lon, samples, 'humidity');
  }
  return h;
}
function sampleUV(px, py) {
  const wf=S.windField; if(!wf) return {u:0,v:0};
  const W=S.windCanvas.width, H=S.windCanvas.height;
  const fc=(px/W)*(wf.cols-1), fr=((H-py)/H)*(wf.rows-1);
  const c0=Math.floor(fc),c1=Math.min(c0+1,wf.cols-1),r0=Math.floor(fr),r1=Math.min(r0+1,wf.rows-1),tc=fc-c0,tr=fr-r0;
  const ix=(r,c)=>(r*wf.cols+c)*2;
  return {
    u: lerp(lerp(wf.uv[ix(r0,c0)],  wf.uv[ix(r0,c1)],  tc), lerp(wf.uv[ix(r1,c0)],  wf.uv[ix(r1,c1)],  tc), tr),
    v: lerp(lerp(wf.uv[ix(r0,c0)+1],wf.uv[ix(r0,c1)+1],tc), lerp(wf.uv[ix(r1,c0)+1],wf.uv[ix(r1,c1)+1],tc), tr),
  };
}
function sampleHum(px, py) {
  const hf=S.humField; if(!hf) return 72;
  const W=S.humCanvas.width, H=S.humCanvas.height;
  const fc=(px/W)*(hf.cols-1), fr=((H-py)/H)*(hf.rows-1);
  const c0=Math.floor(fc),c1=Math.min(c0+1,hf.cols-1),r0=Math.floor(fr),r1=Math.min(r0+1,hf.rows-1),tc=fc-c0,tr=fr-r0;
  const g=(r,c)=>hf.h[r*hf.cols+c];
  return lerp(lerp(g(r0,c0),g(r0,c1),tc),lerp(g(r1,c0),g(r1,c1),tc),tr);
}


/* ══════════════════════════════════════════════════════
   7. WIND PARTICLES  (unchanged from v5)
══════════════════════════════════════════════════════ */
function initCanvases(){
  S.humCanvas=document.getElementById('hum-canvas'); S.windCanvas=document.getElementById('wind-canvas');
  syncCanvasSize(S.humCanvas); syncCanvasSize(S.windCanvas);
  S.humCtx=S.humCanvas.getContext('2d'); S.windCtx=S.windCanvas.getContext('2d');
}
function syncCanvasSize(c){ if(!c) return; const w=document.getElementById('map-wrap'); c.width=w.clientWidth; c.height=w.clientHeight; }
function spawnParticles(){
  const W=S.windCanvas.width, H=S.windCanvas.height;
  S.windParticles=Array.from({length:CFG.WIND.PARTICLE_COUNT},()=>({x:Math.random()*W,y:Math.random()*H,age:Math.floor(Math.random()*CFG.WIND.MAX_AGE),px:null,py:null}));
}
function startWindParticles(){
  if(S.windRAF) cancelAnimationFrame(S.windRAF);
  syncCanvasSize(S.windCanvas); S.windCtx.clearRect(0,0,S.windCanvas.width,S.windCanvas.height);
  spawnParticles();
  const canvas=S.windCanvas, ctx=S.windCtx;
  function frame(){
    if(!S.layerWind){ cancelAnimationFrame(S.windRAF); ctx.clearRect(0,0,canvas.width,canvas.height); return; }
    const W=canvas.width, H=canvas.height;
    ctx.globalCompositeOperation='destination-out'; ctx.globalAlpha=1-CFG.WIND.FADE; ctx.fillRect(0,0,W,H);
    ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
    for(const p of S.windParticles){
      const{u,v}=sampleUV(p.x,p.y), speed=Math.hypot(u,v);
      if(speed<0.08){ resetParticle(p,W,H); continue; }
      const scale=CFG.WIND.SPEED_SCALE*(W/600);
      p.px=p.x; p.py=p.y; p.x+=u*scale; p.y-=v*scale; p.age++;
      if(p.x<0||p.x>W||p.y<0||p.y>H||p.age>CFG.WIND.MAX_AGE){ resetParticle(p,W,H); continue; }
      const base=Math.min(CFG.WIND.MAX_ALPHA,CFG.WIND.MIN_ALPHA+(speed/15)*(CFG.WIND.MAX_ALPHA-CFG.WIND.MIN_ALPHA));
      ctx.beginPath(); ctx.moveTo(p.px,p.py); ctx.lineTo(p.x,p.y);
      ctx.strokeStyle=windColor(speed); ctx.lineWidth=CFG.WIND.LINE_WIDTH; ctx.globalAlpha=base*S.windOpacity; ctx.stroke();
    }
    ctx.globalAlpha=1; S.windRAF=requestAnimationFrame(frame);
  }
  frame();
}
function resetParticle(p,W,H){ p.x=Math.random()*W; p.y=Math.random()*H; p.age=0; p.px=null; p.py=null; }
function windColor(speed){
  /* Vivid, high-contrast palette — clearly visible against dark terrain */
  const s=[[0,'#6600ff'],[2,'#0055ff'],[5,'#00ccff'],[8,'#00ffbb'],[11,'#ccff00'],[14,'#ffdd00'],[17,'#ff2200']];
  for(let i=1;i<s.length;i++){ const[s0,c0]=s[i-1],[s1,c1]=s[i]; if(speed<=s1) return lerpHex(c0,c1,(speed-s0)/(s1-s0)); }
  return s[s.length-1][1];
}


/* ══════════════════════════════════════════════════════
   8. HUMIDITY CANVAS  (unchanged from v5)
══════════════════════════════════════════════════════ */
function drawHumidityCanvas(){
  if(!S.humField||!S.layerHum) return;
  syncCanvasSize(S.humCanvas);
  const W=S.humCanvas.width, H=S.humCanvas.height, img=S.humCtx.createImageData(W,H), d=img.data;
  for(let py=0;py<H;py++) for(let px=0;px<W;px++){
    const h=sampleHum(px,py), rgb=humColor(h), i=(py*W+px)*4;
    d[i]=rgb.r; d[i+1]=rgb.g; d[i+2]=rgb.b; d[i+3]=Math.round(195*S.humOpacity);
  }
  S.humCtx.putImageData(img,0,0);
}
function humColor(h){
  /* Vivid: deep red (dry) → orange → yellow → cyan → electric blue (humid) */
  const s=[[0,'#cc0000'],[30,'#ff5500'],[50,'#ffcc00'],[70,'#00ffcc'],[85,'#00aaff'],[100,'#0033ff']];
  h=Math.max(0,Math.min(100,h));
  for(let i=1;i<s.length;i++){ const[h0,c0]=s[i-1],[h1,c1]=s[i]; if(h<=h1) return hexToRgb(lerpHex(c0,c1,(h-h0)/(h1-h0))); }
  return hexToRgb(s[s.length-1][1]);
}


/* ══════════════════════════════════════════════════════
   9. OPACITY POPOVERS  (unchanged from v5)
══════════════════════════════════════════════════════ */
function initOpacityPopovers() {
  function makePopover(id, labelText, layerKey, opacityKey, onOpacityChange, onToggle) {
    const pop=document.createElement('div'); pop.id=id; pop.className='op-popover hidden';
    pop.innerHTML=`
      <div class="op-header">
        <span class="op-title">${labelText}</span>
        <button class="op-toggle ${S[layerKey]?'on':''}" data-key="${layerKey}">${S[layerKey]?'VISIBLE':'OCULTO'}</button>
      </div>
      <div class="op-row">
        <svg viewBox="0 0 14 14" fill="none" width="12"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.2" opacity="0.4"/></svg>
        <input type="range" class="op-slider" min="0" max="100" step="1" value="${Math.round(S[opacityKey]*100)}"/>
        <svg viewBox="0 0 14 14" fill="none" width="12"><circle cx="7" cy="7" r="5" fill="currentColor"/></svg>
        <span class="op-pct">${Math.round(S[opacityKey]*100)}%</span>
      </div>`;
    pop.querySelector('.op-slider').addEventListener('input', function(){
      pop.querySelector('.op-pct').textContent=this.value+'%'; S[opacityKey]=this.value/100; onOpacityChange();
    });
    pop.querySelector('.op-toggle').addEventListener('click', function(e){
      e.stopPropagation(); S[layerKey]=!S[layerKey];
      this.textContent=S[layerKey]?'VISIBLE':'OCULTO'; this.classList.toggle('on',S[layerKey]); onToggle(S[layerKey]);
    });
    document.getElementById('map-wrap').appendChild(pop); return pop;
  }
  const windPop=makePopover('windOpPop','CAPA DE VIENTO','layerWind','windOpacity',
    ()=>{},
    on=>{ document.getElementById('btnWind').classList.toggle('active',on);
          if(on) startWindParticles(); else{ cancelAnimationFrame(S.windRAF); S.windCtx.clearRect(0,0,S.windCanvas.width,S.windCanvas.height); } });
  const humPop=makePopover('humOpPop','CAPA DE HUMEDAD','layerHum','humOpacity',
    ()=>{ if(S.humField) drawHumidityCanvas(); },
    on=>{ document.getElementById('btnHum').classList.toggle('active',on);
          if(on){ if(S.humField) drawHumidityCanvas(); } else S.humCtx.clearRect(0,0,S.humCanvas.width,S.humCanvas.height); });
  let activePopover=null;
  function openPop(pop,btnEl){
    if(activePopover&&activePopover!==pop) activePopover.classList.add('hidden');
    if(pop.classList.contains('hidden')){
      const br=btnEl.getBoundingClientRect(), mr=document.getElementById('map-wrap').getBoundingClientRect();
      pop.style.bottom=(mr.bottom-br.top+8)+'px'; pop.style.left=Math.max(4,br.left-mr.left-10)+'px';
      pop.classList.remove('hidden'); activePopover=pop;
    } else { pop.classList.add('hidden'); activePopover=null; }
  }
  document.getElementById('btnWind').addEventListener('click',function(e){
    e.stopPropagation();
    /* If popover already open, just close it; otherwise toggle layer + open popover */
    if(!windPop.classList.contains('hidden')){ windPop.classList.add('hidden'); activePopover=null; return; }
    /* Toggle wind layer on/off */
    S.layerWind = !S.layerWind;
    this.classList.toggle('active', S.layerWind);
    /* Sync the popover's own toggle button text/state */
    const pt = windPop.querySelector('.op-toggle');
    pt.textContent = S.layerWind ? 'VISIBLE' : 'OCULTO';
    pt.classList.toggle('on', S.layerWind);
    if(S.layerWind) { startWindParticles(); }
    else { cancelAnimationFrame(S.windRAF); S.windCtx.clearRect(0,0,S.windCanvas.width,S.windCanvas.height); }
    /* Also open the popover so user can fine-tune opacity */
    openPop(windPop, this);
  });
  document.getElementById('btnHum').addEventListener('click', function(e){
    e.stopPropagation();
    if(!humPop.classList.contains('hidden')){ humPop.classList.add('hidden'); activePopover=null; return; }
    S.layerHum = !S.layerHum;
    this.classList.toggle('active', S.layerHum);
    const pt = humPop.querySelector('.op-toggle');
    pt.textContent = S.layerHum ? 'VISIBLE' : 'OCULTO';
    pt.classList.toggle('on', S.layerHum);
    if(S.layerHum) { if(S.humField) drawHumidityCanvas(); }
    else { S.humCtx.clearRect(0,0,S.humCanvas.width,S.humCanvas.height); }
    openPop(humPop, this);
  });
  document.addEventListener('click',e=>{ if(activePopover&&!activePopover.contains(e.target)){ activePopover.classList.add('hidden'); activePopover=null; } });
  document.getElementById('map-wrap').addEventListener('click',e=>{
    if(activePopover&&!activePopover.contains(e.target)&&!document.getElementById('btnWind').contains(e.target)&&!document.getElementById('btnHum').contains(e.target)){
      activePopover.classList.add('hidden'); activePopover=null;
    }
  });
}


/* ══════════════════════════════════════════════════════
   10. MAP CLICK  (unchanged from v5)
══════════════════════════════════════════════════════ */
async function onMapClick(lat, lng) {
  document.getElementById('click-hint').classList.add('hidden');
  placeMarker(lat,lng);
  const elevation=getElev(lat,lng);
  S.selectedPoint={lat,lon:lng,elevation};
  document.getElementById('p-empty').classList.add('hidden');
  document.getElementById('p-results').classList.add('hidden');
  document.getElementById('p-loading').classList.remove('hidden');
  try {
    const weather=await fetchPointData(lat,lng,document.getElementById('selAlt').value,S.selectedMonth);
    const coastDist=estimateCoastDist(lat,lng);
    S.weather=weather; S.coastDist=coastDist;
    S.feasibility=computeFeasibility({humidity:weather.humidity,elevation,windSpeed:weather.speed,windDir:weather.dir,coastDist});
    S.waterYield=estimateYield(weather.humidity,weather.speed,elevation);
    renderPanel({lat,lng,elevation,coastDist,weather,feasibility:S.feasibility,waterYield:S.waterYield});
    loadMonthlyChart(lat,lng);
  } catch(err){ console.error(err); renderError(err.message); }
  finally{ document.getElementById('p-loading').classList.add('hidden'); }
}


/* ══════════════════════════════════════════════════════
   11. FEASIBILITY  (unchanged from v5)
══════════════════════════════════════════════════════ */
function computeFeasibility({humidity,elevation,windSpeed,windDir,coastDist}){
  const F=CFG.F;
  const fog=humidity>=F.FOG_H?{score:100,r:'High',d:`${humidity}% HR — probable niebla densa`}:humidity>=F.FOG_M?{score:50,r:'Med',d:`${humidity}% HR — niebla intermitente posible`}:{score:0,r:'Low',d:`${humidity}% HR — humedad insuficiente`};
  let es,er,ed;
  if(elevation>=F.ELV_HI_MIN&&elevation<=F.ELV_HI_MAX){es=100;er='High';ed=`${elevation} m — banda óptima`;}
  else if((elevation>=F.ELV_ME_MIN&&elevation<F.ELV_HI_MIN)||(elevation>F.ELV_HI_MAX&&elevation<1600)){es=50;er='Med';ed=`${elevation} m — elevación marginal`;}
  else{es=0;er='Low';ed=elevation<F.ELV_ME_MIN?`${elevation} m — muy baja`:`${elevation} m — muy alta`;}
  const wc=toDirCard(windDir); let ws,wr,wd;
  if(windSpeed>=F.WIN_HI_MIN&&windSpeed<=F.WIN_HI_MAX){ws=100;wr='High';wd=`${windSpeed.toFixed(1)} m/s de ${wc} — ideal`;}
  else if((windSpeed>=F.WIN_ME_MIN&&windSpeed<F.WIN_HI_MIN)||(windSpeed>F.WIN_HI_MAX&&windSpeed<=F.WIN_ME_MAX)){ws=50;wr='Med';wd=`${windSpeed.toFixed(1)} m/s de ${wc} — marginal`;}
  else{ws=0;wr='Low';wd=`${windSpeed.toFixed(1)} m/s de ${wc} — fuera de rango`;}
  let cs,cr,cd;
  if(coastDist<=F.CST_HI){cs=100;cr='High';cd=`≈${coastDist.toFixed(1)} km — excelente`;}
  else if(coastDist<=F.CST_ME){cs=50;cr='Med';cd=`≈${coastDist.toFixed(1)} km — moderada`;}
  else{cs=0;cr='Low';cd=`≈${coastDist.toFixed(1)} km — demasiado interior`;}
  const factors=[{name:'Presencia de Niebla',score:fog.score,r:fog.r,d:fog.d},{name:'Elevación',score:es,r:er,d:ed},{name:'Velocidad del Viento',score:ws,r:wr,d:wd},{name:'Proximidad Costera',score:cs,r:cr,d:cd}];
  const minS=Math.min(...factors.map(f=>f.score)), avgS=Math.round(factors.reduce((s,f)=>s+f.score,0)/factors.length);
  const overall=Math.round(.4*minS+.6*avgS), limiting=factors.find(f=>f.score===minS);
  return{factors,overall,label:overall>=75?'Excelente':overall>=50?'Prometedor':overall>=25?'Marginal':'Desfavorable',limiting};
}


/* ══════════════════════════════════════════════════════
   12. WATER YIELD  (unchanged from v5)
══════════════════════════════════════════════════════ */
function estimateLWC(h){
  const Y=CFG.Y; if(h<Y.LWC_RH_MIN) return 0;
  let l;
  if(h>=Y.LWC_RH_HI) l=0.5+(h-Y.LWC_RH_HI)*0.10;
  else if(h>=Y.LWC_RH_MED) l=0.2+((h-Y.LWC_RH_MED)/(Y.LWC_RH_HI-Y.LWC_RH_MED))*0.30;
  else l=((h-Y.LWC_RH_MIN)/(Y.LWC_RH_MED-Y.LWC_RH_MIN))*0.20;
  return Math.min(l,Y.LWC_CAP);
}
function estimateYield(humidity,windSpeed,elevation){
  const Y=CFG.Y, lwc=estimateLWC(humidity);
  let ef=1.0;
  if(elevation<Y.ELV_OPTIMAL_MIN) ef=Math.max(0.15,elevation/Y.ELV_OPTIMAL_MIN*0.85);
  else if(elevation>Y.ELV_PEN_ABOVE) ef=Math.max(0.20,1-(elevation-Y.ELV_PEN_ABOVE)/1200);
  const wf=Math.max(0,windSpeed-0.5), daily=lwc*wf*Y.EFFICIENCY*Y.FOG_HOURS*3600/1000*ef;
  return{daily:Math.max(0,parseFloat(daily.toFixed(3))),lwc:parseFloat(lwc.toFixed(3)),windFactor:parseFloat(wf.toFixed(2)),elvFactor:parseFloat(ef.toFixed(2)),fogHours:Y.FOG_HOURS,efficiency:Y.EFFICIENCY,note:lwc<0.01?'HR insuficiente (LWC ≈ 0)':lwc<0.2?'Niebla ligera — rendimiento bajo':lwc<0.5?'Niebla moderada — rendimiento razonable':'Niebla densa — buen potencial'};
}


/* ══════════════════════════════════════════════════════
   13. MONTHLY CHART  (unchanged from v5)
══════════════════════════════════════════════════════ */
async function loadMonthlyChart(lat,lng){
  document.getElementById('chartBadge').classList.remove('hidden');
  const results=[], alt=document.getElementById('selAlt').value;
  for(let m=1;m<=12;m++){
    try{ const d=await fetchPointData(lat,lng,alt,String(m)); results.push(estimateYield(d.humidity,d.speed,S.selectedPoint?.elevation??300).daily); }
    catch(e){ console.warn(`Month ${m}:`,e.message); results.push(0); }
  }
  document.getElementById('chartBadge').classList.add('hidden');
  renderMonthChart(results);
}
function renderMonthChart(data){
  const canvas=document.getElementById('monthChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const grad=ctx.createLinearGradient(0,0,0,130);
  grad.addColorStop(0,'rgba(0,200,255,0.75)'); grad.addColorStop(0.6,'rgba(0,255,170,0.35)'); grad.addColorStop(1,'rgba(0,255,170,0.05)');
  if(S.monthChart){ S.monthChart.data.datasets[0].data=data.map(v=>v??0); S.monthChart.update(); return; }
  S.monthChart=new Chart(canvas,{type:'bar',data:{labels:['E','F','M','A','M','J','J','A','S','O','N','D'],datasets:[{data:data.map(v=>v??0),backgroundColor:grad,borderColor:'rgba(0,200,255,0.7)',borderWidth:1,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(8,10,14,.95)',titleColor:'#00c8ff',bodyColor:'#dde2ee',borderColor:'rgba(255,255,255,.08)',borderWidth:1,callbacks:{label:c=>` ${c.parsed.y.toFixed(2)} L/m²/día`}}},scales:{x:{ticks:{color:'#4a5570',font:{family:'DM Mono',size:9}},grid:{color:'rgba(255,255,255,.04)'}},y:{beginAtZero:true,ticks:{color:'#4a5570',font:{family:'DM Mono',size:9},callback:v=>v.toFixed(1)},grid:{color:'rgba(255,255,255,.04)'}}}}}); 
}


/* ══════════════════════════════════════════════════════
   14. PANEL RENDER  ← MODEL + HORA UTC rows added
══════════════════════════════════════════════════════ */
function renderPanel({lat,lng,elevation,coastDist,weather,feasibility,waterYield}){
  document.getElementById('rLat').textContent  =lat.toFixed(5)+'°';
  document.getElementById('rLon').textContent  =lng.toFixed(5)+'°';
  document.getElementById('rElev').textContent =elevation+' m';
  document.getElementById('rCoast').textContent=coastDist.toFixed(1)+' km';
  animArc(feasibility.overall);
  document.getElementById('scoreNum').textContent=feasibility.overall;
  const lbl=document.getElementById('scoreLabel'); lbl.textContent=feasibility.label; lbl.style.color=scoreColor(feasibility.overall);
  document.getElementById('scoreLim').textContent=feasibility.limiting?`⚠ Límite: ${feasibility.limiting.name}`:'';
  document.getElementById('yieldVal').textContent=waterYield.daily.toFixed(2);
  document.getElementById('yieldNote').textContent=waterYield.note;
  document.getElementById('yieldDetails').innerHTML=[
    {k:'LWC ESTIMADO',v:waterYield.lwc.toFixed(3),u:'g/m³'},
    {k:'FACTOR VIENTO',v:waterYield.windFactor.toFixed(2),u:'m/s ef.'},
    {k:'HORAS NIEBLA',v:waterYield.fogHours,u:'h/día'},
    {k:'EFICIENCIA',v:(waterYield.efficiency*100).toFixed(0),u:'%'},
  ].map(d=>`<div class="yd-item"><div class="yd-k">${d.k}</div><div class="yd-v">${d.v}<span class="yd-u">${d.u}</span></div></div>`).join('');
  const fl=document.getElementById('factorList'); fl.innerHTML='';
  feasibility.factors.forEach(f=>{
    const cls=f.r==='High'?'high':f.r==='Med'?'med':'low', lim=(f===feasibility.limiting&&feasibility.overall<75)?' lim':'';
    fl.insertAdjacentHTML('beforeend',`<div class="factor-item${lim}"><div class="fi-top"><span class="fi-name">${f.name}</span><span class="fi-badge ${cls}">${f.r==='High'?'Alto':f.r==='Med'?'Medio':'Bajo'}</span></div><div class="fi-bar"><div class="fi-bar-fill ${cls}" style="width:0%" data-w="${f.score}%"></div></div><div class="fi-detail">${f.d}</div></div>`);
  });
  requestAnimationFrame(()=>document.querySelectorAll('.fi-bar-fill').forEach(b=>{b.style.width=b.dataset.w;}));

  /* Atmospheric data grid — adds MODEL and HORA UTC rows */
  document.getElementById('atmGrid').innerHTML=[
    {k:'HUMEDAD',   v:weather.humidity,               u:'%'                              },
    {k:'VIENTO',    v:(weather.speed||0).toFixed(1),  u:'m/s'                            },
    {k:'DIRECCIÓN', v:toDirCard(weather.dir||0),      u:`${Math.round(weather.dir||0)}°` },
    {k:'TEMP',      v:(weather.temp||0).toFixed(1),   u:'°C'                             },
    {k:'MODELO',    v:S.activeModel,                  u:''                               },
    {k:'HORA UTC',  v:S.activeHour ? S.activeHour.slice(11,16) : '—', u:'UTC'           },
  ].map(i=>`<div class="atm-item"><div class="atm-k">${i.k}</div><div class="atm-v">${i.v}<span class="atm-u">${i.u}</span></div></div>`).join('');

  document.getElementById('p-results').classList.remove('hidden');
}
function renderError(msg){
  const r=document.getElementById('p-results'); r.classList.remove('hidden');
  r.innerHTML=`<div style="padding:20px;text-align:center;color:var(--danger);font-size:11px;line-height:1.7"><p style="font-size:13px;margin-bottom:8px">⚠ Error de Análisis</p><p>${esc(msg)}</p><p style="margin-top:10px;color:var(--mute)">Intenta con el mes "Actual" o espera un momento.</p></div>`;
}
function animArc(score){
  const arc=document.getElementById('scoreArc'), circ=289;
  arc.style.transition='none'; arc.style.strokeDashoffset=circ;
  requestAnimationFrame(()=>{
    arc.style.transition='stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)'; arc.style.strokeDashoffset=circ-(score/100)*circ;
    const[c1,c2]=score>=75?['#00c8ff','#00ffaa']:score>=50?['#0066ff','#00c8ff']:score>=25?['#ff9900','#ffcc00']:['#ff2244','#ff5566'];
    document.getElementById('sg0').setAttribute('stop-color',c1); document.getElementById('sg1').setAttribute('stop-color',c2);
  });
}
function scoreColor(s){ return s>=75?'#00ffaa':s>=50?'#00c8ff':s>=25?'#ffb830':'#ff4466'; }


/* ══════════════════════════════════════════════════════
   15. EXPORT  (adds modelo + hora_utc fields)
══════════════════════════════════════════════════════ */
document.getElementById('expCSV').addEventListener('click',()=>{ const d=exportData(); if(!d) return; dl([Object.keys(d).join(','),Object.values(d).map(v=>`"${v}"`).join(',')].join('\n'),'text/csv','fogharvest.csv'); });
document.getElementById('expJSON').addEventListener('click',()=>{ const d=exportData(); if(!d) return; dl(JSON.stringify(d,null,2),'application/json','fogharvest.json'); });
document.getElementById('expIMG').addEventListener('click',async()=>{ try{ const c=await html2canvas(document.getElementById('map-wrap'),{useCORS:true,scale:1,logging:false}); c.toBlob(b=>{ const u=URL.createObjectURL(b),a=document.createElement('a'); a.href=u; a.download='fogharvest-map.png'; a.click(); URL.revokeObjectURL(u); }); }catch{ alert('Captura no disponible — usa la captura de pantalla del sistema.'); } });
function exportData(){
  if(!S.selectedPoint||!S.weather||!S.feasibility){ alert('Selecciona un punto en el mapa primero.'); return null; }
  const p=S.selectedPoint,w=S.weather,f=S.feasibility,y=S.waterYield;
  return{ latitud:p.lat, longitud:p.lon, elevacion_m:p.elevation, distancia_costa_km:S.coastDist??0, mes:S.selectedMonth,
          modelo:S.activeModel, hora_utc:S.activeHour??'—',
          humedad_pct:w.humidity, viento_ms:w.speed||0, dir_viento_deg:w.dir||0, temperatura_c:w.temp||0,
          nubosidad_pct:w.cloud||0, precipitacion_mm:w.precip||0,
          lwc_g_m3:y?.lwc??0, rendimiento_l_m2_dia:y?.daily??0, eficiencia_colector:y?.efficiency??0, horas_niebla_dia:y?.fogHours??0,
          factibilidad_pct:f.overall, factibilidad_label:f.label,
          factor_niebla:f.factors[0].r, factor_elevacion:f.factors[1].r, factor_viento:f.factors[2].r, factor_costa:f.factors[3].r,
          factor_limitante:f.limiting?.name??'ninguno', timestamp:new Date().toISOString() };
}
function dl(c,m,n){ const u=URL.createObjectURL(new Blob([c],{type:m})); const a=document.createElement('a'); a.href=u; a.download=n; a.click(); URL.revokeObjectURL(u); }


/* ══════════════════════════════════════════════════════
   16. UTILITIES  ← setStatus updated for model badge
══════════════════════════════════════════════════════ */
function placeMarker(lat,lng){
  const el=document.createElement('div');
  el.innerHTML=`<svg width="30" height="30" viewBox="0 0 30 30" fill="none"><circle cx="15" cy="15" r="13" stroke="#00c8ff" stroke-width="1.3" stroke-dasharray="3 3"/><circle cx="15" cy="15" r="3.5" fill="#00c8ff"/><line x1="15" y1="1" x2="15" y2="7" stroke="#00c8ff" stroke-width="1.3"/><line x1="15" y1="23" x2="15" y2="29" stroke="#00c8ff" stroke-width="1.3"/><line x1="1" y1="15" x2="7" y2="15" stroke="#00c8ff" stroke-width="1.3"/><line x1="23" y1="15" x2="29" y2="15" stroke="#00c8ff" stroke-width="1.3"/></svg>`;
  el.style.cssText='width:30px;height:30px;cursor:pointer;';
  if(S.marker) S.marker.remove();
  S.marker=new maptilersdk.Marker({element:el,anchor:'center'}).setLngLat([lng,lat]).addTo(S.map);
}
function getElev(lat,lng){ try{ const e=S.map.queryTerrainElevation([lng,lat],{exaggerated:false}); return e!=null?Math.round(e):0; } catch{ return 0; } }
function estimateCoastDist(lat,lng){
  if(!S.map.isStyleLoaded()) return 999;
  const N=16,MAX=CFG.COAST_RADIUS_KM,STEP=0.4; let min=MAX;
  for(let b=0;b<N;b++){ const bearing=(b/N)*360; for(let km=STEP;km<=MAX;km+=STEP){ const pt=turf.destination([lng,lat],km,bearing,{units:'kilometers'}); try{ const e=S.map.queryTerrainElevation([pt.geometry.coordinates[0],pt.geometry.coordinates[1]],{exaggerated:false}); if(e!==null&&e<=10){ if(km<min)min=km; break; } }catch{ break; } } }
  return min;
}
function idwVec(lat,lon,pts,pow=2){ let su=0,sv=0,ss=0,sw=0; for(const p of pts){ const d=Math.hypot(lat-p.lat,lon-p.lon)||1e-9,w=1/Math.pow(d,pow),r=(p.dir*Math.PI)/180; su+=w*Math.sin(r);sv+=w*Math.cos(r);ss+=w*p.speed;sw+=w; } const dir=((Math.atan2(su/sw,sv/sw)*180)/Math.PI+360)%360; return{speed:ss/sw,dir}; }
function idwScalar(lat,lon,pts,key,pow=2){ let sv=0,sw=0; for(const p of pts){ if(p[key]==null) continue; const d=Math.hypot(lat-p.lat,lon-p.lon)||1e-9,w=1/Math.pow(d,pow); sv+=w*p[key];sw+=w; } return sw?sv/sw:0; }
function toDirCard(d){ return['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d/22.5)%16]; }
function lerp(a,b,t){ return a+(b-a)*t; }
function debounce(fn,ms){ let t; return(...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
function lerpHex(c1,c2,t){ t=Math.max(0,Math.min(1,t)); const p=c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)]; const a=p(c1),b=p(c2); return'#'+[0,1,2].map(i=>Math.round(a[i]+(b[i]-a[i])*t).toString(16).padStart(2,'0')).join(''); }
function hexToRgb(h){ return{r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16)}; }
function daysInMonth(y,m){ return new Date(y,m,0).getDate(); }
function pad(n){ return String(n).padStart(2,'0'); }

/**
 * Status bar — now shows model name + matched UTC hour.
 * e.g. "ICON 13km · 14:00 UTC · 80M · AHORA"
 *      "GFS (fallback) · 14:00 UTC · 80M · AHORA"
 *      "ARCHIVO · 80M · MAR"
 * @param {string}  state    'loading' | 'active' | 'error'
 * @param {string}  alt      altitude key, e.g. '80m'
 * @param {string}  month    'current' | '1'..'12'
 * @param {string}  [override]  if set, show this text directly (used for warnings)
 */
function setStatus(state, alt, month, override) {
  const dot = document.getElementById('stDot');
  const txt = document.getElementById('stText');
  dot.className = 'st-dot';

  if(override){ txt.textContent = override; return; }

  if(state === 'active'){
    dot.classList.add('on');
    const mLabel = month==='current' ? 'AHORA'
                 : ['','ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'][parseInt(month)||0];

    const modelBadge = S.activeModel === 'ARCHIVE' ? 'ARCHIVO'
                     : S.activeModel === 'GFS'     ? 'GFS (fallback)'
                     :                               'ICON 13km';
    const hourBadge  = S.activeHour ? ' · ' + S.activeHour.slice(11,16) + ' UTC' : '';

    txt.textContent = `${modelBadge}${hourBadge} · ${(alt||'').toUpperCase()} · ${mLabel}`;
  } else if(state === 'error'){
    dot.classList.add('err');
    txt.textContent = 'ERROR AL CARGAR VIENTO';
  } else {
    txt.textContent = 'CARGANDO DATOS DE VIENTO…';
  }
}

let _shown=false;
function showApp(){
  if(_shown)return; _shown=true;
  setTimeout(()=>{
    document.getElementById('loader').classList.add('out');
    setTimeout(()=>{ document.getElementById('loader').style.display='none'; document.getElementById('app').classList.remove('hidden'); setTimeout(()=>S.map&&S.map.resize(),80); },550);
  },800);
}


/* ══════════════════════════════════════════════════════
   17. BOOT  (unchanged from v5)
══════════════════════════════════════════════════════ */
document.getElementById('btnRefresh').addEventListener('click', fetchWindField);

document.getElementById('selAlt').addEventListener('change', () => {
  S.apiCache.clear(); fetchWindField();
});

document.getElementById('selMonth').addEventListener('change', e => {
  S.selectedMonth=e.target.value; S.apiCache.clear(); fetchWindField();
  if(S.selectedPoint) onMapClick(S.selectedPoint.lat, S.selectedPoint.lon);
});

document.getElementById('btnPanel').addEventListener('click', () => {
  S.panelOpen=!S.panelOpen;
  document.getElementById('panel').classList.toggle('collapsed', !S.panelOpen);
  setTimeout(()=>S.map&&S.map.resize(), 320);
});

/* Script loads at bottom of <body> — DOM is already parsed.
   Call directly; DOMContentLoaded may have already fired. */
initMap();
initSearch();
initOpacityPopovers();


/* ══════════════════════════════════════════════════════════════════════
   18. 3D WIND TUNNEL MODULE
   ──────────────────────────────────────────────────────────────────────
   Architecture:
   ┌─────────────────────────────────────────────────────────────────┐
   │  Modal overlay (#wt-overlay)                                    │
   │  ┌──────────────────────────┐ ┌───────────────────────────────┐ │
   │  │  Three.js viewport 70%   │ │  Control panel 30%            │ │
   │  │  - Scene / camera        │ │  §1 Model upload (GLB/OBJ/STL)│ │
   │  │  - OrbitControls         │ │  §2 Transform sliders         │ │
   │  │  - Potential-flow field  │ │  §3 Climate fetch (ICON)      │ │
   │  │  - Particle traces       │ │  §4 Simulation controls       │ │
   │  │  - Model mesh            │ │  §5 Results + harvest         │ │
   │  │  - Wind rose / colorbar  │ │  §6 Place on main map         │ │
   │  └──────────────────────────┘ └───────────────────────────────┘ │
   └─────────────────────────────────────────────────────────────────┘

   Physics:
   - Uniform free-stream + Rankine-sphere dipole superposed in
     ellipsoid-normalised coordinates for the potential-flow field.
   - 32×22×32 voxel grid, trilinear interpolation per particle.
   - Particles emitted from an upwind plane, Euler-advected each frame.
   - Color mapped blue (slow) → red (fast) per-particle speed.

   Harvest formula:
     Q [L/day] = LWC × v_eff × η(20%) × A [m²] × 86400 / 1000
   where v_eff is median particle speed near the model surface.
══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── Module-level state ─────────────────────────────────────────── */
  const WT = {
    /* Three.js core */
    renderer: null, scene: null, camera: null, controls: null,
    rafId:    null,

    /* Scene objects */
    modelMesh:    null,   // uploaded 3D model
    particleSystem: null, // THREE.LineSegments for trails
    gridHelper:   null,
    envBox:       null,   // wireframe bounding box
    lights:       [],

    /* Flow field (voxel grid) */
    flowGrid:  null,      // Float32Array [cx*cy*cz*3]  uvw
    flowDims:  null,      // {cx,cy,cz,ox,oy,oz,cellW,cellH,cellD}
    modelBBox: null,      // THREE.Box3 of the loaded model

    /* Particles */
    particlePositions: null,  // Float32Array [N*3] current XYZ
    particleTrails:    null,  // array of {pts:[], age, maxAge}
    particleCount: 2500,

    /* Climate */
    climate: null,        // {speed, dir, humidity, temp, month}

    /* UI flags */
    simRunning: false,
    modelLoaded: false,
  };

  /* ─── Constants ──────────────────────────────────────────────────── */
  const FLOW_CX = 32, FLOW_CY = 22, FLOW_CZ = 32;
  const PARTICLE_MAX_AGE = 180;   // frames
  const PARTICLE_DT      = 0.04;  // s per frame (≈ 25 fps target)
  const TRAIL_SEGS       = 10;    // line segments per particle trail

  /* Speed colour stops: blue → cyan → green → yellow → red */
  const SPEED_COLORS = [
    [0,    new THREE.Color(0x1a3aff)],
    [0.25, new THREE.Color(0x00c8ff)],
    [0.5,  new THREE.Color(0x00ffaa)],
    [0.75, new THREE.Color(0xaaff00)],
    [1.0,  new THREE.Color(0xff3300)],
  ];

  /* ══════════════════════════════════════════════════════
     INIT — called once when the tunnel button is clicked
  ══════════════════════════════════════════════════════ */
  function initWindTunnel() {
    openOverlay();
    if (!WT.renderer) {
      setupRenderer();
      setupScene();
      setupLights();
      setupGrid();
    }
    populateLocationTag();
    syncRunButton();  /* set initial disabled state on open */
    animate();
  }

  /* ── Open / close overlay ── */
  function openOverlay() {
    document.getElementById('wt-overlay').classList.remove('wt-hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeOverlay() {
    document.getElementById('wt-overlay').classList.add('wt-hidden');
    document.body.style.overflow = '';
    stopSim();
  }

  /* ── Three.js renderer ── */
  function setupRenderer() {
    const canvas = document.getElementById('wt-canvas');
    WT.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    WT.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    WT.renderer.setClearColor(0x07090f, 1);
    WT.renderer.shadowMap.enabled = true;
    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);
  }

  function resizeRenderer() {
    if (!WT.renderer) return;
    const vp = document.getElementById('wt-viewport');
    const w = vp.clientWidth, h = vp.clientHeight;
    WT.renderer.setSize(w, h, false);
    if (WT.camera) {
      WT.camera.aspect = w / h;
      WT.camera.updateProjectionMatrix();
    }
  }

  /* ── Scene setup ── */
  function setupScene() {
    WT.scene  = new THREE.Scene();
    WT.scene.fog = new THREE.FogExp2(0x07090f, 0.018);

    WT.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    WT.camera.position.set(14, 8, 18);

    WT.controls = new THREE.OrbitControls(WT.camera, WT.renderer.domElement);
    WT.controls.enableDamping = true;
    WT.controls.dampingFactor = 0.08;
    WT.controls.minDistance   = 2;
    WT.controls.maxDistance   = 80;
    WT.controls.target.set(0, 1.5, 0);
    WT.controls.update();
  }

  /* ── Lights ── */
  function setupLights() {
    const ambient = new THREE.AmbientLight(0x1a2030, 2.5);
    const key     = new THREE.DirectionalLight(0x8ad4ff, 2.2);
    key.position.set(5, 10, 8);
    key.castShadow = true;
    const fill    = new THREE.DirectionalLight(0x00ffaa, 0.6);
    fill.position.set(-8, 4, -6);
    const rim     = new THREE.DirectionalLight(0x00c8ff, 1.0);
    rim.position.set(0, -3, 10);
    WT.scene.add(ambient, key, fill, rim);
    WT.lights = [ambient, key, fill, rim];
  }

  /* ── Ground grid ── */
  function setupGrid() {
    const grid = new THREE.GridHelper(30, 30, 0x0d3040, 0x0d2030);
    grid.position.y = -0.01;
    WT.scene.add(grid);
    WT.gridHelper = grid;

    /* Faint ground plane */
    const planeMat  = new THREE.MeshStandardMaterial({ color: 0x060d14, roughness: 1, metalness: 0 });
    const planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), planeMat);
    planeMesh.rotation.x = -Math.PI / 2;
    planeMesh.receiveShadow = true;
    WT.scene.add(planeMesh);
  }

  /* ── Render loop ── */
  function animate() {
    WT.rafId = requestAnimationFrame(animate);
    WT.controls && WT.controls.update();
    if (WT.simRunning) stepParticles();
    WT.renderer.render(WT.scene, WT.camera);
  }

  function stopSim() {
    WT.simRunning = false;
    if (WT.rafId) { cancelAnimationFrame(WT.rafId); WT.rafId = null; }
  }


  /* ══════════════════════════════════════════════════════
     MODEL LOADING  (GLB / GLTF / OBJ / STL)
     All formats use FileReader → loader.parse(buffer/text)
     — never loader.load(blobURL) which silently hangs at r128.
  ══════════════════════════════════════════════════════ */
  function loadModel(file) {
    setSimStatus('Cargando modelo…', false);
    const ext = file.name.split('.').pop().toLowerCase();

    if (WT.modelMesh) { WT.scene.remove(WT.modelMesh); WT.modelMesh = null; }
    if (WT.envBox)    { WT.scene.remove(WT.envBox);    WT.envBox    = null; }

    /* ── Shared: called with the parsed Three.js object ── */
    const onLoaded = (object) => {
      const mesh = (object.scene || object);

      /* Normalise scale to ~6-unit cube */
      const bbox = new THREE.Box3().setFromObject(mesh);
      const size = bbox.getSize(new THREE.Vector3());
      const maxD = Math.max(size.x, size.y, size.z) || 1;
      mesh.scale.setScalar(5 / maxD);

      /* Sit on ground */
      const b2 = new THREE.Box3().setFromObject(mesh);
      mesh.position.y -= b2.min.y;

      /* Material polish */
      mesh.traverse(c => {
        if (!c.isMesh) return;
        c.castShadow = c.receiveShadow = true;
        if (!c.material) {
          c.material = new THREE.MeshStandardMaterial({ color: 0x2a6080, roughness: 0.55, metalness: 0.3, transparent: true, opacity: 0.85 });
        } else {
          c.material.transparent = true;
          c.material.opacity = Math.min(c.material.opacity != null ? c.material.opacity : 1, 0.88);
          if (!c.material.emissive) c.material.emissive = new THREE.Color(0x001428);
          else c.material.emissive.set(0x001428);
          c.material.emissiveIntensity = 0.25;
        }
      });

      WT.scene.add(mesh);
      WT.modelMesh = mesh;
      WT.modelBBox = new THREE.Box3().setFromObject(mesh);

      /* Wireframe envelope */
      const centre = WT.modelBBox.getCenter(new THREE.Vector3());
      const sz     = WT.modelBBox.getSize(new THREE.Vector3());
      const edges  = new THREE.EdgesGeometry(new THREE.BoxGeometry(sz.x*1.08, sz.y*1.08, sz.z*1.08));
      WT.envBox    = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.18 }));
      WT.envBox.position.copy(centre);
      WT.scene.add(WT.envBox);

      /* Camera */
      const cd = maxD * (5/maxD) * 3.5;
      WT.camera.position.set(cd, cd*0.6, cd*1.2);
      WT.controls.target.copy(centre);
      WT.controls.update();

      /* UI */
      WT.modelLoaded = true;
      const sz2 = WT.modelBBox.getSize(new THREE.Vector3());
      document.getElementById('wtModelInfo').textContent =
        `${file.name} · ${sz2.x.toFixed(2)} × ${sz2.y.toFixed(2)} × ${sz2.z.toFixed(2)} m`;
      document.getElementById('wtModelInfo').classList.remove('hidden');
      showSection('wtPlaceSection');
      buildFlowField();
      setSimStatus('Modelo listo — ejecuta la simulación', false);
      updateTransforms();
      syncRunButton();  /* enable Run button now model is loaded */
    };

    const onError = (err) => {
      console.error('[WT] load error:', err);
      setSimStatus('Error al cargar: ' + (err.message || err), false);
    };

    const reader = new FileReader();

    if (ext === 'glb' || ext === 'gltf') {
      /* ArrayBuffer → GLTFLoader.parse() — bypasses XHR/blob entirely */
      reader.onload = e => {
        try {
          new THREE.GLTFLoader().parse(e.target.result, '', onLoaded, onError);
        } catch(err) { onError(err); }
      };
      reader.onerror = () => onError(new Error('FileReader failed'));
      reader.readAsArrayBuffer(file);

    } else if (ext === 'obj') {
      reader.onload = e => {
        try {
          const obj = new THREE.OBJLoader().parse(e.target.result);
          obj.traverse(c => {
            if (c.isMesh && !c.material)
              c.material = new THREE.MeshStandardMaterial({ color: 0x2a6080, roughness: 0.55, metalness: 0.3 });
          });
          onLoaded(obj);
        } catch(err) { onError(err); }
      };
      reader.onerror = () => onError(new Error('FileReader failed'));
      reader.readAsText(file);

    } else if (ext === 'stl') {
      reader.onload = e => {
        try {
          const geo = new THREE.STLLoader().parse(e.target.result);
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2a6080, roughness: 0.55, metalness: 0.3, transparent: true, opacity: 0.85 }));
          mesh.castShadow = true;
          onLoaded(mesh);
        } catch(err) { onError(err); }
      };
      reader.onerror = () => onError(new Error('FileReader failed'));
      reader.readAsArrayBuffer(file);

    } else {
      setSimStatus('Formato no soportado: .' + ext, false);
    }
  }

  /* ── Model transform sliders ── */
  function updateTransforms() {
    if (!WT.modelMesh) return;
    const scale = parseFloat(document.getElementById('wtScale').value) || 1;
    const rotY  = parseFloat(document.getElementById('wtRotY').value)  || 0;
    const offX  = parseFloat(document.getElementById('wtOffX').value)  || 0;
    const offY  = parseFloat(document.getElementById('wtOffY').value)  || 0;
    const offZ  = parseFloat(document.getElementById('wtOffZ').value)  || 0;

    /* Recompute from scratch relative to centred-ground pose */
    const bbox   = new THREE.Box3().setFromObject(WT.modelMesh);
    WT.modelMesh.scale.setScalar(scale);
    WT.modelMesh.rotation.y = (rotY * Math.PI) / 180;

    /* Reset Y to ground, then apply offsets */
    const b2 = new THREE.Box3().setFromObject(WT.modelMesh);
    WT.modelMesh.position.set(offX, -b2.min.y + offY, offZ);

    WT.modelBBox = new THREE.Box3().setFromObject(WT.modelMesh);
    if (WT.envBox) {
      const centre = WT.modelBBox.getCenter(new THREE.Vector3());
      const sz     = WT.modelBBox.getSize(new THREE.Vector3());
      WT.envBox.position.copy(centre);
      WT.envBox.scale.set(sz.x * 1.08, sz.y * 1.08, sz.z * 1.08);
    }
    buildFlowField();
  }


  /* ══════════════════════════════════════════════════════
     POTENTIAL FLOW FIELD
     ────────────────────────────────────────────────────
     Uniform free-stream (in +X direction) + ellipsoid
     dipole (Rankine-sphere superposition), giving an
     irrotational potential flow around an ellipsoidal
     obstacle.  The voxel grid stores (u,v,w) per cell.
  ══════════════════════════════════════════════════════ */
  function buildFlowField() {
    const bbox = WT.modelBBox || new THREE.Box3(
      new THREE.Vector3(-3, 0, -3),
      new THREE.Vector3( 3, 3,  3)
    );
    const centre = bbox.getCenter(new THREE.Vector3());
    const size   = bbox.getSize(new THREE.Vector3());

    /* Domain: 4× model size in flow direction (X), 3× in Y/Z */
    const domW = size.x * 5.5,  domH = size.y * 4,  domD = size.z * 5.5;
    const ox   = centre.x - domW / 2;
    const oy   = Math.max(centre.y - domH / 2, -0.5);
    const oz   = centre.z - domD / 2;
    const cellW = domW / (FLOW_CX - 1);
    const cellH = domH / (FLOW_CY - 1);
    const cellD = domD / (FLOW_CZ - 1);

    WT.flowDims = { cx: FLOW_CX, cy: FLOW_CY, cz: FLOW_CZ,
                    ox, oy, oz, cellW, cellH, cellD };

    /* Half-axes with 12% inflation */
    const ax = size.x * 0.6, ay = size.y * 0.6, az = size.z * 0.6;
    const cx = centre.x, cy = centre.y, cz = centre.z;

    /* Free-stream speed (normalised; actual m/s applied in harvest calc) */
    const U = 1.0;

    /* Dipole strength: A = U * ax*ay*az for a sphere, scaled by axes */
    const A = U * ax * ay * az;

    const grid = new Float32Array(FLOW_CX * FLOW_CY * FLOW_CZ * 3);

    for (let iz = 0; iz < FLOW_CZ; iz++) {
      for (let iy = 0; iy < FLOW_CY; iy++) {
        for (let ix = 0; ix < FLOW_CX; ix++) {
          const wx = ox + ix * cellW;
          const wy = oy + iy * cellH;
          const wz = oz + iz * cellD;

          /* Ellipsoid-normalised coords */
          const dx = (wx - cx) / (ax * 1.1);
          const dy = (wy - cy) / (ay * 1.1);
          const dz = (wz - cz) / (az * 1.1);
          const r2 = dx*dx + dy*dy + dz*dz;
          const r  = Math.sqrt(r2) || 1e-9;
          const r5 = r2 * r2 * r;

          /* Potential flow: u = U(1 - A*(2x²-y²-z²)/r^5),
             v = -A*(3xy)/r^5,  w = -A*(3xz)/r^5   (Rankine sphere) */
          let u, v, w;
          if (r < 1.0) {
            /* Inside model — zero velocity */
            u = 0; v = 0; w = 0;
          } else {
            u =  U * (1 - A * (2*dx*dx - dy*dy - dz*dz) / r5);
            v = -U *      A * 3 * dx * dy / r5;
            w = -U *      A * 3 * dx * dz / r5;
          }

          const idx = (iz * FLOW_CY * FLOW_CX + iy * FLOW_CX + ix) * 3;
          grid[idx]   = u;
          grid[idx+1] = v;
          grid[idx+2] = w;
        }
      }
    }
    WT.flowGrid = grid;
  }

  /* ── Trilinear interpolation of flow field at world point ── */
  function sampleFlow(wx, wy, wz) {
    const d = WT.flowDims;
    if (!d || !WT.flowGrid) return { u: 1, v: 0, w: 0 };

    const fx = (wx - d.ox) / d.cellW;
    const fy = (wy - d.oy) / d.cellH;
    const fz = (wz - d.oz) / d.cellD;

    const ix0 = Math.max(0, Math.min(FLOW_CX-2, Math.floor(fx)));
    const iy0 = Math.max(0, Math.min(FLOW_CY-2, Math.floor(fy)));
    const iz0 = Math.max(0, Math.min(FLOW_CZ-2, Math.floor(fz)));
    const tx  = fx - ix0, ty = fy - iy0, tz = fz - iz0;

    function g(ix, iy, iz, c) {
      return WT.flowGrid[((iz * FLOW_CY + iy) * FLOW_CX + ix) * 3 + c];
    }

    const lerpC = (c) => {
      const v000=g(ix0,iy0,iz0,c),   v100=g(ix0+1,iy0,iz0,c);
      const v010=g(ix0,iy0+1,iz0,c), v110=g(ix0+1,iy0+1,iz0,c);
      const v001=g(ix0,iy0,iz0+1,c), v101=g(ix0+1,iy0,iz0+1,c);
      const v011=g(ix0,iy0+1,iz0+1,c), v111=g(ix0+1,iy0+1,iz0+1,c);
      const e00=v000+(v100-v000)*tx, e10=v010+(v110-v010)*tx;
      const e01=v001+(v101-v001)*tx, e11=v011+(v111-v011)*tx;
      const f0=e00+(e10-e00)*ty,     f1=e01+(e11-e01)*ty;
      return f0+(f1-f0)*tz;
    };

    return { u: lerpC(0), v: lerpC(1), w: lerpC(2) };
  }


  /* ══════════════════════════════════════════════════════
     PARTICLE SYSTEM
  ══════════════════════════════════════════════════════ */
  function initParticles() {
    /* Remove old system */
    if (WT.particleSystem) { WT.scene.remove(WT.particleSystem); WT.particleSystem = null; }

    WT.particleCount = parseInt(document.getElementById('wtParticles').value) || 2500;
    const N    = WT.particleCount;
    const segs = TRAIL_SEGS;
    const d    = WT.flowDims;

    /* Each particle trail = segs line segments = 2*segs vertices */
    const positions = new Float32Array(N * segs * 2 * 3);
    const colors    = new Float32Array(N * segs * 2 * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.72,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });

    WT.particleSystem = new THREE.LineSegments(geo, mat);
    WT.scene.add(WT.particleSystem);

    /* Particle state */
    WT.particles = Array.from({ length: N }, () => spawnParticle());
    WT.trailBuf  = positions;
    WT.colorBuf  = colors;
  }

  /* Spawn particle at upwind plane (x = domain min) */
  function spawnParticle() {
    const d  = WT.flowDims;
    if (!d) return { x:0, y:1, z:0, age: 0, trail: [], speeds: [] };
    const x  = d.ox + Math.random() * d.cellW * 2;          // near upwind face
    const y  = d.oy + Math.random() * (d.cy - 1) * d.cellH;
    const z  = d.oz + Math.random() * (d.cz - 1) * d.cellD;
    return { x, y, z, age: Math.floor(Math.random() * PARTICLE_MAX_AGE), trail: [], speeds: [] };
  }

  function resetParticleWT(p) {
    const d = WT.flowDims;
    if (!d) return;
    p.x   = d.ox + Math.random() * d.cellW * 2;
    p.y   = d.oy + Math.random() * (d.cy - 1) * d.cellH;
    p.z   = d.oz + Math.random() * (d.cz - 1) * d.cellD;
    p.age   = 0;
    p.trail = [];
    p.speeds = [];
  }

  function stepParticles() {
    if (!WT.particles || !WT.flowDims) return;
    const d    = WT.flowDims;
    const N    = WT.particleCount;
    const segs = TRAIL_SEGS;
    const dom  = { xMin:d.ox, xMax:d.ox+d.cellW*(FLOW_CX-1),
                   yMin:d.oy, yMax:d.oy+d.cellH*(FLOW_CY-1),
                   zMin:d.oz, zMax:d.oz+d.cellD*(FLOW_CZ-1) };

    /* Speed scalar from climate (m/s) mapped to scene units */
    const speedScale = WT.climate ? Math.max(0.5, WT.climate.speed) * 0.55 : 0.55;

    let maxSpeed = 0;
    const speedArr = [];

    for (let i = 0; i < N; i++) {
      const p = WT.particles[i];
      p.age++;

      const { u, v, w } = sampleFlow(p.x, p.y, p.z);
      const spd = Math.hypot(u, v, w);
      speedArr.push(spd);
      if (spd > maxSpeed) maxSpeed = spd;

      /* Euler advection */
      p.x += u * PARTICLE_DT * speedScale;
      p.y += v * PARTICLE_DT * speedScale;
      p.z += w * PARTICLE_DT * speedScale;

      /* Trail history */
      p.trail.push(p.x, p.y, p.z);
      p.speeds.push(spd);
      if (p.trail.length > segs * 3) {
        p.trail.splice(0, 3);
        p.speeds.splice(0, 1);
      }

      /* Respawn if out of domain or too old */
      if (p.x < dom.xMin || p.x > dom.xMax ||
          p.y < dom.yMin || p.y > dom.yMax ||
          p.z < dom.zMin || p.z > dom.zMax ||
          p.age > PARTICLE_MAX_AGE || spd < 0.001) {
        resetParticleWT(p);
      }
    }

    /* Update geometry buffers */
    const pos = WT.trailBuf;
    const col = WT.colorBuf;
    const normFactor = maxSpeed > 0 ? 1 / maxSpeed : 1;

    for (let i = 0; i < N; i++) {
      const p    = WT.particles[i];
      const base = i * segs * 2 * 3;
      const trail = p.trail;
      const nseg  = Math.floor(trail.length / 3);

      for (let s = 0; s < segs; s++) {
        const v0 = s < nseg - 1 ? s     : Math.max(0, nseg - 2);
        const v1 = s < nseg - 1 ? s + 1 : Math.max(0, nseg - 1);

        const px0 = trail[v0*3]||0, py0 = trail[v0*3+1]||0, pz0 = trail[v0*3+2]||0;
        const px1 = trail[v1*3]||0, py1 = trail[v1*3+1]||0, pz1 = trail[v1*3+2]||0;
        const off = base + s * 6;
        pos[off]   = px0; pos[off+1] = py0; pos[off+2] = pz0;
        pos[off+3] = px1; pos[off+4] = py1; pos[off+5] = pz1;

        const spd   = (p.speeds[v0] || 0) * normFactor;
        const color = speedToColor(spd);
        col[off]   = col[off+3] = color.r;
        col[off+1] = col[off+4] = color.g;
        col[off+2] = col[off+5] = color.b;
      }
    }

    const attr = WT.particleSystem.geometry.attributes;
    attr.position.needsUpdate = true;
    attr.color.needsUpdate    = true;
  }

  function speedToColor(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < SPEED_COLORS.length; i++) {
      const [t0, c0] = SPEED_COLORS[i-1];
      const [t1, c1] = SPEED_COLORS[i];
      if (t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return new THREE.Color().lerpColors(c0, c1, f);
      }
    }
    return SPEED_COLORS[SPEED_COLORS.length-1][1];
  }


  /* ══════════════════════════════════════════════════════
     CLIMATE DATA FETCH  (reuses main ICON fetchPointData)
  ══════════════════════════════════════════════════════ */
  async function fetchClimate() {
    const btn = document.getElementById('wtFetchData');
    btn.disabled = true;
    /* Show spinner in button */
    btn.innerHTML = `<span class="wt-btn-spin"></span> CARGANDO…`;
    setSimStatus('Obteniendo datos climáticos…', false);

    const month = document.getElementById('wtMonth').value;
    const lat   = S.selectedPoint?.lat  ?? CFG.CENTER[1];
    const lon   = S.selectedPoint?.lon  ?? CFG.CENTER[0];

    try {
      const d = await fetchPointData(lat, lon, '10m', month);
      WT.climate = { speed: d.speed, dir: d.dir, humidity: d.humidity, temp: d.temp, month };

      /* Update wind rose arrow */
      const arrowDeg = (d.dir + 180) % 360;
      document.getElementById('wtArrowG').setAttribute('transform', `rotate(${arrowDeg},30,30)`);

      /* Show climate grid */
      const grid = document.getElementById('wtClimateData');
      grid.innerHTML = [
        { k:'VELOCIDAD', v: d.speed.toFixed(1), u:'m/s' },
        { k:'DIRECCIÓN', v: toDirCard(d.dir),   u:`${Math.round(d.dir)}°` },
        { k:'HUMEDAD',   v: Math.round(d.humidity), u:'%' },
        { k:'TEMP',      v: d.temp.toFixed(1),  u:'°C' },
      ].map(r => `<div class="wtcg-item"><div class="wtcg-k">${r.k}</div><div class="wtcg-v">${r.v}<span class="wtcg-u"> ${r.u}</span></div></div>`).join('');
      grid.classList.remove('hidden');

      /* Enable Run button now that climate data is available */
      syncRunButton();

      buildFlowField();
      setSimStatus(`ICON 13km · ${toDirCard(d.dir)} ${d.speed.toFixed(1)} m/s · HR ${Math.round(d.humidity)}%`, false);
    } catch(err) {
      setSimStatus('Error al obtener datos: ' + err.message, false);
      console.error('[WT] Climate fetch:', err);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 14 14" fill="none" width="12"><path d="M7 2v7M4 6l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="12" x2="12" y2="12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> OBTENER DATOS DEL MES`;
    }
  }

  /* Keep Run button disabled until model is loaded */
  function syncRunButton() {
    const runBtn = document.getElementById('wtRunSim');
    const ready  = WT.modelLoaded;
    runBtn.disabled = !ready;
    runBtn.title = ready ? 'Ejecutar simulación de flujo de aire' : 'Carga un modelo 3D primero';
  }


  /* ══════════════════════════════════════════════════════
     SIMULATION RUN
  ══════════════════════════════════════════════════════ */
  function runSimulation() {
    if (!WT.modelLoaded) {
      setSimStatus('Carga un modelo 3D primero', false); return;
    }
    setSimStatus('Iniciando simulación…', true);

    buildFlowField();
    initParticles();

    WT.simRunning = true;
    if (!WT.rafId) animate();

    /* After 3 s of simulation, compute results */
    setTimeout(() => {
      const results = computeHarvestResults();
      showResults(results);
      setSimStatus(`Sim activa · ${WT.particleCount} partículas`, false);
    }, 3000);
  }


  /* ══════════════════════════════════════════════════════
     HARVEST CALCULATION
     Q [L/day] = LWC × v_eff × η × A × 86400 / 1000
  ══════════════════════════════════════════════════════ */
  function computeHarvestResults() {
    const climate   = WT.climate || { speed: 4.5, dir: 270, humidity: 82, temp: 15 };
    const windSpeed = climate.speed;
    const humidity  = climate.humidity;

    /* Effective area: manual input or bounding-box projected area */
    const manualArea = parseFloat(document.getElementById('wtAreaInput').value) || 0;
    let area;
    if (manualArea > 0) {
      area = manualArea;
    } else if (WT.modelBBox) {
      const sz = WT.modelBBox.getSize(new THREE.Vector3());
      /* Projected area perpendicular to wind (X-direction in scene) = Y × Z */
      area = sz.y * sz.z;
    } else {
      area = 1.0;
    }

    /* LWC estimation (same as main map) */
    const lwc = estimateLWC(humidity);

    /* Effective speed from flow perturbation near model surface */
    const vEff = Math.max(0.5, windSpeed * 0.85);

    /* Efficiency 20% */
    const eta   = 0.20;
    const daily = lwc * vEff * eta * area * 86400 / 1000;

    /* Peak speed ratio: sample a few points in model wake */
    let peakRatio = 1.0;
    if (WT.modelBBox && WT.flowDims) {
      const centre = WT.modelBBox.getCenter(new THREE.Vector3());
      const sz     = WT.modelBBox.getSize(new THREE.Vector3());
      let maxSpd = 0;
      for (let t = 0; t < 8; t++) {
        const wx = centre.x + sz.x * (0.6 + t * 0.1);
        const wy = centre.y;
        const wz = centre.z + sz.z * (Math.random() - 0.5) * 0.8;
        const { u, v, w } = sampleFlow(wx, wy, wz);
        const spd = Math.hypot(u, v, w);
        if (spd > maxSpd) maxSpd = spd;
      }
      peakRatio = maxSpd > 0 ? maxSpd : 1.0;
    }

    return {
      area:      area.toFixed(2),
      lwc:       lwc.toFixed(3),
      vEff:      vEff.toFixed(2),
      daily:     Math.max(0, daily).toFixed(2),
      peakRatio: peakRatio.toFixed(2),
      monthly:   (Math.max(0, daily) * 30).toFixed(1),
    };
  }

  function showResults(r) {
    document.getElementById('wtResultsGrid').innerHTML = [
      { k:'ÁREA',          v: r.area,      u:'m²'   },
      { k:'LWC',           v: r.lwc,       u:'g/m³' },
      { k:'V EFECTIVA',    v: r.vEff,      u:'m/s'  },
      { k:'PICO FLUJO',    v: r.peakRatio, u:'×'    },
    ].map(row => `<div class="wtrg-item"><div class="wtrg-k">${row.k}</div><div class="wtrg-v">${row.v}<span class="wtrg-u"> ${row.u}</span></div></div>`).join('');

    document.getElementById('wtHarvestBox').innerHTML = `
      <div class="wt-harvest-num">${r.daily}</div>
      <div class="wt-harvest-unit">L / m² / día</div>
      <div class="wt-harvest-sub">≈ ${r.monthly} L / mes · η = 20%</div>`;

    showSection('wtResultsSection');
  }


  /* ══════════════════════════════════════════════════════
     PLACE ON MAIN MAP
  ══════════════════════════════════════════════════════ */
  function placeOnMainMap() {
    if (!S.selectedPoint) {
      alert('Haz clic primero en un punto del mapa principal.'); return;
    }
    const { lat, lon } = S.selectedPoint;

    /* Create a custom SVG marker */
    const el  = document.createElement('div');
    el.className = 'wt-map-marker';
    el.title  = '3D Wind Tunnel Model';
    el.innerHTML = `
      <svg viewBox="0 0 32 32" fill="none" width="32">
        <rect x="2" y="9" width="28" height="14" rx="3" stroke="#00ffaa" stroke-width="1.4"/>
        <path d="M2 16h28M9 9v14M23 9v14" stroke="#00ffaa" stroke-width="0.9" opacity="0.5"/>
        <path d="M28 12L31 16l-3 4" stroke="#00c8ff" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="16" cy="16" r="2.5" fill="#00ffaa" opacity="0.85"/>
      </svg>`;

    new maptilersdk.Marker({ element: el, anchor: 'center' })
      .setLngLat([lon, lat])
      .addTo(S.map);

    S.map.flyTo({
      center:   [lon, lat],
      zoom:     15,
      pitch:    CFG.PITCH,
      bearing:  CFG.BEARING,
      duration: 1600,
    });

    closeOverlay();
  }


  /* ══════════════════════════════════════════════════════
     UI HELPERS
  ══════════════════════════════════════════════════════ */
  function setSimStatus(msg, spinning) {
    const el = document.getElementById('wt-sim-status');
    el.textContent = msg;
    el.classList.remove('wt-status-hidden');
    el.style.opacity = '1';
    if (spinning) el.style.animation = 'none';
  }

  function showSection(id) {
    document.getElementById(id).classList.remove('wtp-hidden');
  }

  function populateLocationTag() {
    const tag = document.getElementById('wtLocTag');
    if (S.selectedPoint) {
      tag.textContent = `${S.selectedPoint.lat.toFixed(4)}°, ${S.selectedPoint.lon.toFixed(4)}°`;
    } else {
      tag.textContent = 'Sin ubicación — haz clic en el mapa primero';
    }
  }

  /* Drag-and-drop on drop zone */
  function setupDragDrop() {
    const zone = document.getElementById('wtUploadArea');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) loadModel(file);
    });
  }


  /* ══════════════════════════════════════════════════════
     WIRE UP ALL EVENT LISTENERS
  ══════════════════════════════════════════════════════ */
  function wireEvents() {
    /* Open / close */
    document.getElementById('btnWindTunnel').addEventListener('click', initWindTunnel);
    document.getElementById('wt-close').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' &&
          !document.getElementById('wt-overlay').classList.contains('wt-hidden')) {
        closeOverlay();
      }
    });
    /* Click on overlay backdrop (not modal) */
    document.getElementById('wt-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('wt-overlay')) closeOverlay();
    });

    /* File input */
    document.getElementById('wtFileInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadModel(file);
    });

    /* Transform sliders */
    ['wtScale','wtRotY','wtOffX','wtOffY','wtOffZ'].forEach(id => {
      const el  = document.getElementById(id);
      const val = document.getElementById(id + 'Val');
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        if      (id === 'wtScale') val.textContent = v.toFixed(2) + '×';
        else if (id === 'wtRotY')  val.textContent = Math.round(v) + '°';
        else                       val.textContent = v.toFixed(1);
        updateTransforms();
      });
    });

    /* Particle count slider */
    document.getElementById('wtParticles').addEventListener('input', function() {
      document.getElementById('wtParticlesVal').textContent = this.value;
    });

    /* Climate fetch */
    document.getElementById('wtFetchData').addEventListener('click', fetchClimate);

    /* Run simulation */
    document.getElementById('wtRunSim').addEventListener('click', runSimulation);

    /* Place on map */
    document.getElementById('wtPlaceOnMap').addEventListener('click', placeOnMainMap);

    /* Drag and drop */
    setupDragDrop();
  }

  /* Script is at bottom of <body> — DOM already parsed, call directly */
  wireEvents();

})(); /* end IIFE */


/* ══════════════════════════════════════════════════════════════════════
   19. ARCHITECTURE-SCALE WIND SIMULATION MODULE
   ──────────────────────────────────────────────────────────────────────
   A completely separate popup interface designed for building/urban-scale
   wind analysis (1 scene unit = 1 real-world metre).

   Key differences from §18 Wind Tunnel:
   ┌─────────────────────────────────────────────────────────────────┐
   │  Wind Tunnel (§18)              │  Arch Sim (§19)              │
   │─────────────────────────────────│──────────────────────────────│
   │  Object scale (cm–m)            │  Building scale (m–100m)     │
   │  #wt-overlay, cyan theme        │  #arch-overlay, amber theme  │
   │  Location from main map click   │  Manual lat/lon input + map  │
   │  Domain ~5× model size          │  Domain ~8× building footprt │
   │  32×22×32 flow grid             │  48×32×48 flow grid          │
   │  Streamlines only               │  Streamlines + pressure field│
   │  No scale calibration           │  Real-height/width cal.      │
   │  No context buildings           │  Surrounding context cubes   │
   │  Single panel                   │  3-column: viewport + 2 pan. │
   └─────────────────────────────────┴──────────────────────────────┘

   Physics:  Same potential-flow model as §18 (Rankine sphere + ellipsoid
             dipole), but domain and grid are sized for building scale.
             Pressure field: p = 0.5 * ρ * (U² - |v|²)  (Bernoulli)
             rendered as a semi-transparent colour mesh on the ground plane.

   Formats:  GLB (preferred), GLTF, OBJ, STL.
             FBX / 3DS / SKP must be exported to GLB externally — the UI
             explains this clearly with conversion notes.

   Harvest:  Q [L/day] = LWC × v_eff × η(20%) × A × 86400 / 1000
             Area = bounding-box face ⊥ to wind, or manual override.
══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── Module state ─────────────────────────────────────────────── */
  const AS = {
    /* Three.js */
    renderer: null, scene: null, camera: null, controls: null, rafId: null,

    /* Scene objects */
    modelMesh:    null,
    envBox:       null,
    contextMeshes: [],
    pressureMesh: null,
    particleSys:  null,
    groundPlane:  null,

    /* Flow */
    flowGrid: null,
    flowDims: null,
    modelBBox: null,

    /* Particles */
    particles:    null,
    trailBuf:     null,
    colorBuf:     null,
    particleCount: 3000,

    /* Climate / location */
    climate: null,
    location: null,   // {lat, lon, elev, name}

    /* Scale calibration */
    realHeight: null,
    realWidth:  null,
    sceneScale: 1,    // metres per scene unit after calibration

    /* UI */
    simRunning:   false,
    modelLoaded:  false,
    activeView:   'streamlines',   // 'streamlines' | 'pressure'
  };

  /* ─── Constants ──────────────────────────────────────────────── */
  const AFC = 48, AFCY = 32, AFCZ = 48;   // flow grid resolution
  const A_MAX_AGE = 220;
  const A_DT      = 0.035;
  const A_TRAIL   = 12;
  const RHO_AIR   = 1.20;   // kg/m³

  const A_SPEED_STOPS = [
    [0,    new THREE.Color(0x1a3aff)],
    [0.2,  new THREE.Color(0x00c8ff)],
    [0.5,  new THREE.Color(0x00ffaa)],
    [0.75, new THREE.Color(0xf5a623)],
    [1.0,  new THREE.Color(0xff3300)],
  ];

  /* ══════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════ */
  function initArchSim() {
    openArchOverlay();
    if (!AS.renderer) {
      setupArchRenderer();
      setupArchScene();
      setupArchLights();
      setupArchGround();
    }
    populateArchLocationFromMap();
    archAnimate();
  }

  function openArchOverlay() {
    document.getElementById('arch-overlay').classList.remove('arch-hidden');
    document.body.style.overflow = 'hidden';
    setArchStatus('READY', 'idle');
  }
  function closeArchOverlay() {
    document.getElementById('arch-overlay').classList.add('arch-hidden');
    document.body.style.overflow = '';
    stopArchSim();
  }

  /* ── Renderer ── */
  function setupArchRenderer() {
    const canvas = document.getElementById('arch-canvas');
    AS.renderer  = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    AS.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    AS.renderer.setClearColor(0x050709, 1);
    AS.renderer.shadowMap.enabled = true;
    AS.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    archResizeRenderer();
    window.addEventListener('resize', archResizeRenderer);
  }

  function archResizeRenderer() {
    if (!AS.renderer) return;
    const vp = document.getElementById('arch-viewport');
    const w  = vp.clientWidth, h = vp.clientHeight;
    AS.renderer.setSize(w, h, false);
    if (AS.camera) {
      AS.camera.aspect = w / h;
      AS.camera.updateProjectionMatrix();
    }
  }

  /* ── Scene ── */
  function setupArchScene() {
    AS.scene  = new THREE.Scene();
    AS.scene.fog = new THREE.FogExp2(0x050709, 0.009);

    AS.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    AS.camera.position.set(60, 40, 80);

    AS.controls = new THREE.OrbitControls(AS.camera, AS.renderer.domElement);
    AS.controls.enableDamping = true;
    AS.controls.dampingFactor = 0.07;
    AS.controls.minDistance   = 5;
    AS.controls.maxDistance   = 600;
    AS.controls.target.set(0, 10, 0);
    AS.controls.update();
  }

  /* ── Lights ── */
  function setupArchLights() {
    const ambient = new THREE.AmbientLight(0x1a1f2e, 3.0);

    const sun  = new THREE.DirectionalLight(0xffd080, 2.5);
    sun.position.set(50, 80, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near  = 1;
    sun.shadow.camera.far   = 300;
    sun.shadow.camera.left  = -100;
    sun.shadow.camera.right =  100;
    sun.shadow.camera.top   =  100;
    sun.shadow.camera.bottom = -100;

    const fill = new THREE.DirectionalLight(0x2060a0, 0.8);
    fill.position.set(-40, 20, -50);

    const rim  = new THREE.DirectionalLight(0xf5a623, 0.5);
    rim.position.set(0, -10, 60);

    AS.scene.add(ambient, sun, fill, rim);
  }

  /* ── Ground + grid ── */
  function setupArchGround() {
    /* Grid: 200m × 200m, 2m cells */
    const grid = new THREE.GridHelper(200, 100, 0x1a2530, 0x101820);
    grid.position.y = 0;
    AS.scene.add(grid);

    /* Ground plane */
    const gMat  = new THREE.MeshStandardMaterial({
      color: 0x070e14, roughness: 0.95, metalness: 0,
    });
    const gMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), gMat);
    gMesh.rotation.x = -Math.PI / 2;
    gMesh.receiveShadow = true;
    gMesh.position.y   = -0.01;
    AS.scene.add(gMesh);
    AS.groundPlane = gMesh;

    /* Subtle horizon line */
    const hLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-200, 0, 0), new THREE.Vector3(200, 0, 0)
      ]),
      new THREE.LineBasicMaterial({ color: 0xf5a623, transparent: true, opacity: 0.08 })
    );
    AS.scene.add(hLine);
  }

  /* ── Context buildings (schematic cubes around the subject model) ── */
  function buildContextBuildings() {
    /* Remove old */
    AS.contextMeshes.forEach(m => AS.scene.remove(m));
    AS.contextMeshes = [];

    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x0d1826, roughness: 0.8, metalness: 0.1,
      transparent: true, opacity: 0.55,
    });
    /* Scatter ~16 context buildings in a ring 40–120m away */
    const positions = [
      [-50,0,30],[50,0,30],[-40,0,-50],[60,0,-40],[-70,0,-20],[80,0,10],
      [-30,0,70],[40,0,80],[-80,0,50],[90,0,-70],[-60,0,-80],[70,0,-90],
      [0,0,-80],[0,0,90],[-100,0,0],[100,0,-30],
    ];
    const sizes = [
      [12,25,12],[18,35,14],[10,20,10],[22,45,20],[8,18,8],[16,30,16],
      [14,22,12],[20,40,18],[12,28,10],[24,38,22],[10,15,10],[18,32,16],
      [16,28,14],[20,50,18],[15,25,12],[22,42,20],
    ];
    positions.forEach(([x,y,z], i) => {
      const [w,h,d] = sizes[i];
      const geo  = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, boxMat);
      mesh.position.set(x, h/2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      AS.scene.add(mesh);
      AS.contextMeshes.push(mesh);

      /* Wireframe outline on each context building */
      const edges = new THREE.EdgesGeometry(geo);
      const wire  = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
        color: 0xf5a623, transparent: true, opacity: 0.07
      }));
      wire.position.copy(mesh.position);
      AS.scene.add(wire);
      AS.contextMeshes.push(wire);
    });
  }

  /* ── Render loop ── */
  function archAnimate() {
    AS.rafId = requestAnimationFrame(archAnimate);
    AS.controls && AS.controls.update();
    if (AS.simRunning) stepArchParticles();
    AS.renderer.render(AS.scene, AS.camera);
  }

  function stopArchSim() {
    AS.simRunning = false;
    if (AS.rafId) { cancelAnimationFrame(AS.rafId); AS.rafId = null; }
  }


  /* ══════════════════════════════════════════════════════
     MODEL LOADING  (GLB / GLTF / OBJ / STL)
     Same loaders as §18, but scale calibration applied
     after load using real-height / real-width inputs.
  ══════════════════════════════════════════════════════ */
  function archLoadModel(file) {
    setArchStatus('LOADING MODEL…', 'running');
    const ext = file.name.split('.').pop().toLowerCase();

    if (AS.modelMesh) { AS.scene.remove(AS.modelMesh); AS.modelMesh = null; }
    if (AS.envBox)    { AS.scene.remove(AS.envBox);    AS.envBox    = null; }

    const onLoaded = (object) => {
      const mesh = object.scene || object;

      /* Default normalise: fit in 30m cube */
      const bbox0 = new THREE.Box3().setFromObject(mesh);
      const size0 = bbox0.getSize(new THREE.Vector3());
      const maxD  = Math.max(size0.x, size0.y, size0.z) || 1;
      const norm  = 30 / maxD;
      mesh.scale.setScalar(norm);

      /* Lift to ground */
      const bLift = new THREE.Box3().setFromObject(mesh);
      mesh.position.y -= bLift.min.y;

      /* Material polish */
      mesh.traverse(c => {
        if (!c.isMesh) return;
        c.castShadow = c.receiveShadow = true;
        if (!c.material) {
          c.material = new THREE.MeshStandardMaterial({
            color: 0x2a4060, roughness: 0.6, metalness: 0.25
          });
        } else {
          if (c.material.color) c.material.color.multiplyScalar(0.9);
          c.material.roughness    = Math.max(c.material.roughness || 0.5, 0.4);
          c.material.transparent  = true;
          c.material.opacity      = Math.min(c.material.opacity || 1, 0.92);
          if (!c.material.emissive) c.material.emissive = new THREE.Color(0x0a1428);
          else c.material.emissive.lerp(new THREE.Color(0x0a1428), 0.4);
          c.material.emissiveIntensity = 0.3;
        }
      });

      AS.scene.add(mesh);
      AS.modelMesh  = mesh;
      AS.modelBBox  = new THREE.Box3().setFromObject(mesh);
      AS.sceneScale = 1;

      /* Wireframe envelope */
      const sz  = AS.modelBBox.getSize(new THREE.Vector3());
      const ctr = AS.modelBBox.getCenter(new THREE.Vector3());
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(sz.x*1.06, sz.y*1.06, sz.z*1.06));
      AS.envBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
        color: 0xf5a623, transparent: true, opacity: 0.22
      }));
      AS.envBox.position.copy(ctr);
      AS.scene.add(AS.envBox);

      /* Fly camera */
      const cd = Math.max(sz.x, sz.y, sz.z) * 3.5;
      AS.camera.position.set(cd, cd * 0.7, cd * 1.5);
      AS.controls.target.copy(ctr);
      AS.controls.update();

      /* Context buildings */
      buildContextBuildings();

      /* Flow field */
      buildArchFlowField();
      applyRealScale();

      /* Update UI */
      AS.modelLoaded = true;
      const sz2 = AS.modelBBox.getSize(new THREE.Vector3());
      document.getElementById('archModelInfo').innerHTML =
        `<strong>${file.name}</strong><br>${sz2.x.toFixed(1)} × ${sz2.y.toFixed(1)} × ${sz2.z.toFixed(1)} m (approx)`;
      document.getElementById('archModelInfo').classList.remove('hidden');
      document.getElementById('archHudModel').textContent = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0,16);
      updateArchHudScale();
      showArchSection('archPlaceSection');
      setArchStatus('MODEL READY', 'done');
    };

    const onError = err => {
      console.error('[AS] Model load error:', err);
      setArchStatus('LOAD ERROR: ' + (err.message || err), 'error');
    };

    const reader = new FileReader();

    if (ext === 'glb' || ext === 'gltf') {
      /* ArrayBuffer → GLTFLoader.parse() — bypasses XHR/blob entirely */
      reader.onload = e => {
        try {
          new THREE.GLTFLoader().parse(e.target.result, '', onLoaded, onError);
        } catch(err) { onError(err); }
      };
      reader.onerror = () => onError(new Error('FileReader failed'));
      reader.readAsArrayBuffer(file);
    } else if (ext === 'obj') {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const obj = new THREE.OBJLoader().parse(e.target.result);
          obj.traverse(c => {
            if (c.isMesh && !c.material)
              c.material = new THREE.MeshStandardMaterial({ color: 0x2a4060, roughness: 0.6, metalness: 0.25 });
          });
          onLoaded(obj);
        } catch(err) { onError(err); }
      };
      reader.onerror = onError;
      reader.readAsText(file);
    } else if (ext === 'stl') {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const geo = new THREE.STLLoader().parse(e.target.result);
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: 0x2a4060, roughness: 0.6, metalness: 0.25, transparent: true, opacity: 0.9
          }));
          mesh.castShadow = true;
          onLoaded(mesh);
        } catch(err) { onError(err); }
      };
      reader.onerror = onError;
      reader.readAsArrayBuffer(file);
    } else {
      setArchStatus('UNSUPPORTED FORMAT', 'error');
    }
  }

  /* ── Apply real-world scale from height/width inputs ── */
  function applyRealScale() {
    if (!AS.modelMesh || !AS.modelBBox) return;
    const realH  = parseFloat(document.getElementById('archBldgHeight').value) || 0;
    const realW  = parseFloat(document.getElementById('archBldgWidth').value)  || 0;
    if (realH <= 0 && realW <= 0) {
      updateArchHudScale();
      buildArchFlowField();
      return;
    }

    const sz = AS.modelBBox.getSize(new THREE.Vector3());
    let desiredScale = AS.modelMesh.scale.x;

    if (realH > 0) desiredScale *= realH / sz.y;
    else if (realW > 0) desiredScale *= realW / Math.max(sz.x, sz.z);

    AS.modelMesh.scale.setScalar(desiredScale);
    const b = new THREE.Box3().setFromObject(AS.modelMesh);
    AS.modelMesh.position.y -= b.min.y;
    AS.modelBBox = new THREE.Box3().setFromObject(AS.modelMesh);

    /* Update envelope */
    if (AS.envBox) {
      const ctr2 = AS.modelBBox.getCenter(new THREE.Vector3());
      const sz2  = AS.modelBBox.getSize(new THREE.Vector3());
      AS.envBox.position.copy(ctr2);
      AS.envBox.scale.set(sz2.x * 1.06, sz2.y * 1.06, sz2.z * 1.06);
    }

    /* Fly camera to new size */
    const sz3 = AS.modelBBox.getSize(new THREE.Vector3());
    const cd  = Math.max(sz3.x, sz3.y, sz3.z) * 3;
    AS.camera.position.set(cd, cd * 0.6, cd * 1.4);
    AS.controls.target.copy(AS.modelBBox.getCenter(new THREE.Vector3()));
    AS.controls.update();

    updateArchHudScale();
    buildArchFlowField();
    setArchStatus('SCALE APPLIED', 'done');
  }

  /* ── Transform sliders ── */
  function updateArchTransforms() {
    if (!AS.modelMesh) return;
    const scale = parseFloat(document.getElementById('archScale').value)     || 1;
    const rotY  = parseFloat(document.getElementById('archRotY').value)      || 0;
    const elevOff = parseFloat(document.getElementById('archElevOff').value) || 0;

    AS.modelMesh.scale.setScalar(scale);
    AS.modelMesh.rotation.y = (rotY * Math.PI) / 180;

    const b = new THREE.Box3().setFromObject(AS.modelMesh);
    AS.modelMesh.position.y = -b.min.y + elevOff;

    AS.modelBBox = new THREE.Box3().setFromObject(AS.modelMesh);
    if (AS.envBox) {
      const ctr = AS.modelBBox.getCenter(new THREE.Vector3());
      const sz  = AS.modelBBox.getSize(new THREE.Vector3());
      AS.envBox.position.copy(ctr);
      AS.envBox.scale.set(sz.x * 1.06, sz.y * 1.06, sz.z * 1.06);
    }
    buildArchFlowField();
  }


  /* ══════════════════════════════════════════════════════
     POTENTIAL FLOW FIELD  (architecture scale)
     Same physics as §18 but:
     - 48×32×48 grid (higher resolution)
     - Domain is 8× building footprint in wind direction
     - Ground boundary: v(y=0) = 0 via mirror-image method
  ══════════════════════════════════════════════════════ */
  function buildArchFlowField() {
    const bbox = AS.modelBBox || new THREE.Box3(
      new THREE.Vector3(-15, 0, -15), new THREE.Vector3(15, 30, 15)
    );
    const centre = bbox.getCenter(new THREE.Vector3());
    const size   = bbox.getSize(new THREE.Vector3());

    /* Domain sized for building-scale: wider in wind direction (+X) */
    const domW = size.x * 8;
    const domH = size.y * 5;
    const domD = size.z * 8;
    const ox   = centre.x - domW * 0.35;   // asymmetric: more wake room
    const oy   = 0;
    const oz   = centre.z - domD / 2;

    const cellW = domW / (AFC  - 1);
    const cellH = domH / (AFCY - 1);
    const cellD = domD / (AFCZ - 1);

    AS.flowDims = { cx:AFC, cy:AFCY, cz:AFCZ, ox, oy, oz, cellW, cellH, cellD };

    /* Ellipsoid half-axes (inflated 15% over bounding box) */
    const ax = size.x * 0.65, ay = size.y * 0.65, az = size.z * 0.65;
    const cx = centre.x, cy = centre.y, cz = centre.z;
    const U  = 1.0, A = U * ax * ay * az;

    const grid = new Float32Array(AFC * AFCY * AFCZ * 3);

    for (let iz = 0; iz < AFCZ; iz++) {
      for (let iy = 0; iy < AFCY; iy++) {
        for (let ix = 0; ix < AFC; ix++) {
          const wx = ox + ix * cellW;
          const wy = oy + iy * cellH;
          const wz = oz + iz * cellD;

          /* Real-image method: mirror about ground plane to enforce v(y=0)=0 */
          function dipole(dx, dy, dz) {
            const r2 = dx*dx + dy*dy + dz*dz;
            const r  = Math.sqrt(r2) || 1e-9;
            const r5 = r2 * r2 * r;
            return {
              u:  U * (1 - A*(2*dx*dx - dy*dy - dz*dz) / r5),
              v: -U *      A * 3 * dx * dy / r5,
              w: -U *      A * 3 * dx * dz / r5,
            };
          }

          const dxR = (wx - cx) / (ax * 1.12);
          const dyR = (wy - cy) / (ay * 1.12);
          const dzR = (wz - cz) / (az * 1.12);
          const rR  = Math.sqrt(dxR*dxR + dyR*dyR + dzR*dzR);

          /* Image point: reflected below ground */
          const dxI = (wx - cx)  / (ax * 1.12);
          const dyI = (wy + cy)  / (ay * 1.12);  // mirror y
          const dzI = (wz - cz)  / (az * 1.12);

          let u, v, w;
          if (rR < 1.0) {
            u = 0; v = 0; w = 0;
          } else {
            const d1 = dipole(dxR, dyR, dzR);
            const d2 = dipole(dxI, dyI, dzI);
            u = (d1.u + d2.u) * 0.5;
            v = (d1.v - d2.v) * 0.5;   // antisymmetric in v
            w = (d1.w + d2.w) * 0.5;
            /* Clamp to reasonable range */
            u = Math.max(-3, Math.min(3, u));
            v = Math.max(-3, Math.min(3, v));
            w = Math.max(-3, Math.min(3, w));
          }

          /* Ground slip: damp v near ground */
          const groundDamp = Math.min(1, wy / Math.max(0.5, ay * 0.3));
          v *= groundDamp;

          const idx = (iz * AFCY * AFC + iy * AFC + ix) * 3;
          grid[idx]   = u;
          grid[idx+1] = v;
          grid[idx+2] = w;
        }
      }
    }
    AS.flowGrid = grid;

    /* Rebuild pressure mesh if in pressure view */
    if (AS.activeView === 'pressure') buildPressureMesh();
  }

  /* ── Trilinear interpolation ── */
  function sampleArchFlow(wx, wy, wz) {
    const d = AS.flowDims;
    if (!d || !AS.flowGrid) return { u:1, v:0, w:0 };

    const fx = (wx - d.ox) / d.cellW;
    const fy = (wy - d.oy) / d.cellH;
    const fz = (wz - d.oz) / d.cellD;

    const ix0 = Math.max(0, Math.min(AFC-2,  Math.floor(fx)));
    const iy0 = Math.max(0, Math.min(AFCY-2, Math.floor(fy)));
    const iz0 = Math.max(0, Math.min(AFCZ-2, Math.floor(fz)));
    const tx  = fx-ix0, ty = fy-iy0, tz = fz-iz0;

    const g = (ix,iy,iz,c) => AS.flowGrid[((iz*AFCY+iy)*AFC+ix)*3+c];
    const lerpC = c => {
      const v000=g(ix0,iy0,iz0,c),   v100=g(ix0+1,iy0,iz0,c);
      const v010=g(ix0,iy0+1,iz0,c), v110=g(ix0+1,iy0+1,iz0,c);
      const v001=g(ix0,iy0,iz0+1,c), v101=g(ix0+1,iy0,iz0+1,c);
      const v011=g(ix0,iy0+1,iz0+1,c), v111=g(ix0+1,iy0+1,iz0+1,c);
      const e00=v000+(v100-v000)*tx, e10=v010+(v110-v010)*tx;
      const e01=v001+(v101-v001)*tx, e11=v011+(v111-v011)*tx;
      return (e00+(e10-e00)*ty)*(1-tz) + (e01+(e11-e01)*ty)*tz;
    };
    return { u:lerpC(0), v:lerpC(1), w:lerpC(2) };
  }


  /* ══════════════════════════════════════════════════════
     PRESSURE FIELD MESH  (ground-level colour map)
     p = ½ρ(U² - |v|²)  — Bernoulli
     Rendered as a fine quad mesh on the ground plane.
  ══════════════════════════════════════════════════════ */
  function buildPressureMesh() {
    if (AS.pressureMesh) { AS.scene.remove(AS.pressureMesh); AS.pressureMesh = null; }
    const d = AS.flowDims;
    if (!d) return;

    const RES = 60;
    const xs  = d.ox, xe = d.ox + d.cellW * (AFC-1);
    const zs  = d.oz, ze = d.oz + d.cellD * (AFCZ-1);
    const dx  = (xe - xs) / (RES - 1);
    const dz  = (ze - zs) / (RES - 1);

    /* Sample pressure at y = 1m (low height) */
    const Y_SAMPLE = 1.0;
    let pMin = Infinity, pMax = -Infinity;
    const pArr = new Float32Array(RES * RES);
    for (let iz = 0; iz < RES; iz++) {
      for (let ix = 0; ix < RES; ix++) {
        const wx = xs + ix * dx;
        const wz = zs + iz * dz;
        const { u, v, w } = sampleArchFlow(wx, Y_SAMPLE, wz);
        const spd2 = u*u + v*v + w*w;
        const p    = 0.5 * RHO_AIR * (1.0 - spd2);
        pArr[iz * RES + ix] = p;
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
      }
    }

    /* Build PlaneGeometry with vertex colors */
    const geo = new THREE.PlaneGeometry(xe-xs, ze-zs, RES-1, RES-1);
    geo.rotateX(-Math.PI / 2);
    const colours = new Float32Array(RES * RES * 3);
    const pRange  = pMax - pMin || 1;
    for (let i = 0; i < RES * RES; i++) {
      const t   = (pArr[i] - pMin) / pRange;
      const col = pressureColor(t);
      colours[i*3]   = col.r;
      colours[i*3+1] = col.g;
      colours[i*3+2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    AS.pressureMesh = new THREE.Mesh(geo, mat);
    AS.pressureMesh.position.set((xs+xe)*0.5, 0.05, (zs+ze)*0.5);
    AS.scene.add(AS.pressureMesh);

    /* Update colorbar labels */
    const windSpd = AS.climate ? AS.climate.speed : 5;
    document.getElementById('archCbMid').textContent = (windSpd * 0.5).toFixed(1);
    document.getElementById('archCbMax').textContent = (windSpd * 1.4).toFixed(1);
  }

  /* Pressure color: blue = suction, amber = stagnation */
  function pressureColor(t) {
    const stops = [
      [0,   new THREE.Color(0x1a3aff)],
      [0.4, new THREE.Color(0x00c8ff)],
      [0.6, new THREE.Color(0x00ffaa)],
      [0.8, new THREE.Color(0xf5a623)],
      [1.0, new THREE.Color(0xff3300)],
    ];
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      const [t0,c0] = stops[i-1], [t1,c1] = stops[i];
      if (t <= t1) return new THREE.Color().lerpColors(c0, c1, (t-t0)/(t1-t0));
    }
    return stops[stops.length-1][1];
  }

  /* ── Toggle between streamlines and pressure views ── */
  function setViewMode(mode) {
    AS.activeView = mode;
    document.querySelectorAll('.arch-vt-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === mode);
    });
    if (mode === 'pressure') {
      if (AS.particleSys) AS.particleSys.visible = false;
      buildPressureMesh();
      if (AS.pressureMesh) AS.pressureMesh.visible = true;
    } else {
      if (AS.pressureMesh) AS.pressureMesh.visible = false;
      if (AS.particleSys)  AS.particleSys.visible = true;
    }
  }


  /* ══════════════════════════════════════════════════════
     PARTICLE SYSTEM  (same scheme as §18, but larger)
  ══════════════════════════════════════════════════════ */
  function initArchParticles() {
    if (AS.particleSys) { AS.scene.remove(AS.particleSys); AS.particleSys = null; }
    AS.particleCount = parseInt(document.getElementById('archParticles').value) || 3000;
    const N    = AS.particleCount;
    const segs = A_TRAIL;

    const positions = new Float32Array(N * segs * 2 * 3);
    const colors    = new Float32Array(N * segs * 2 * 3);
    const geo  = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.68,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    AS.particleSys = new THREE.LineSegments(geo, mat);
    AS.particleSys.visible = (AS.activeView === 'streamlines');
    AS.scene.add(AS.particleSys);

    AS.particles = Array.from({ length: N }, () => spawnArchParticle());
    AS.trailBuf  = positions;
    AS.colorBuf  = colors;
  }

  function spawnArchParticle() {
    const d = AS.flowDims;
    if (!d) return { x:0, y:5, z:0, age:0, trail:[], speeds:[] };
    const x = d.ox + Math.random() * d.cellW * 1.5;
    const y = d.oy + 0.5 + Math.random() * (AFCY-1) * d.cellH * 0.9;
    const z = d.oz + Math.random() * (AFCZ-1) * d.cellD;
    return { x, y, z, age: Math.floor(Math.random() * A_MAX_AGE), trail:[], speeds:[] };
  }

  function resetArchParticle(p) {
    const d = AS.flowDims;
    if (!d) return;
    p.x = d.ox + Math.random() * d.cellW * 1.5;
    p.y = d.oy + 0.5 + Math.random() * (AFCY-1) * d.cellH * 0.9;
    p.z = d.oz + Math.random() * (AFCZ-1) * d.cellD;
    p.age = 0; p.trail = []; p.speeds = [];
  }

  function stepArchParticles() {
    if (!AS.particles || !AS.flowDims) return;
    const d = AS.flowDims;
    const N = AS.particleCount, segs = A_TRAIL;

    /* Get actual wind speed from climate or override slider */
    const overrideSl = parseFloat(document.getElementById('archWindOverride').value) || 0;
    const windSpd = overrideSl > 0.4 ? overrideSl
                  : (AS.climate ? AS.climate.speed : 5);
    const speedScale = Math.max(0.5, windSpd) * 0.4;

    const domXMax = d.ox + d.cellW  * (AFC-1);
    const domYMax = d.oy + d.cellH  * (AFCY-1);
    const domZMax = d.oz + d.cellD  * (AFCZ-1);

    let maxSpd = 0;

    for (let i = 0; i < N; i++) {
      const p = AS.particles[i];
      p.age++;
      const { u, v, w } = sampleArchFlow(p.x, p.y, p.z);
      const spd = Math.hypot(u, v, w);
      if (spd > maxSpd) maxSpd = spd;

      p.x += u * A_DT * speedScale;
      p.y += v * A_DT * speedScale;
      p.z += w * A_DT * speedScale;
      /* Ground clamp */
      if (p.y < 0.1) p.y = 0.1;

      p.trail.push(p.x, p.y, p.z);
      p.speeds.push(spd);
      if (p.trail.length > segs * 3) { p.trail.splice(0, 3); p.speeds.splice(0, 1); }

      if (p.x < d.ox || p.x > domXMax || p.y > domYMax ||
          p.z < d.oz || p.z > domZMax || p.age > A_MAX_AGE || spd < 0.001) {
        resetArchParticle(p);
      }
    }

    /* Update buffers */
    const pos = AS.trailBuf, col = AS.colorBuf;
    const nf  = maxSpd > 0 ? 1 / maxSpd : 1;
    for (let i = 0; i < N; i++) {
      const p  = AS.particles[i];
      const base = i * segs * 2 * 3;
      const t  = p.trail, ns = Math.floor(t.length / 3);
      for (let s = 0; s < segs; s++) {
        const v0 = Math.min(s,     Math.max(0, ns-2));
        const v1 = Math.min(s+1,   Math.max(0, ns-1));
        const off = base + s * 6;
        pos[off]   = t[v0*3]   || 0; pos[off+1] = t[v0*3+1] || 0; pos[off+2] = t[v0*3+2] || 0;
        pos[off+3] = t[v1*3]   || 0; pos[off+4] = t[v1*3+1] || 0; pos[off+5] = t[v1*3+2] || 0;
        const spd  = (p.speeds[v0] || 0) * nf;
        const c    = archSpeedColor(spd);
        col[off] = col[off+3] = c.r;
        col[off+1] = col[off+4] = c.g;
        col[off+2] = col[off+5] = c.b;
      }
    }
    const attr = AS.particleSys.geometry.attributes;
    attr.position.needsUpdate = true;
    attr.color.needsUpdate    = true;
  }

  function archSpeedColor(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < A_SPEED_STOPS.length; i++) {
      const [t0,c0] = A_SPEED_STOPS[i-1], [t1,c1] = A_SPEED_STOPS[i];
      if (t <= t1) return new THREE.Color().lerpColors(c0, c1, (t-t0)/(t1-t0));
    }
    return A_SPEED_STOPS[A_SPEED_STOPS.length-1][1];
  }


  /* ══════════════════════════════════════════════════════
     CLIMATE FETCH  (reuses §7 fetchPointData → ICON)
  ══════════════════════════════════════════════════════ */
  async function fetchArchClimate() {
    const btn = document.getElementById('archFetchClimate');
    btn.disabled = true;
    setArchStatus('FETCHING CLIMATE…', 'running');

    const lat   = parseFloat(document.getElementById('archLat').value)  || S.selectedPoint?.lat  || CFG.CENTER[1];
    const lon   = parseFloat(document.getElementById('archLon').value)  || S.selectedPoint?.lon  || CFG.CENTER[0];
    const month = document.getElementById('archMonth').value;

    try {
      const d = await fetchPointData(lat, lon, '10m', month);
      AS.climate = { speed: d.speed, dir: d.dir, humidity: d.humidity, temp: d.temp, month };

      /* Update wind rose */
      const arrowDeg = (d.dir + 180) % 360;
      document.getElementById('archWindArrowG').setAttribute('transform', `rotate(${arrowDeg},40,40)`);
      document.getElementById('archWindSpeedLabel').textContent = d.speed.toFixed(1) + ' m/s';

      /* Update HUD */
      document.getElementById('archHudLoc').textContent =
        `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;

      /* Climate grid */
      const grid = document.getElementById('archClimateGrid');
      grid.innerHTML = [
        { k:'WIND SPEED', v: d.speed.toFixed(1), u:'m/s' },
        { k:'DIRECTION',  v: toDirCard(d.dir),   u:`${Math.round(d.dir)}°` },
        { k:'HUMIDITY',   v: Math.round(d.humidity), u:'%' },
        { k:'TEMPERATURE', v: d.temp.toFixed(1), u:'°C' },
        { k:'MODEL',       v: S.activeModel,     u:'' },
        { k:'UTC HOUR',    v: S.activeHour ? S.activeHour.slice(11,16) : '—', u:'' },
      ].map(r => `<div class="arch-cg-item"><div class="arch-cg-k">${r.k}</div><div class="arch-cg-v">${r.v}<span class="arch-cg-u">${r.u ? ' '+r.u : ''}</span></div></div>`).join('');
      grid.classList.remove('hidden');

      /* Rebuild flow with new wind direction applied */
      buildArchFlowField();
      setArchStatus(`ICON · ${toDirCard(d.dir)} ${d.speed.toFixed(1)} m/s`, 'done');
    } catch(err) {
      setArchStatus('CLIMATE FETCH ERROR', 'error');
      console.error('[AS] Climate:', err);
    } finally {
      btn.disabled = false;
    }
  }


  /* ══════════════════════════════════════════════════════
     RUN SIMULATION
  ══════════════════════════════════════════════════════ */
  function runArchSim() {
    if (!AS.modelLoaded) {
      setArchStatus('UPLOAD A MODEL FIRST', 'error'); return;
    }
    setArchStatus('BUILDING FLOW FIELD…', 'running');
    buildArchFlowField();
    initArchParticles();
    AS.simRunning = true;
    if (!AS.rafId) archAnimate();

    if (AS.activeView === 'pressure') buildPressureMesh();

    setTimeout(() => {
      const r = computeArchResults();
      displayArchResults(r);
      setArchStatus(`SIM ACTIVE · ${AS.particleCount} PARTICLES`, 'running');
    }, 2500);
  }

  function resetArchSim() {
    stopArchSim();
    if (AS.particleSys) { AS.scene.remove(AS.particleSys); AS.particleSys = null; }
    if (AS.pressureMesh) { AS.scene.remove(AS.pressureMesh); AS.pressureMesh = null; }
    document.getElementById('archResultsSection').classList.add('arch-results-hidden');
    setArchStatus('RESET', 'idle');
    archAnimate();
  }


  /* ══════════════════════════════════════════════════════
     HARVEST CALCULATION  (architecture scale)
  ══════════════════════════════════════════════════════ */
  function computeArchResults() {
    const climate  = AS.climate || { speed:5, dir:270, humidity:82, temp:15 };
    const windSpeed = climate.speed;
    const humidity  = climate.humidity;

    /* Collection area */
    const manualA = parseFloat(document.getElementById('archAreaInput').value) || 0;
    let area;
    if (manualA > 0) {
      area = manualA;
    } else if (AS.modelBBox) {
      const sz = AS.modelBBox.getSize(new THREE.Vector3());
      /* Exposed face ⊥ to wind = height × depth */
      area = sz.y * sz.z;
    } else { area = 50; }

    /* LWC */
    const lwc  = estimateLWC(humidity);
    const vEff = Math.max(0.5, windSpeed * 0.88);
    const eta  = 0.20;
    const daily = lwc * vEff * eta * area * 86400 / 1000;

    /* Stagnation / suction ratio from flow samples */
    let stagRatio = 1.0, suctionZone = 0;
    if (AS.modelBBox && AS.flowDims) {
      const ctr = AS.modelBBox.getCenter(new THREE.Vector3());
      const sz  = AS.modelBBox.getSize(new THREE.Vector3());
      let sampleCount = 0, highPressCount = 0;
      for (let t = 0; t < 20; t++) {
        const wr = (Math.random() - 0.5) * sz.z * 0.9;
        const wh = Math.random() * sz.y;
        /* Upwind face */
        const { u:uf } = sampleArchFlow(ctr.x - sz.x * 0.52, ctr.y + wh, ctr.z + wr);
        const { u:uw } = sampleArchFlow(ctr.x + sz.x * 0.52, ctr.y + wh, ctr.z + wr);
        sampleCount++;
        if (Math.abs(uf) < 0.3) highPressCount++;
        if (uw < 0.2) suctionZone++;
      }
      stagRatio  = (highPressCount / sampleCount).toFixed(2);
      suctionZone = Math.round(suctionZone / sampleCount * 100);
    }

    return {
      area:        area.toFixed(1),
      lwc:         lwc.toFixed(3),
      vEff:        vEff.toFixed(2),
      daily:       Math.max(0, daily).toFixed(2),
      monthly:     (Math.max(0, daily) * 30).toFixed(1),
      annual:      (Math.max(0, daily) * 365).toFixed(0),
      stagRatio,
      suctionZone,
      windSpeed:   windSpeed.toFixed(1),
      humidity:    Math.round(humidity),
    };
  }

  function displayArchResults(r) {
    document.getElementById('archHarvestNum').textContent     = r.daily;
    document.getElementById('archHarvestMonthly').textContent = r.monthly;

    document.getElementById('archResultsGrid').innerHTML = [
      { k:'COLLECTION AREA', v: r.area,     u:'m²'   },
      { k:'LWC ESTIMATE',    v: r.lwc,      u:'g/m³' },
      { k:'EFFECTIVE WIND',  v: r.vEff,     u:'m/s'  },
      { k:'STAGNATION',      v: r.stagRatio,u:'ratio' },
      { k:'SUCTION ZONE',    v: r.suctionZone, u:'%'  },
      { k:'ANNUAL YIELD',    v: r.annual,   u:'L/m²' },
    ].map(row => `<div class="arch-rg-item"><div class="arch-rg-k">${row.k}</div><div class="arch-rg-v">${row.v}<span class="arch-rg-u"> ${row.u}</span></div></div>`).join('');

    document.getElementById('archPressureSummary').innerHTML =
      `Wind from <strong>${toDirCard(AS.climate?.dir || 270)}</strong> at <strong>${r.windSpeed} m/s</strong> · ` +
      `Stagnation ratio ${r.stagRatio} · Suction zone ${r.suctionZone}% of downwind face<br>` +
      `Humidity ${r.humidity}% · LWC ${r.lwc} g/m³ · η = 20%<br>` +
      `Estimated annual collection: <strong>${r.annual} L/m²</strong>`;

    showArchSection('archResultsSection');
  }


  /* ══════════════════════════════════════════════════════
     PLACE ON MAIN MAP
  ══════════════════════════════════════════════════════ */
  function archPlaceOnMap() {
    const lat = parseFloat(document.getElementById('archLat').value) || S.selectedPoint?.lat;
    const lon = parseFloat(document.getElementById('archLon').value) || S.selectedPoint?.lon;
    if (!lat || !lon) { alert('Enter latitude and longitude first.'); return; }

    const el  = document.createElement('div');
    el.className = 'arch-map-marker';
    el.title  = document.getElementById('archProjName').value || 'Arch Sim Model';
    el.innerHTML = `
      <svg viewBox="0 0 32 32" fill="none" width="32">
        <rect x="10" y="6" width="12" height="18" rx="1.5" stroke="#f5a623" stroke-width="1.5"/>
        <rect x="2" y="14" width="8" height="10" rx="1" stroke="#f5a623" stroke-width="1.1" opacity="0.7"/>
        <rect x="22" y="10" width="8" height="14" rx="1" stroke="#f5a623" stroke-width="1.1" opacity="0.7"/>
        <line x1="0" y1="24" x2="32" y2="24" stroke="#f5a623" stroke-width="1.2"/>
        <circle cx="16" cy="28" r="2.5" fill="#f5a623" opacity="0.85"/>
      </svg>`;

    new maptilersdk.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([lon, lat])
      .addTo(S.map);

    S.map.flyTo({
      center: [lon, lat], zoom: 16,
      pitch: CFG.PITCH, bearing: CFG.BEARING, duration: 1800,
    });
    closeArchOverlay();
  }


  /* ══════════════════════════════════════════════════════
     EXPORT DATA CARD  (downloads a text/JSON summary)
  ══════════════════════════════════════════════════════ */
  function exportArchDataCard() {
    const lat  = document.getElementById('archLat').value   || '—';
    const lon  = document.getElementById('archLon').value   || '—';
    const elev = document.getElementById('archElev').value  || '—';
    const name = document.getElementById('archProjName').value || 'Untitled';
    const c    = AS.climate || {};
    const r    = AS.modelBBox ? (() => computeArchResults())() : null;

    const card = {
      project:    name,
      location:   { lat, lon, elevation_m: elev },
      model:      { S_activeModel: S.activeModel, hour_utc: S.activeHour || '—' },
      climate: {
        wind_speed_ms:  c.speed?.toFixed(2) || '—',
        wind_dir_deg:   c.dir   || '—',
        humidity_pct:   c.humidity || '—',
        temperature_c:  c.temp?.toFixed(1) || '—',
        month:          c.month || '—',
      },
      harvest:    r ? {
        daily_L_m2:     r.daily,
        monthly_L_m2:   r.monthly,
        annual_L_m2:    r.annual,
        collection_m2:  r.area,
        lwc_g_m3:       r.lwc,
        efficiency:     '20%',
      } : 'Run simulation first',
      generated:  new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${name.replace(/\s+/g,'-')}-arch-wind-data.json`;
    a.click();
    URL.revokeObjectURL(url);
  }


  /* ══════════════════════════════════════════════════════
     UI HELPERS
  ══════════════════════════════════════════════════════ */
  function setArchStatus(msg, type) {
    const dot = document.getElementById('archStatusDot');
    const txt = document.getElementById('archStatusTxt');
    dot.className = `arch-status-${type}`;
    txt.textContent = msg;
  }

  function showArchSection(id) {
    document.getElementById(id).classList.remove('arch-results-hidden');
  }

  function populateArchLocationFromMap() {
    if (!S.selectedPoint) return;
    document.getElementById('archLat').value  = S.selectedPoint.lat.toFixed(5);
    document.getElementById('archLon').value  = S.selectedPoint.lon.toFixed(5);
    document.getElementById('archElev').value = S.selectedPoint.elevation || '';
    document.getElementById('archHudLoc').textContent =
      `${S.selectedPoint.lat.toFixed(3)}°, ${S.selectedPoint.lon.toFixed(3)}°`;
  }

  function updateArchHudScale() {
    const rH = document.getElementById('archBldgHeight').value;
    const rW = document.getElementById('archBldgWidth').value;
    if (rH) document.getElementById('archHudScale').textContent = `H = ${rH} m`;
    else if (rW) document.getElementById('archHudScale').textContent = `W = ${rW} m`;
    else document.getElementById('archHudScale').textContent = 'SCALE 1:1';
  }

  function setupArchDragDrop() {
    const zone = document.getElementById('archUploadArea');
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) archLoadModel(file);
    });
  }


  /* ══════════════════════════════════════════════════════
     WIRE ALL EVENTS
  ══════════════════════════════════════════════════════ */
  function wireArchEvents() {
    /* Open / close */
    document.getElementById('btnArchSim').addEventListener('click', initArchSim);
    document.getElementById('arch-close').addEventListener('click', closeArchOverlay);
    document.getElementById('arch-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('arch-overlay')) closeArchOverlay();
    });
    /* Escape key — only close if arch overlay is open */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' &&
          !document.getElementById('arch-overlay').classList.contains('arch-hidden')) {
        closeArchOverlay();
      }
    });

    /* File input */
    document.getElementById('archFileInput').addEventListener('change', e => {
      const f = e.target.files[0]; if (f) archLoadModel(f);
    });
    setupArchDragDrop();

    /* Scale */
    document.getElementById('archApplyScale').addEventListener('click', applyRealScale);

    /* Transform sliders */
    [
      ['archScale',    'archScaleVal',    v => v.toFixed(1) + '×'],
      ['archRotY',     'archRotYVal',     v => Math.round(v) + '°'],
      ['archElevOff',  'archElevOffVal',  v => v.toFixed(1) + ' m'],
    ].forEach(([id, valId, fmt]) => {
      document.getElementById(id).addEventListener('input', function() {
        document.getElementById(valId).textContent = fmt(parseFloat(this.value));
        updateArchTransforms();
      });
    });

    /* Particle & wind override sliders */
    document.getElementById('archParticles').addEventListener('input', function() {
      document.getElementById('archParticlesVal').textContent = this.value;
    });
    document.getElementById('archWindOverride').addEventListener('input', function() {
      const v = parseFloat(this.value);
      document.getElementById('archWindOverrideVal').textContent =
        v > 0.4 ? v.toFixed(1) + ' m/s' : 'AUTO';
    });

    /* Use main map point */
    document.getElementById('archUseMapPoint').addEventListener('click', () => {
      populateArchLocationFromMap();
      if (!S.selectedPoint) alert('Click on the main map first to select a point.');
    });

    /* Climate fetch */
    document.getElementById('archFetchClimate').addEventListener('click', fetchArchClimate);

    /* View toggle (streamlines / pressure) */
    document.querySelectorAll('.arch-vt-btn').forEach(btn => {
      btn.addEventListener('click', () => setViewMode(btn.dataset.view));
    });

    /* Run / Reset */
    document.getElementById('archRunSim').addEventListener('click', runArchSim);
    document.getElementById('archResetSim').addEventListener('click', resetArchSim);

    /* Place on map */
    document.getElementById('archPlaceOnMap').addEventListener('click', archPlaceOnMap);

    /* Export */
    document.getElementById('archExportData').addEventListener('click', exportArchDataCard);
  }

  /* Script is at bottom of <body> — DOM already parsed, call directly */
  wireArchEvents();

})(); /* end §19 Architecture Sim IIFE */

/* ═══════════════════════════════════════════════════════════════════════
   3D WIND TUNNEL MODEL UPLOAD FIX
   Add this entire section to the END of your script.js
   ═══════════════════════════════════════════════════════════════════════ */

let TUNNEL_SCENE = null;
let TUNNEL_CAMERA = null;
let TUNNEL_RENDERER = null;
let TUNNEL_CONTROLS = null;
let TUNNEL_CURRENT_MODEL = null;

function initTunnelModal() {
  const btnTunnel = document.getElementById('btnWindTunnel');
  const overlay = document.getElementById('tunnel-overlay');
  const closeBtn = document.getElementById('btnTunnelClose');

  if (!btnTunnel || !overlay) return;

  btnTunnel.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    setTimeout(() => {
      if (!TUNNEL_RENDERER) {
        initTunnelViewer();
      }
    }, 100);
  });

  closeBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
    }
  });
}

function initTunnelViewer() {
  const canvas = document.getElementById('tunnelCanvas');
  if (!canvas || TUNNEL_RENDERER) return;

  const width = canvas.parentElement.clientWidth;
  const height = canvas.parentElement.clientHeight;

  TUNNEL_RENDERER = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  TUNNEL_RENDERER.setSize(width, height);
  TUNNEL_RENDERER.setClearColor(0x1a1a1a, 1);
  TUNNEL_RENDERER.shadowMap.enabled = true;

  TUNNEL_SCENE = new THREE.Scene();
  TUNNEL_SCENE.background = new THREE.Color(0x1a1a1a);

  TUNNEL_CAMERA = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000);
  TUNNEL_CAMERA.position.set(50, 30, 50);
  TUNNEL_CAMERA.lookAt(0, 0, 0);

  const ambLight = new THREE.AmbientLight(0xffffff, 0.7);
  TUNNEL_SCENE.add(ambLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(100, 100, 100);
  dirLight.castShadow = true;
  TUNNEL_SCENE.add(dirLight);

  const groundGeom = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  TUNNEL_SCENE.add(ground);

  TUNNEL_CONTROLS = new THREE.OrbitControls(TUNNEL_CAMERA, TUNNEL_RENDERER.domElement);
  TUNNEL_CONTROLS.enableDamping = true;
  TUNNEL_CONTROLS.dampingFactor = 0.05;
  TUNNEL_CONTROLS.autoRotate = true;
  TUNNEL_CONTROLS.autoRotateSpeed = 2;

  function animate() {
    requestAnimationFrame(animate);
    TUNNEL_CONTROLS.update();
    TUNNEL_RENDERER.render(TUNNEL_SCENE, TUNNEL_CAMERA);
  }
  animate();

  window.addEventListener('resize', () => {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    TUNNEL_CAMERA.aspect = w / h;
    TUNNEL_CAMERA.updateProjectionMatrix();
    TUNNEL_RENDERER.setSize(w, h);
  });

  initModelUpload();
}

function initModelUpload() {
  const dropzone = document.getElementById('tunnelDropzone');
  const fileInput = document.getElementById('tunnelFileInput');

  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleModelFile(e.target.files[0]);
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleModelFile(e.dataTransfer.files[0]);
    }
  });
}

function handleModelFile(file) {
  const validExtensions = ['.glb', '.gltf', '.obj', '.stl'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();

  if (!validExtensions.includes(ext)) {
    alert('❌ Format not supported. Use: GLB, GLTF, OBJ, or STL');
    return;
  }

  if (file.size > 50 * 1024 * 1024) {
    alert('❌ File too large (max 50 MB)');
    return;
  }

  const dropzone = document.getElementById('tunnelDropzone');
  dropzone.innerHTML = '<div style="padding: 20px; color: #888;">📦 Loading model...</div>';

  const reader = new FileReader();

  reader.onload = (event) => {
    try {
      const arrayBuffer = event.target.result;
      loadModel(arrayBuffer, file.name, ext);
      dropzone.innerHTML = `<div style="color: #4CAF50; padding: 15px; text-align: center;">✓ <strong>${file.name}</strong><br><small>Ready to place</small></div>`;
    } catch (error) {
      console.error('Model load error:', error);
      dropzone.innerHTML = `<div style="color: #ff6b6b;">❌ ${error.message}</div>`;
      setTimeout(() => {
        dropzone.innerHTML = '<svg viewBox="0 0 36 36" fill="none" width="24"><rect x="4" y="8" width="24" height="20" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M18 12v8M14 16h8" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg><p>Drop or click to upload</p>';
      }, 3000);
    }
  };

  reader.onerror = () => {
    alert('❌ Error reading file');
  };

  reader.readAsArrayBuffer(file);
}

function loadModel(arrayBuffer, filename, ext) {
  if (TUNNEL_CURRENT_MODEL) {
    TUNNEL_SCENE.remove(TUNNEL_CURRENT_MODEL);
    TUNNEL_CURRENT_MODEL = null;
  }

  if (ext === '.glb' || ext === '.gltf') {
    loadGLB(arrayBuffer, filename);
  } else if (ext === '.obj') {
    loadOBJ(arrayBuffer, filename);
  } else if (ext === '.stl') {
    loadSTL(arrayBuffer, filename);
  }
}

function loadGLB(arrayBuffer, filename) {
  const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const loader = new THREE.GLTFLoader();
  loader.load(
    url,
    (gltf) => {
      const model = gltf.scene;
      updateTunnelModel(model, filename);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => {
      console.error('GLB load error:', err);
      throw new Error('Failed to load GLB: ' + err.message);
    }
  );
}

function loadOBJ(arrayBuffer, filename) {
  const blob = new Blob([arrayBuffer], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  if (!window.THREE || !window.THREE.OBJLoader) {
    URL.revokeObjectURL(url);
    throw new Error('OBJLoader not available. Convert to GLB for better support.');
  }

  const loader = new THREE.OBJLoader();
  loader.load(
    url,
    (object) => {
      updateTunnelModel(object, filename);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => {
      URL.revokeObjectURL(url);
      throw new Error('Failed to load OBJ: ' + err.message);
    }
  );
}

function loadSTL(arrayBuffer, filename) {
  const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  if (!window.THREE || !window.THREE.STLLoader) {
    URL.revokeObjectURL(url);
    throw new Error('STLLoader not available. Convert to GLB for better support.');
  }

  const loader = new THREE.STLLoader();
  loader.load(
    url,
    (geometry) => {
      const material = new THREE.MeshStandardMaterial({ color: 0x8B6F47, metalness: 0.3 });
      const mesh = new THREE.Mesh(geometry, material);
      updateTunnelModel(mesh, filename);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => {
      URL.revokeObjectURL(url);
      throw new Error('Failed to load STL: ' + err.message);
    }
  );
}

function updateTunnelModel(model, filename) {
  try {
    model.castShadow = true;
    model.receiveShadow = true;
    TUNNEL_SCENE.add(model);
    TUNNEL_CURRENT_MODEL = model;

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    model.position.sub(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? 10 / maxDim : 1;
    model.scale.multiplyScalar(scale);

    const infoBox = document.getElementById('tunnelModelInfo');
    infoBox.innerHTML = `
      <div class="tmi-name">✓ ${filename}</div>
      <div class="tmi-size">${size.x.toFixed(1)}m × ${size.y.toFixed(1)}m × ${size.z.toFixed(1)}m</div>
    `;
    infoBox.classList.remove('hidden');

    const scaleSlider = document.getElementById('tunnelScaleSlider');
    if (scaleSlider) {
      scaleSlider.value = scale;
      document.getElementById('tunnelScaleVal').textContent = scale.toFixed(1) + '×';
    }

    console.log('✓ Model loaded:', filename);
  } catch (error) {
    console.error('Error updating model:', error);
    throw error;
  }
}

function initTunnelTransforms() {
  const scaleSlider = document.getElementById('tunnelScaleSlider');
  const rotSlider = document.getElementById('tunnelRotSlider');
  const elevInput = document.getElementById('tunnelElevInput');

  if (scaleSlider) {
    scaleSlider.addEventListener('input', () => {
      if (TUNNEL_CURRENT_MODEL) {
        const scale = parseFloat(scaleSlider.value);
        TUNNEL_CURRENT_MODEL.scale.set(scale, scale, scale);
        document.getElementById('tunnelScaleVal').textContent = scale.toFixed(1) + '×';
      }
    });
  }

  if (rotSlider) {
    rotSlider.addEventListener('input', () => {
      if (TUNNEL_CURRENT_MODEL) {
        const rot = parseFloat(rotSlider.value) * Math.PI / 180;
        TUNNEL_CURRENT_MODEL.rotation.y = rot;
        document.getElementById('tunnelRotVal').textContent = Math.round(rotSlider.value) + '°';
      }
    });
  }

  if (elevInput) {
    elevInput.addEventListener('change', () => {
      if (TUNNEL_CURRENT_MODEL) {
        const elev = parseFloat(elevInput.value) || 0;
        TUNNEL_CURRENT_MODEL.position.y = elev;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTunnelModal();
  initTunnelTransforms();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initTunnelModal();
    initTunnelTransforms();
  });
} else {
  initTunnelModal();
  initTunnelTransforms();
}