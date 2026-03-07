/* ═══════════════════════════════════════════════════════════════════════
   FogHarvest v4 · script.js  (FIXED — MapTiler SDK, no Mapbox token)
   ─────────────────────────────────────────────────────────────────────
   ROOT CAUSE FIX:
   • Mapbox GL JS v3+ requires a valid Mapbox token even for MapTiler
     styles and blocks the entire renderer with an "invalid token" error
     when a dummy/placeholder is used.
   • Solution: use maptilersdk (MapTiler's own JS SDK) instead.
     It is API-compatible with Mapbox GL JS but authenticates via
     maptilersdk.config.apiKey — no Mapbox token ever needed.
   • The CDN swap (index.html) and this file are the only two files
     that need to change.
═══════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════
   1. CONFIG
══════════════════════════════════════════════════════ */
const CFG = {

  /* ── MapTiler ── */
  MT_KEY:   'YU4AkYjwr3SI0k0mKRLc',
  MT_STYLE: 'https://api.maptiler.com/maps/019cca32-19d8-7506-b7e2-b8e61efa521e/style.json?key=YU4AkYjwr3SI0k0mKRLc',
  MT_TERRAIN_URL: 'https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=YU4AkYjwr3SI0k0mKRLc',
  MT_GEOCODE: 'https://api.maptiler.com/geocoding',

  /* ── Map defaults (Rosarito, Baja California) ── */
  CENTER:      [-116.94, 32.52],
  ZOOM:        11.5,
  PITCH:       58,
  BEARING:     -18,
  TERRAIN_EXG: 1.5,

  /* ── Open-Meteo endpoints ── */
  API:     'https://api.open-meteo.com/v1/forecast',
  ARCHIVE: 'https://archive-api.open-meteo.com/v1/archive',

  COAST_RADIUS_KM: 30,

  /* ── Wind field grid resolution ── */
  GRID: { COLS: 22, ROWS: 16 },

  /* ── Streamline particles ── */
  WIND: {
    PARTICLE_COUNT: 2200,
    FADE:           0.97,
    SPEED_SCALE:    0.18,
    LINE_WIDTH:     0.9,
    MAX_AGE:        120,
    MAX_ALPHA:      0.40,
    MIN_ALPHA:      0.10,
  },

  /* ── Fog feasibility thresholds ── */
  F: {
    FOG_H: 92, FOG_M: 78,
    ELV_HI_MIN: 180, ELV_HI_MAX: 850,
    ELV_ME_MIN:  40, ELV_ME_MAX: 180,
    WIN_HI_MIN: 3,   WIN_HI_MAX: 13,
    WIN_ME_MIN: 1,   WIN_ME_MAX: 18,
    CST_HI: 5,       CST_ME: 20,
  },

  /* ── Water yield model ── */
  Y: {
    EFFICIENCY: 0.20,
    FOG_HOURS:  8,
    LWC_RH_MIN:  80,
    LWC_RH_MED:  90,
    LWC_RH_HI:   95,
    LWC_CAP:     3.0,
    ELV_OPTIMAL_MIN: 180,
    ELV_OPTIMAL_MAX: 850,
    ELV_PEN_ABOVE:   900,
  },
};


/* ══════════════════════════════════════════════════════
   2. STATE
══════════════════════════════════════════════════════ */
const S = {
  map:    null,
  marker: null,
  windField:     null,
  windParticles: [],
  windCanvas:    null,
  windCtx:       null,
  windRAF:       null,
  humField:  null,
  humCanvas: null,
  humCtx:    null,
  gridSamples: [],
  selectedPoint: null,
  weather:       null,
  feasibility:   null,
  coastDist:     null,
  waterYield:    null,
  selectedMonth: 'current',
  layerWind:     true,
  layerHum:      true,
  monthChart:  null,
  panelOpen:   true,
  searchTimer: null,
};


/* ══════════════════════════════════════════════════════
   3. MAP INIT — MapTiler SDK  ← KEY FIX
   ──────────────────────────────────────────────────────
   maptilersdk.config.apiKey replaces the Mapbox accessToken.
   maptilersdk.Map is API-compatible with mapboxgl.Map.
   All other map calls (addSource, setTerrain, addLayer, etc.)
   work identically — zero changes needed in the rest of the code.
══════════════════════════════════════════════════════ */
function initMap() {

  /* ── Set the MapTiler API key globally (replaces Mapbox token) ── */
  maptilersdk.config.apiKey = CFG.MT_KEY;

  S.map = new maptilersdk.Map({
    container:  'map',
    style:      CFG.MT_STYLE,
    center:     CFG.CENTER,
    zoom:       CFG.ZOOM,
    pitch:      CFG.PITCH,
    bearing:    CFG.BEARING,
    antialias:  true,
    terrain:    { source: 'maptiler-terrain', exaggeration: CFG.TERRAIN_EXG },
  });

  S.map.addControl(new maptilersdk.NavigationControl({ visualizePitch: true }), 'bottom-right');

  S.map.on('load', () => {

    /* ── Add MapTiler DEM source ── */
    if (!S.map.getSource('maptiler-terrain')) {
      S.map.addSource('maptiler-terrain', {
        type:     'raster-dem',
        url:      CFG.MT_TERRAIN_URL,
        tileSize: 512,
        maxzoom:  14,
      });
    }

    /* ── Enable 3D terrain ── */
    try {
      if (!S.map.getTerrain()) {
        S.map.setTerrain({ source: 'maptiler-terrain', exaggeration: CFG.TERRAIN_EXG });
      }
    } catch(e) {
      S.map.setTerrain({ source: 'maptiler-terrain', exaggeration: CFG.TERRAIN_EXG });
    }

    /* ── Sky layer ── */
    if (!S.map.getLayer('sky')) {
      S.map.addLayer({
        id: 'sky', type: 'sky',
        paint: {
          'sky-type':                    'atmosphere',
          'sky-atmosphere-sun':           [0, 88],
          'sky-atmosphere-sun-intensity': 10,
        },
      });
    }

    initCanvases();
    fetchWindField();
    showApp();
  });

  S.map.on('error', e => {
    if (e.error) console.warn('[FogHarvest] Map error:', e.error.message || e.error);
  });

  S.map.on('click',   e => onMapClick(e.lngLat.lat, e.lngLat.lng));
  S.map.getCanvas().style.cursor = 'crosshair';
  S.map.on('moveend', debounce(fetchWindField, 900));
  S.map.on('resize',  () => {
    syncCanvasSize(S.windCanvas);
    syncCanvasSize(S.humCanvas);
    if (S.humField) drawHumidityCanvas();
  });
}


/* ══════════════════════════════════════════════════════
   4. SEARCH BAR — MapTiler Geocoding API
══════════════════════════════════════════════════════ */

function initSearch() {
  const input    = document.getElementById('searchInput');
  const dropdown = document.getElementById('searchDropdown');
  const clearBtn = document.getElementById('searchClear');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', q.length === 0);
    clearTimeout(S.searchTimer);
    if (q.length < 2) { hideDropdown(); return; }
    S.searchTimer = setTimeout(() => geocodeSearch(q), 350);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    hideDropdown();
    input.focus();
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('searchWrap').contains(e.target)) hideDropdown();
  });

  input.addEventListener('keydown', e => {
    const items  = dropdown.querySelectorAll('.search-item');
    const active = dropdown.querySelector('.search-item.active');
    if (e.key === 'Escape') { hideDropdown(); input.blur(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (next) { active?.classList.remove('active'); next.classList.add('active'); }
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active?.previousElementSibling;
      if (prev) { active.classList.remove('active'); prev.classList.add('active'); }
    }
    if (e.key === 'Enter') { (active || items[0])?.click(); }
  });
}

async function geocodeSearch(query) {
  const dropdown = document.getElementById('searchDropdown');
  dropdown.innerHTML = `<div class="search-loading">Buscando…</div>`;
  dropdown.classList.remove('hidden');

  try {
    const url  = `${CFG.MT_GEOCODE}/${encodeURIComponent(query)}.json?key=${CFG.MT_KEY}&limit=6&language=es`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];

    if (features.length === 0) {
      dropdown.innerHTML = `<div class="search-no-results">Sin resultados para "${query}"</div>`;
      return;
    }

    dropdown.innerHTML = '';
    features.forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const name    = f.text || f.place_name || 'Lugar desconocido';
      const subText = (f.place_name || '').replace(/^[^,]+,\s*/, '').trim();
      const item    = document.createElement('div');
      item.className = 'search-item';
      item.innerHTML = `
        <span class="si-name">${escHtml(name)}</span>
        ${subText ? `<span class="si-place">${escHtml(subText)}</span>` : ''}
        <span class="si-coords">${lat.toFixed(4)}°, ${lon.toFixed(4)}°</span>
      `;
      item.addEventListener('click', () => {
        S.map.flyTo({ center:[lon,lat], zoom:13, pitch:CFG.PITCH, bearing:CFG.BEARING, duration:1400 });
        document.getElementById('searchInput').value = name;
        document.getElementById('searchClear').classList.remove('hidden');
        hideDropdown();
      });
      dropdown.appendChild(item);
    });

  } catch (err) {
    console.error('[FogHarvest] Geocoding error:', err);
    dropdown.innerHTML = `<div class="search-no-results">Error al buscar. Revisa la conexión.</div>`;
  }
}

function hideDropdown() { document.getElementById('searchDropdown').classList.add('hidden'); }
function escHtml(str)   { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


/* ══════════════════════════════════════════════════════
   5. WIND FIELD
══════════════════════════════════════════════════════ */

async function fetchWindField() {
  const map = S.map;
  if (!map || !map.isStyleLoaded()) return;

  setStatus('loading');

  const alt   = document.getElementById('selAlt').value;
  const month = S.selectedMonth;
  const { speedParam, dirParam } = windParams(alt);

  const b  = map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();

  const SCOLS = 5, SROWS = 4;
  const pts   = [];
  for (let r = 0; r < SROWS; r++)
    for (let c = 0; c < SCOLS; c++)
      pts.push({
        lat: sw.lat + (r/(SROWS-1))*(ne.lat-sw.lat),
        lon: sw.lng + (c/(SCOLS-1))*(ne.lng-sw.lng),
      });

  try {
    const fetched = await fetchConcurrent(
      pts.map(pt => () => fetchPointData(pt.lat, pt.lon, speedParam, dirParam, month)), 5
    );
    pts.forEach((pt,i) => {
      pt.speed    = fetched[i].speed;
      pt.dir      = fetched[i].dir;
      pt.humidity = fetched[i].humidity;
    });
    S.gridSamples = pts;

    const COLS = CFG.GRID.COLS, ROWS = CFG.GRID.ROWS;
    S.windField = { cols:COLS, rows:ROWS, uv:buildUVGrid(pts,sw,ne,COLS,ROWS), bounds:{sw,ne} };
    S.humField  = { cols:COLS, rows:ROWS, h: buildHumGrid(pts,sw,ne,COLS,ROWS), bounds:{sw,ne} };

    if (S.layerHum)  drawHumidityCanvas();
    if (S.layerWind) startWindParticles();
    setStatus('active', alt, month);

  } catch (err) {
    console.error('[FogHarvest] Wind fetch error:', err);
    setStatus('error');
  }
}

async function fetchPointData(lat, lon, speedParam, dirParam, month) {
  let data;

  if (month === 'current') {
    const url = new URL(CFG.API);
    url.searchParams.set('latitude',        lat.toFixed(5));
    url.searchParams.set('longitude',       lon.toFixed(5));
    url.searchParams.set('current',         'relative_humidity_2m,wind_speed_10m,wind_direction_10m');
    url.searchParams.set('hourly',          'wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m');
    url.searchParams.set('wind_speed_unit', 'ms');
    url.searchParams.set('timezone',        'auto');
    url.searchParams.set('forecast_days',   '1');
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    data = await res.json();
  } else {
    const year = new Date().getFullYear() - 1;
    const m    = parseInt(month, 10);
    const url  = new URL(CFG.ARCHIVE);
    url.searchParams.set('latitude',        lat.toFixed(5));
    url.searchParams.set('longitude',       lon.toFixed(5));
    url.searchParams.set('start_date',      `${year}-${pad(m)}-01`);
    url.searchParams.set('end_date',        `${year}-${pad(m)}-${daysInMonth(year,m)}`);
    url.searchParams.set('hourly',          'relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m');
    url.searchParams.set('wind_speed_unit', 'ms');
    url.searchParams.set('timezone',        'auto');
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
    data = await res.json();
  }

  const hAvg = k => {
    const a = data.hourly?.[k]; if (!a||!a.length) return null;
    const v = a.filter(x=>x!=null); return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;
  };

  const c        = data.current || {};
  const humidity = c['relative_humidity_2m'] ?? hAvg('relative_humidity_2m') ?? 72;
  const altMode  = document.getElementById('selAlt').value;
  let speed, dir;
  if (altMode === '10m') {
    speed = c['wind_speed_10m']    ?? hAvg('wind_speed_10m')    ?? 3;
    dir   = c['wind_direction_10m']?? hAvg('wind_direction_10m')?? 270;
  } else if (altMode === '80m') {
    speed = hAvg('wind_speed_80m')    ?? c['wind_speed_10m']    ?? 3;
    dir   = hAvg('wind_direction_80m')?? c['wind_direction_10m']?? 270;
  } else {
    speed = hAvg('wind_speed_120m')    ?? c['wind_speed_10m']    ?? 3;
    dir   = hAvg('wind_direction_120m')?? c['wind_direction_10m']?? 270;
  }

  return { speed: speed ?? 3, dir: dir ?? 270, humidity };
}

function buildUVGrid(samples, sw, ne, cols, rows) {
  const uv = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const lat = sw.lat + (r/(rows-1))*(ne.lat-sw.lat);
      const lon = sw.lng + (c/(cols-1))*(ne.lng-sw.lng);
      const {speed, dir} = idwVec(lat, lon, samples);
      const rad = (dir * Math.PI) / 180;
      const idx = (r*cols+c)*2;
      uv[idx]   =  speed * Math.sin(rad);
      uv[idx+1] = -speed * Math.cos(rad);
    }
  return uv;
}

function buildHumGrid(samples, sw, ne, cols, rows) {
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const lat = sw.lat + (r/(rows-1))*(ne.lat-sw.lat);
      const lon = sw.lng + (c/(cols-1))*(ne.lng-sw.lng);
      h[r*cols+c] = idwScalar(lat, lon, samples, 'humidity');
    }
  return h;
}

function sampleUV(px, py) {
  const wf = S.windField; if (!wf) return {u:0,v:0};
  const W  = S.windCanvas.width, H = S.windCanvas.height;
  const fc = (px/W)*(wf.cols-1), fr = ((H-py)/H)*(wf.rows-1);
  const c0 = Math.floor(fc), c1 = Math.min(c0+1,wf.cols-1);
  const r0 = Math.floor(fr), r1 = Math.min(r0+1,wf.rows-1);
  const tc = fc-c0, tr = fr-r0;
  const ix = (r,c)=>(r*wf.cols+c)*2;
  const u  = lerp(lerp(wf.uv[ix(r0,c0)],  wf.uv[ix(r0,c1)],  tc), lerp(wf.uv[ix(r1,c0)],  wf.uv[ix(r1,c1)],  tc), tr);
  const v  = lerp(lerp(wf.uv[ix(r0,c0)+1],wf.uv[ix(r0,c1)+1],tc), lerp(wf.uv[ix(r1,c0)+1],wf.uv[ix(r1,c1)+1],tc), tr);
  return { u, v };
}

function sampleHum(px, py) {
  const hf = S.humField; if (!hf) return 72;
  const W  = S.humCanvas.width, H = S.humCanvas.height;
  const fc = (px/W)*(hf.cols-1), fr = ((H-py)/H)*(hf.rows-1);
  const c0 = Math.floor(fc), c1 = Math.min(c0+1,hf.cols-1);
  const r0 = Math.floor(fr), r1 = Math.min(r0+1,hf.rows-1);
  const tc = fc-c0, tr = fr-r0;
  const g  = (r,c)=>hf.h[r*hf.cols+c];
  return lerp(lerp(g(r0,c0),g(r0,c1),tc), lerp(g(r1,c0),g(r1,c1),tc), tr);
}


/* ══════════════════════════════════════════════════════
   6. WIND STREAMLINES
══════════════════════════════════════════════════════ */

function initCanvases() {
  S.humCanvas  = document.getElementById('hum-canvas');
  S.windCanvas = document.getElementById('wind-canvas');
  syncCanvasSize(S.humCanvas);
  syncCanvasSize(S.windCanvas);
  S.humCtx  = S.humCanvas.getContext('2d');
  S.windCtx = S.windCanvas.getContext('2d');
}

function syncCanvasSize(canvas) {
  if (!canvas) return;
  const wrap    = document.getElementById('map-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

function spawnParticles() {
  const W = S.windCanvas.width, H = S.windCanvas.height;
  S.windParticles = Array.from({length:CFG.WIND.PARTICLE_COUNT}, () => ({
    x: Math.random()*W, y: Math.random()*H,
    age: Math.floor(Math.random()*CFG.WIND.MAX_AGE), px:null, py:null,
  }));
}

function startWindParticles() {
  if (S.windRAF) cancelAnimationFrame(S.windRAF);
  syncCanvasSize(S.windCanvas);
  S.windCtx.clearRect(0,0,S.windCanvas.width,S.windCanvas.height);
  spawnParticles();

  const canvas = S.windCanvas, ctx = S.windCtx;

  function frame() {
    if (!S.layerWind) {
      cancelAnimationFrame(S.windRAF);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      return;
    }
    const W = canvas.width, H = canvas.height;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1 - CFG.WIND.FADE;
    ctx.fillRect(0,0,W,H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    for (const p of S.windParticles) {
      const {u,v} = sampleUV(p.x, p.y);
      const speed = Math.hypot(u,v);
      if (speed < 0.08) { resetParticle(p,W,H); continue; }
      const scale = CFG.WIND.SPEED_SCALE*(W/600);
      p.px=p.x; p.py=p.y;
      p.x += u*scale; p.y -= v*scale; p.age++;
      if (p.x<0||p.x>W||p.y<0||p.y>H||p.age>CFG.WIND.MAX_AGE) { resetParticle(p,W,H); continue; }
      const alpha = Math.min(CFG.WIND.MAX_ALPHA, CFG.WIND.MIN_ALPHA+(speed/15)*(CFG.WIND.MAX_ALPHA-CFG.WIND.MIN_ALPHA));
      ctx.beginPath(); ctx.moveTo(p.px,p.py); ctx.lineTo(p.x,p.y);
      ctx.strokeStyle=windColor(speed); ctx.lineWidth=CFG.WIND.LINE_WIDTH; ctx.globalAlpha=alpha; ctx.stroke();
    }
    ctx.globalAlpha=1;
    S.windRAF = requestAnimationFrame(frame);
  }
  frame();
}

function resetParticle(p,W,H) { p.x=Math.random()*W; p.y=Math.random()*H; p.age=0; p.px=null; p.py=null; }

function windColor(speed) {
  const stops = [[0,'#3a007a'],[2,'#1a3aff'],[5,'#00c8ff'],[8,'#00ffaa'],[11,'#aaff00'],[14,'#ffcc00'],[17,'#ff3300']];
  for (let i=1;i<stops.length;i++) {
    const [s0,c0]=stops[i-1],[s1,c1]=stops[i];
    if (speed<=s1) return lerpHex(c0,c1,(speed-s0)/(s1-s0));
  }
  return stops[stops.length-1][1];
}


/* ══════════════════════════════════════════════════════
   7. HUMIDITY FIELD
══════════════════════════════════════════════════════ */

function drawHumidityCanvas() {
  if (!S.humField||!S.layerHum) return;
  const canvas = S.humCanvas, ctx = S.humCtx;
  syncCanvasSize(canvas);
  const W=canvas.width, H=canvas.height;
  const img=ctx.createImageData(W,H); const d=img.data;
  for (let py=0;py<H;py++) for (let px=0;px<W;px++) {
    const h=sampleHum(px,py), rgb=humColor(h), i=(py*W+px)*4;
    d[i]=rgb.r; d[i+1]=rgb.g; d[i+2]=rgb.b; d[i+3]=145;
  }
  ctx.putImageData(img,0,0);
}

function humColor(h) {
  const stops=[[0,'#8B0000'],[25,'#cc3300'],[45,'#ffaa00'],[65,'#aadd00'],[80,'#00ccff'],[100,'#0033cc']];
  h=Math.max(0,Math.min(100,h));
  for (let i=1;i<stops.length;i++) {
    const [h0,c0]=stops[i-1],[h1,c1]=stops[i];
    if (h<=h1) return hexToRgb(lerpHex(c0,c1,(h-h0)/(h1-h0)));
  }
  return hexToRgb(stops[stops.length-1][1]);
}


/* ══════════════════════════════════════════════════════
   8. WEATHER FETCH
══════════════════════════════════════════════════════ */

async function fetchWeatherPoint(lat, lon) {
  const month   = S.selectedMonth;
  const altMode = document.getElementById('selAlt').value;
  let data;

  if (month === 'current') {
    const url = new URL(CFG.API);
    url.searchParams.set('latitude',        lat.toFixed(5));
    url.searchParams.set('longitude',       lon.toFixed(5));
    url.searchParams.set('current',         'relative_humidity_2m,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation,temperature_2m');
    url.searchParams.set('hourly',          'wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m');
    url.searchParams.set('wind_speed_unit', 'ms');
    url.searchParams.set('timezone',        'auto');
    url.searchParams.set('forecast_days',   '1');
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    data = await res.json();
  } else {
    const year = new Date().getFullYear()-1, m=parseInt(month,10);
    const url  = new URL(CFG.ARCHIVE);
    url.searchParams.set('latitude',        lat.toFixed(5));
    url.searchParams.set('longitude',       lon.toFixed(5));
    url.searchParams.set('start_date',      `${year}-${pad(m)}-01`);
    url.searchParams.set('end_date',        `${year}-${pad(m)}-${daysInMonth(year,m)}`);
    url.searchParams.set('hourly',          'relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,cloud_cover,precipitation,temperature_2m');
    url.searchParams.set('wind_speed_unit', 'ms');
    url.searchParams.set('timezone',        'auto');
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Archive ${res.status}`);
    data = await res.json();
  }

  const c    = data.current || {};
  const hAvg = k => { const a=data.hourly?.[k]; if(!a||!a.length)return null; const v=a.filter(x=>x!=null); return v.length?v.reduce((s,x)=>s+x,0)/v.length:null; };

  let windSpeed, windDir;
  if (altMode==='10m') { windSpeed=c['wind_speed_10m']??hAvg('wind_speed_10m')??0; windDir=c['wind_direction_10m']??hAvg('wind_direction_10m')??0; }
  else if (altMode==='80m') { windSpeed=hAvg('wind_speed_80m')??c['wind_speed_10m']??0; windDir=hAvg('wind_direction_80m')??c['wind_direction_10m']??0; }
  else { windSpeed=hAvg('wind_speed_120m')??c['wind_speed_10m']??0; windDir=hAvg('wind_direction_120m')??c['wind_direction_10m']??0; }

  return {
    humidity:  c['relative_humidity_2m']??hAvg('relative_humidity_2m')??0,
    windSpeed: windSpeed??0, windDir: windDir??0,
    temp:   c['temperature_2m']??hAvg('temperature_2m')??15,
    cloud:  c['cloud_cover']??hAvg('cloud_cover')??0,
    precip: c['precipitation']??hAvg('precipitation')??0,
  };
}


/* ══════════════════════════════════════════════════════
   9. FEASIBILITY
══════════════════════════════════════════════════════ */

function computeFeasibility({humidity,elevation,windSpeed,windDir,coastDist}) {
  const F=CFG.F;
  const fog = humidity>=F.FOG_H?{score:100,r:'High',d:`${humidity}% HR — probable niebla densa`}
    : humidity>=F.FOG_M?{score:50,r:'Med',d:`${humidity}% HR — niebla intermitente posible`}
    : {score:0,r:'Low',d:`${humidity}% HR — humedad insuficiente`};

  let es,er,ed;
  if (elevation>=F.ELV_HI_MIN&&elevation<=F.ELV_HI_MAX) {es=100;er='High';ed=`${elevation} m — banda óptima`;}
  else if ((elevation>=F.ELV_ME_MIN&&elevation<F.ELV_HI_MIN)||(elevation>F.ELV_HI_MAX&&elevation<1600)) {es=50;er='Med';ed=`${elevation} m — elevación marginal`;}
  else {es=0;er='Low';ed=elevation<F.ELV_ME_MIN?`${elevation} m — muy baja`:`${elevation} m — muy alta`;}

  const wc=toDirCard(windDir); let ws,wr,wd;
  if (windSpeed>=F.WIN_HI_MIN&&windSpeed<=F.WIN_HI_MAX) {ws=100;wr='High';wd=`${windSpeed.toFixed(1)} m/s de ${wc} — ideal`;}
  else if ((windSpeed>=F.WIN_ME_MIN&&windSpeed<F.WIN_HI_MIN)||(windSpeed>F.WIN_HI_MAX&&windSpeed<=F.WIN_ME_MAX)) {ws=50;wr='Med';wd=`${windSpeed.toFixed(1)} m/s de ${wc} — marginal`;}
  else {ws=0;wr='Low';wd=`${windSpeed.toFixed(1)} m/s de ${wc} — fuera de rango`;}

  let cs,cr,cd;
  if (coastDist<=F.CST_HI) {cs=100;cr='High';cd=`≈${coastDist.toFixed(1)} km — excelente`;}
  else if (coastDist<=F.CST_ME) {cs=50;cr='Med';cd=`≈${coastDist.toFixed(1)} km — influencia moderada`;}
  else {cs=0;cr='Low';cd=`≈${coastDist.toFixed(1)} km — demasiado interior`;}

  const factors=[{name:'Presencia de Niebla',score:fog.score,r:fog.r,d:fog.d},{name:'Elevación',score:es,r:er,d:ed},{name:'Velocidad del Viento',score:ws,r:wr,d:wd},{name:'Proximidad Costera',score:cs,r:cr,d:cd}];
  const minS=Math.min(...factors.map(f=>f.score)), avgS=Math.round(factors.reduce((s,f)=>s+f.score,0)/factors.length);
  const overall=Math.round(.4*minS+.6*avgS), limiting=factors.find(f=>f.score===minS);
  const label=overall>=75?'Excelente':overall>=50?'Prometedor':overall>=25?'Marginal':'Desfavorable';
  return {factors,overall,label,limiting};
}


/* ══════════════════════════════════════════════════════
   10. WATER YIELD — LWC model
══════════════════════════════════════════════════════ */

function estimateLWC(humidity) {
  const Y=CFG.Y;
  if (humidity<Y.LWC_RH_MIN) return 0;
  let lwc;
  if (humidity>=Y.LWC_RH_HI) lwc=0.5+(humidity-Y.LWC_RH_HI)*0.10;
  else if (humidity>=Y.LWC_RH_MED) lwc=0.2+((humidity-Y.LWC_RH_MED)/(Y.LWC_RH_HI-Y.LWC_RH_MED))*0.30;
  else lwc=((humidity-Y.LWC_RH_MIN)/(Y.LWC_RH_MED-Y.LWC_RH_MIN))*0.20;
  return Math.min(lwc,Y.LWC_CAP);
}

function estimateYield(humidity,windSpeed,elevation) {
  const Y=CFG.Y, lwc=estimateLWC(humidity);
  let elvFactor=1.0;
  if (elevation<Y.ELV_OPTIMAL_MIN) elvFactor=Math.max(0.15,elevation/Y.ELV_OPTIMAL_MIN*0.85);
  else if (elevation>Y.ELV_PEN_ABOVE) elvFactor=Math.max(0.20,1-(elevation-Y.ELV_PEN_ABOVE)/1200);
  const windFactor=Math.max(0,windSpeed-0.5);
  const daily=lwc*windFactor*Y.EFFICIENCY*Y.FOG_HOURS*3600/1000*elvFactor;
  return {
    daily:Math.max(0,parseFloat(daily.toFixed(3))),
    lwc:parseFloat(lwc.toFixed(3)), windFactor:parseFloat(windFactor.toFixed(2)),
    elvFactor:parseFloat(elvFactor.toFixed(2)), fogHours:Y.FOG_HOURS, efficiency:Y.EFFICIENCY,
    note:lwc<0.01?'HR insuficiente para niebla líquida (LWC ≈ 0)':lwc<0.2?'Niebla ligera — rendimiento bajo':lwc<0.5?'Niebla moderada — rendimiento razonable':'Niebla densa — buen potencial de captación',
  };
}


/* ══════════════════════════════════════════════════════
   MAP CLICK HANDLER
══════════════════════════════════════════════════════ */

async function onMapClick(lat, lng) {
  document.getElementById('click-hint').classList.add('hidden');
  placeMarker(lat, lng);
  const elevation=getElev(lat,lng);
  S.selectedPoint={lat,lon:lng,elevation};
  document.getElementById('p-empty').classList.add('hidden');
  document.getElementById('p-results').classList.add('hidden');
  document.getElementById('p-loading').classList.remove('hidden');

  try {
    const [weather]=await Promise.all([fetchWeatherPoint(lat,lng)]);
    const coastDist=estimateCoastDist(lat,lng);
    S.weather=weather; S.coastDist=coastDist;
    S.feasibility=computeFeasibility({humidity:weather.humidity,elevation,windSpeed:weather.windSpeed,windDir:weather.windDir,coastDist});
    S.waterYield=estimateYield(weather.humidity,weather.windSpeed,elevation);
    renderPanel({lat,lng,elevation,coastDist,weather,feasibility:S.feasibility,waterYield:S.waterYield});
    loadMonthlyChart(lat,lng);
  } catch(err) { console.error(err); renderError(err.message); }
  finally { document.getElementById('p-loading').classList.add('hidden'); }
}


/* ══════════════════════════════════════════════════════
   11. MONTHLY CHART
══════════════════════════════════════════════════════ */

async function loadMonthlyChart(lat, lng) {
  document.getElementById('chartBadge').classList.remove('hidden');
  const results=[];
  for (let m=1;m<=12;m++) {
    try { const d=await fetchPointData(lat,lng,'wind_speed_10m','wind_direction_10m',String(m)); results.push(estimateYield(d.humidity,d.speed,S.selectedPoint?.elevation??300).daily); }
    catch { results.push(0); }
  }
  document.getElementById('chartBadge').classList.add('hidden');
  renderMonthChart(results);
}

function renderMonthChart(data) {
  const canvas=document.getElementById('monthChart'); if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const grad=ctx.createLinearGradient(0,0,0,130);
  grad.addColorStop(0,'rgba(0,200,255,0.75)'); grad.addColorStop(0.6,'rgba(0,255,170,0.35)'); grad.addColorStop(1,'rgba(0,255,170,0.05)');
  if (S.monthChart) { S.monthChart.data.datasets[0].data=data.map(v=>v??0); S.monthChart.update(); return; }
  S.monthChart=new Chart(canvas,{type:'bar',
    data:{labels:['E','F','M','A','M','J','J','A','S','O','N','D'],datasets:[{data:data.map(v=>v??0),backgroundColor:grad,borderColor:'rgba(0,200,255,0.7)',borderWidth:1,borderRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(8,10,14,.95)',titleColor:'#00c8ff',bodyColor:'#dde2ee',borderColor:'rgba(255,255,255,.08)',borderWidth:1,callbacks:{label:c=>` ${c.parsed.y.toFixed(2)} L/m²/día`}}},
      scales:{x:{ticks:{color:'#4a5570',font:{family:'DM Mono',size:9}},grid:{color:'rgba(255,255,255,.04)'}},y:{beginAtZero:true,ticks:{color:'#4a5570',font:{family:'DM Mono',size:9},callback:v=>v.toFixed(1)},grid:{color:'rgba(255,255,255,.04)'}}}},
  });
}


/* ══════════════════════════════════════════════════════
   12. PANEL RENDER
══════════════════════════════════════════════════════ */

function renderPanel({lat,lng,elevation,coastDist,weather,feasibility,waterYield}) {
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
    {k:'LWC ESTIMADO',v:waterYield.lwc.toFixed(3),u:'g/m³',title:'Contenido de agua líquida derivado de la HR'},
    {k:'FACTOR VIENTO',v:waterYield.windFactor.toFixed(2),u:'m/s efectivo',title:'Velocidad de arrastre de gotas (v − 0.5)'},
    {k:'HORAS NIEBLA',v:waterYield.fogHours,u:'h/día',title:'Estimación promedio de horas de niebla activa'},
    {k:'EFICIENCIA',v:(waterYield.efficiency*100).toFixed(0),u:'%',title:'Eficiencia del colector — malla Raschel estándar'},
  ].map(d=>`<div class="yd-item" title="${d.title}"><div class="yd-k">${d.k}</div><div class="yd-v">${d.v}<span class="yd-u">${d.u}</span></div></div>`).join('');
  const fl=document.getElementById('factorList'); fl.innerHTML='';
  feasibility.factors.forEach(f=>{
    const cls=f.r==='High'?'high':f.r==='Med'?'med':'low';
    const lim=(f===feasibility.limiting&&feasibility.overall<75)?' lim':'';
    fl.insertAdjacentHTML('beforeend',`<div class="factor-item${lim}"><div class="fi-top"><span class="fi-name">${f.name}</span><span class="fi-badge ${cls}">${f.r==='High'?'Alto':f.r==='Med'?'Medio':'Bajo'}</span></div><div class="fi-bar"><div class="fi-bar-fill ${cls}" style="width:0%" data-w="${f.score}%"></div></div><div class="fi-detail">${f.d}</div></div>`);
  });
  requestAnimationFrame(()=>document.querySelectorAll('.fi-bar-fill').forEach(b=>{b.style.width=b.dataset.w;}));
  document.getElementById('atmGrid').innerHTML=[
    {k:'HUMEDAD',v:weather.humidity,u:'%'},{k:'VIENTO',v:weather.windSpeed.toFixed(1),u:'m/s'},
    {k:'DIRECCIÓN',v:toDirCard(weather.windDir),u:`${Math.round(weather.windDir)}°`},{k:'TEMP',v:weather.temp.toFixed(1),u:'°C'},
    {k:'NUBOSIDAD',v:weather.cloud,u:'%'},{k:'PRECIPIT.',v:(weather.precip||0).toFixed(1),u:'mm'},
  ].map(i=>`<div class="atm-item"><div class="atm-k">${i.k}</div><div class="atm-v">${i.v}<span class="atm-u">${i.u}</span></div></div>`).join('');
  document.getElementById('p-results').classList.remove('hidden');
}

function renderError(msg) {
  const r=document.getElementById('p-results'); r.classList.remove('hidden');
  r.innerHTML=`<div style="padding:20px;text-align:center;color:var(--danger);font-size:11px;line-height:1.7"><p style="font-size:13px;margin-bottom:8px">⚠ Error de Análisis</p><p>${msg}</p><p style="margin-top:10px;color:var(--mute)">Revisa tu conexión y las claves de API.</p></div>`;
}

function animArc(score) {
  const arc=document.getElementById('scoreArc'), circ=289;
  arc.style.transition='none'; arc.style.strokeDashoffset=circ;
  requestAnimationFrame(()=>{
    arc.style.transition='stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)';
    arc.style.strokeDashoffset=circ-(score/100)*circ;
    const [c1,c2]=score>=75?['#00c8ff','#00ffaa']:score>=50?['#0066ff','#00c8ff']:score>=25?['#ff9900','#ffcc00']:['#ff2244','#ff5566'];
    document.getElementById('sg0').setAttribute('stop-color',c1);
    document.getElementById('sg1').setAttribute('stop-color',c2);
  });
}
function scoreColor(s){return s>=75?'#00ffaa':s>=50?'#00c8ff':s>=25?'#ffb830':'#ff4466';}


/* ══════════════════════════════════════════════════════
   13. EXPORT
══════════════════════════════════════════════════════ */

document.getElementById('expCSV').addEventListener('click',()=>{const d=exportData();if(!d)return;dl([Object.keys(d).join(','),Object.values(d).map(v=>`"${v}"`).join(',')].join('\n'),'text/csv','fogharvest.csv');});
document.getElementById('expJSON').addEventListener('click',()=>{const d=exportData();if(!d)return;dl(JSON.stringify(d,null,2),'application/json','fogharvest.json');});
document.getElementById('expIMG').addEventListener('click',async()=>{try{const c=await html2canvas(document.getElementById('map-wrap'),{useCORS:true,scale:1,logging:false});c.toBlob(b=>{const u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='fogharvest-map.png';a.click();URL.revokeObjectURL(u);});}catch{alert('Captura no disponible por tiles de origen cruzado.');}});

function exportData() {
  if (!S.selectedPoint||!S.weather||!S.feasibility){alert('Selecciona un punto en el mapa primero.');return null;}
  const p=S.selectedPoint,w=S.weather,f=S.feasibility,y=S.waterYield;
  return {latitud:p.lat,longitud:p.lon,elevacion_m:p.elevation,distancia_costa_km:S.coastDist??0,mes:S.selectedMonth,humedad_pct:w.humidity,viento_ms:w.windSpeed,dir_viento_deg:w.windDir,temperatura_c:w.temp,nubosidad_pct:w.cloud,precipitacion_mm:w.precip,lwc_g_m3:y?.lwc??0,rendimiento_l_m2_dia:y?.daily??0,eficiencia_colector:y?.efficiency??0,horas_niebla_dia:y?.fogHours??0,factibilidad_pct:f.overall,factibilidad_label:f.label,factor_niebla:f.factors[0].r,factor_elevacion:f.factors[1].r,factor_viento:f.factors[2].r,factor_costa:f.factors[3].r,factor_limitante:f.limiting?.name??'ninguno',timestamp:new Date().toISOString()};
}
function dl(content,mime,name){const u=URL.createObjectURL(new Blob([content],{type:mime}));const a=document.createElement('a');a.href=u;a.download=name;a.click();URL.revokeObjectURL(u);}


/* ══════════════════════════════════════════════════════
   14. UTILITIES
══════════════════════════════════════════════════════ */

function placeMarker(lat,lng) {
  const el=document.createElement('div');
  el.innerHTML=`<svg width="30" height="30" viewBox="0 0 30 30" fill="none"><circle cx="15" cy="15" r="13" stroke="#00c8ff" stroke-width="1.3" stroke-dasharray="3 3"/><circle cx="15" cy="15" r="3.5" fill="#00c8ff"/><line x1="15" y1="1" x2="15" y2="7" stroke="#00c8ff" stroke-width="1.3"/><line x1="15" y1="23" x2="15" y2="29" stroke="#00c8ff" stroke-width="1.3"/><line x1="1" y1="15" x2="7" y2="15" stroke="#00c8ff" stroke-width="1.3"/><line x1="23" y1="15" x2="29" y2="15" stroke="#00c8ff" stroke-width="1.3"/></svg>`;
  el.style.cssText='width:30px;height:30px;cursor:pointer;';
  if (S.marker) S.marker.remove();
  S.marker=new maptilersdk.Marker({element:el,anchor:'center'}).setLngLat([lng,lat]).addTo(S.map);
}

function getElev(lat,lng) {
  try { const e=S.map.queryTerrainElevation([lng,lat],{exaggerated:false}); return e!=null?Math.round(e):0; }
  catch { return 0; }
}

function estimateCoastDist(lat,lng) {
  if (!S.map.isStyleLoaded()) return 999;
  const N=16,MAX=CFG.COAST_RADIUS_KM,STEP=0.4; let min=MAX;
  for (let b=0;b<N;b++) {
    const bearing=(b/N)*360;
    for (let km=STEP;km<=MAX;km+=STEP) {
      const pt=turf.destination([lng,lat],km,bearing,{units:'kilometers'});
      try {
        const e=S.map.queryTerrainElevation([pt.geometry.coordinates[0],pt.geometry.coordinates[1]],{exaggerated:false});
        if (e!==null&&e<=10){if(km<min)min=km;break;}
      } catch{break;}
    }
  }
  return min;
}

function idwVec(lat,lon,pts,pow=2) {
  let su=0,sv=0,ss=0,sw=0;
  for (const p of pts){const d=Math.hypot(lat-p.lat,lon-p.lon)||1e-9,w=1/Math.pow(d,pow),r=(p.dir*Math.PI)/180;su+=w*Math.sin(r);sv+=w*Math.cos(r);ss+=w*p.speed;sw+=w;}
  const dir=((Math.atan2(su/sw,sv/sw)*180)/Math.PI+360)%360;
  return {speed:ss/sw,dir};
}

function idwScalar(lat,lon,pts,key,pow=2) {
  let sv=0,sw=0;
  for (const p of pts){if(p[key]==null)continue;const d=Math.hypot(lat-p.lat,lon-p.lon)||1e-9,w=1/Math.pow(d,pow);sv+=w*p[key];sw+=w;}
  return sw?sv/sw:0;
}

async function fetchConcurrent(tasks,limit=5) {
  const results=new Array(tasks.length); let idx=0;
  async function worker(){while(idx<tasks.length){const i=idx++;results[i]=await tasks[i]();}}
  await Promise.all(Array.from({length:Math.min(limit,tasks.length)},worker));
  return results;
}

function windParams(alt) {
  if (alt==='10m') return {speedParam:'wind_speed_10m',dirParam:'wind_direction_10m'};
  if (alt==='80m') return {speedParam:'wind_speed_80m',dirParam:'wind_direction_80m'};
  return {speedParam:'wind_speed_120m',dirParam:'wind_direction_120m'};
}

function toDirCard(d){return['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d/22.5)%16];}
function lerp(a,b,t){return a+(b-a)*t;}
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}
function lerpHex(c1,c2,t){t=Math.max(0,Math.min(1,t));const p=c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];const a=p(c1),b=p(c2);return'#'+[0,1,2].map(i=>Math.round(a[i]+(b[i]-a[i])*t).toString(16).padStart(2,'0')).join('');}
function hexToRgb(h){return{r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16)};}
function daysInMonth(y,m){return new Date(y,m,0).getDate();}
function pad(n){return String(n).padStart(2,'0');}

function setStatus(state,alt,month) {
  const dot=document.getElementById('stDot'),txt=document.getElementById('stText');
  dot.className='st-dot';
  if (state==='active'){dot.classList.add('on');const mLabel=month==='current'?'AHORA':['','ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'][parseInt(month)||0];txt.textContent=`VIENTO ACTIVO · ${alt.toUpperCase()} · ${mLabel}`;}
  else if (state==='error'){dot.classList.add('err');txt.textContent='ERROR AL CARGAR VIENTO';}
  else {txt.textContent='CARGANDO DATOS DE VIENTO…';}
}

function showApp() {
  setTimeout(()=>{
    document.getElementById('loader').classList.add('out');
    setTimeout(()=>{
      document.getElementById('loader').style.display='none';
      document.getElementById('app').classList.remove('hidden');
      setTimeout(()=>S.map&&S.map.resize(),80);
    },550);
  },2200);
}


/* ══════════════════════════════════════════════════════
   15. BOOT
══════════════════════════════════════════════════════ */

document.getElementById('btnWind').addEventListener('click',function(){
  S.layerWind=!S.layerWind; this.classList.toggle('active',S.layerWind);
  if(S.layerWind)startWindParticles();
  else{cancelAnimationFrame(S.windRAF);S.windCtx.clearRect(0,0,S.windCanvas.width,S.windCanvas.height);}
});

document.getElementById('btnHum').addEventListener('click',function(){
  S.layerHum=!S.layerHum; this.classList.toggle('active',S.layerHum);
  if(S.layerHum)drawHumidityCanvas();
  else S.humCtx.clearRect(0,0,S.humCanvas.width,S.humCanvas.height);
});

document.getElementById('btnRefresh').addEventListener('click',fetchWindField);
document.getElementById('selAlt').addEventListener('change',fetchWindField);
document.getElementById('selMonth').addEventListener('change',e=>{
  S.selectedMonth=e.target.value; fetchWindField();
  if(S.selectedPoint)onMapClick(S.selectedPoint.lat,S.selectedPoint.lon);
});

document.getElementById('btnPanel').addEventListener('click',()=>{
  S.panelOpen=!S.panelOpen;
  document.getElementById('panel').classList.toggle('collapsed',!S.panelOpen);
  setTimeout(()=>S.map&&S.map.resize(),320);
});

window.addEventListener('DOMContentLoaded',()=>{
  initMap();
  initSearch();
});