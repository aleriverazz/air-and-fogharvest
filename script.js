/* ═══════════════════════════════════════════════════════════════════════
   FogHarvest v4 · script.js
   ─────────────────────────────────────────────────────────────────────
   Changes from v3:
   • Map engine: MapTiler custom style + MapTiler terrain-rgb-v2 DEM
     (Mapbox GL JS renderer is kept — MapTiler is fully compatible)
   • Search bar: MapTiler Geocoding API with debounced dropdown
   • LWC water-yield model: refined two-phase formula with detailed
     breakdown display (LWC, wind factor, fog-hours, efficiency)
   • All other systems (streamlines, humidity field, panel, export)
     remain identical to v3
   ─────────────────────────────────────────────────────────────────────
   Structure:
    1.  CONFIG          – API keys, thresholds, particle settings
    2.  STATE           – shared mutable state
    3.  MAP INIT        – MapTiler map + terrain DEM
    4.  SEARCH BAR      – MapTiler Geocoding dropdown
    5.  WIND FIELD      – IDW-interpolated UV raster
    6.  WIND STREAMLINES– earth.nullschool particle animation (rAF)
    7.  HUMIDITY FIELD  – per-pixel color wash
    8.  WEATHER FETCH   – Open-Meteo point forecast / archive
    9.  FEASIBILITY     – scoring algorithm
   10.  WATER YIELD     – quantitative LWC model
   11.  MONTHLY CHART   – Chart.js 12-month bar chart
   12.  PANEL RENDER    – update analysis panel UI
   13.  EXPORT          – CSV / JSON / Screenshot
   14.  UTILITIES       – helpers, color maps
   15.  BOOT            – event wiring + entry point
═══════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════
   1. CONFIG
══════════════════════════════════════════════════════ */
const CFG = {

  /* ── MapTiler ── */
  MT_KEY:  'YU4AkYjwr3SI0k0mKRLc',
  // Custom style URL — terrain already baked into this style via MapTiler Studio
  MT_STYLE: 'https://api.maptiler.com/maps/019cca32-19d8-7506-b7e2-b8e61efa521e/style.json?key=YU4AkYjwr3SI0k0mKRLc',
  // Fallback DEM in case the style doesn't expose terrain source directly
  MT_TERRAIN_URL: 'https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=YU4AkYjwr3SI0k0mKRLc',
  // MapTiler Geocoding endpoint
  MT_GEOCODE: 'https://api.maptiler.com/geocoding',

  /* ── Map defaults (Rosarito, Baja California) ── */
  CENTER:      [-116.94, 32.52],
  ZOOM:        11.5,
  PITCH:       58,
  BEARING:     -18,
  TERRAIN_EXG: 1.5,   // exaggeration per MapTiler recommendation

  /* ── Open-Meteo endpoints ── */
  API:     'https://api.open-meteo.com/v1/forecast',
  ARCHIVE: 'https://archive-api.open-meteo.com/v1/archive',

  COAST_RADIUS_KM: 30,

  /* ── Wind field grid resolution ── */
  GRID: {
    COLS: 22,  // interpolated columns
    ROWS: 16,  // interpolated rows
  },

  /* ── Streamline particles (earth.nullschool style) ──
     ─ SPEED_SCALE:    pixels-per-frame per m/s of wind.
                       0.18 = slow, realistic drift — terrain stays readable.
                       (0.55 was the original, felt like a hurricane)
     ─ FADE:           how much each frame erases old trails.
                       0.97 = short trails, terrain always visible underneath.
                       Lower = longer glowing comet tails but map gets buried.
     ─ PARTICLE_COUNT: 2200 is dense enough to read flow without clogging.
     ─ MAX_ALPHA:      cap on particle brightness — 0.40 keeps it translucent
                       so you can read topography through the wind layer.
     ─ LINE_WIDTH:     0.9 px = hairline — analytical / scientific feel.     */
  WIND: {
    PARTICLE_COUNT: 2200,
    FADE:           0.97,   // short trails → terrain shows through
    SPEED_SCALE:    0.18,   // slow drift — proportional to real wind speed
    LINE_WIDTH:     0.9,    // hairline particles
    MAX_AGE:        120,    // longer life compensates for slower movement
    MAX_ALPHA:      0.40,   // hard cap — never fully opaque over terrain
    MIN_ALPHA:      0.10,   // minimum glow even at low speeds
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

  /* ── Water yield model parameters ──
     See section 10 for the full formula and assumptions.
     These are the knobs to tune if you want to calibrate for
     a specific region or collector design.                    */
  Y: {
    EFFICIENCY: 0.20,   // fog net collection efficiency (20% = standard Raschel mesh)
    FOG_HOURS:  8,      // assumed fog hours per day (adjust per site climatology)
    // LWC thresholds (see estimateLWC() for full derivation)
    LWC_RH_MIN:  80,    // minimum RH (%) for any LWC
    LWC_RH_MED:  90,    // RH threshold for medium-density fog
    LWC_RH_HI:   95,    // RH threshold for dense fog
    LWC_CAP:     3.0,   // maximum LWC cap (g/m³) — real fog rarely exceeds this
    // Elevation modifiers
    ELV_OPTIMAL_MIN: 180,  // optimal elevation band (m)
    ELV_OPTIMAL_MAX: 850,
    ELV_PEN_ABOVE:   900,  // penalty starts here
  },
};


/* ══════════════════════════════════════════════════════
   2. STATE
══════════════════════════════════════════════════════ */
const S = {
  map:    null,
  marker: null,

  /* Wind field — UV Float32Array raster + bounds */
  windField:     null,
  windParticles: [],
  windCanvas:    null,
  windCtx:       null,
  windRAF:       null,

  /* Humidity field */
  humField:  null,
  humCanvas: null,
  humCtx:    null,

  /* API sample points */
  gridSamples: [],

  /* Selected analysis point */
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

  /* Search */
  searchTimer: null,   // debounce timer handle
};


/* ══════════════════════════════════════════════════════
   3. MAP INIT — MapTiler custom style + terrain
   ──────────────────────────────────────────────────────
   The MapTiler Studio style at MT_STYLE already has 3D
   terrain configured.  We load it directly.
   Mapbox GL JS still requires a non-empty accessToken
   even for non-Mapbox styles — we set a dummy value since
   authentication happens via the ?key= URL parameter.
══════════════════════════════════════════════════════ */
function initMap() {
  // Required by Mapbox GL JS renderer even when using MapTiler
  mapboxgl.accessToken = 'pk.eyJ1IjoibWFwdGlsZXIiLCJhIjoiY2x0ZHVtMDRzMDB3NjJrcDhvMzJ2cmI4ZiJ9.dummy';

  S.map = new mapboxgl.Map({
    container:  'map',
    style:      CFG.MT_STYLE,   // MapTiler custom style (terrain already in style)
    center:     CFG.CENTER,
    zoom:       CFG.ZOOM,
    pitch:      CFG.PITCH,
    bearing:    CFG.BEARING,
    antialias:  true,
  });

  S.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  S.map.on('load', () => {

    /* ── 3D Terrain ─────────────────────────────────────────────────
       The MapTiler Studio style already includes terrain.
       We only add the DEM source + setTerrain as a safety fallback
       in case the style was saved without terrain enabled.          */
    const alreadyHasTerrain = (() => {
      try { return S.map.getTerrain() !== null; } catch { return false; }
    })();

    if (!alreadyHasTerrain) {
      if (!S.map.getSource('maptiler-dem')) {
        S.map.addSource('maptiler-dem', {
          type:     'raster-dem',
          url:      CFG.MT_TERRAIN_URL,
          tileSize: 512,
          maxzoom:  14,
        });
      }
      S.map.setTerrain({ source: 'maptiler-dem', exaggeration: CFG.TERRAIN_EXG });
    }
    // Terrain from the style is already active — leave it as-is

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

  // Surface any tile / style errors to the browser console
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
   ──────────────────────────────────────────────────────
   Endpoint: GET /geocoding/{query}.json?key=…
   Returns GeoJSON FeatureCollection with place results.
   We show a styled dropdown; on select, flyTo the place.
══════════════════════════════════════════════════════ */

function initSearch() {
  const input    = document.getElementById('searchInput');
  const dropdown = document.getElementById('searchDropdown');
  const clearBtn = document.getElementById('searchClear');

  /* ── Debounced input handler ── */
  input.addEventListener('input', () => {
    const q = input.value.trim();

    /* Show/hide clear button */
    clearBtn.classList.toggle('hidden', q.length === 0);

    /* Cancel previous timer */
    clearTimeout(S.searchTimer);

    if (q.length < 2) { hideDropdown(); return; }

    /* Show loading state after 100ms */
    S.searchTimer = setTimeout(() => geocodeSearch(q), 350);
  });

  /* ── Clear button ── */
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    hideDropdown();
    input.focus();
  });

  /* ── Close dropdown when clicking outside ── */
  document.addEventListener('click', e => {
    if (!document.getElementById('searchWrap').contains(e.target)) {
      hideDropdown();
    }
  });

  /* ── Keyboard navigation ── */
  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('.search-item');
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
    if (e.key === 'Enter') {
      const selected = active || items[0];
      selected?.click();
    }
  });
}

async function geocodeSearch(query) {
  const dropdown = document.getElementById('searchDropdown');

  /* Show loading */
  dropdown.innerHTML = `<div class="search-loading">Buscando…</div>`;
  dropdown.classList.remove('hidden');

  try {
    const url = `${CFG.MT_GEOCODE}/${encodeURIComponent(query)}.json?key=${CFG.MT_KEY}&limit=6&language=es`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
    const data = await res.json();

    const features = data.features || [];

    if (features.length === 0) {
      dropdown.innerHTML = `<div class="search-no-results">Sin resultados para "${query}"</div>`;
      return;
    }

    /* Build dropdown items */
    dropdown.innerHTML = '';
    features.forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const name       = f.text || f.place_name || 'Lugar desconocido';
      const placeName  = f.place_name || '';
      // Strip the primary name from the full place_name to get the sub-text
      const subText    = placeName.replace(/^[^,]+,\s*/, '').trim();

      const item = document.createElement('div');
      item.className = 'search-item';
      item.innerHTML = `
        <span class="si-name">${escHtml(name)}</span>
        ${subText ? `<span class="si-place">${escHtml(subText)}</span>` : ''}
        <span class="si-coords">${lat.toFixed(4)}°, ${lon.toFixed(4)}°</span>
      `;
      item.addEventListener('click', () => {
        /* Fly the map to selected location */
        S.map.flyTo({ center: [lon, lat], zoom: 13, pitch: CFG.PITCH, bearing: CFG.BEARING, duration: 1400 });
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

function hideDropdown() {
  document.getElementById('searchDropdown').classList.add('hidden');
}

/* XSS-safe HTML escaping for search results */
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


/* ══════════════════════════════════════════════════════
   5. WIND FIELD — IDW-interpolated UV raster
   ──────────────────────────────────────────────────────
   Strategy:
   1. Sample a 5×4 sparse grid from Open-Meteo API
   2. IDW-interpolate to a dense 22×16 raster of U/V vectors
   3. Wind streamlines (section 6) sample this raster in real-time
══════════════════════════════════════════════════════ */

async function fetchWindField() {
  const map = S.map;
  if (!map || !map.isStyleLoaded()) return;

  setStatus('loading');

  const alt    = document.getElementById('selAlt').value;
  const month  = S.selectedMonth;
  const { speedParam, dirParam } = windParams(alt);

  const b  = map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();

  /* Sparse 5×4 sample grid */
  const SCOLS = 5, SROWS = 4;
  const pts   = [];
  for (let r = 0; r < SROWS; r++)
    for (let c = 0; c < SCOLS; c++)
      pts.push({
        lat: sw.lat + (r / (SROWS-1)) * (ne.lat - sw.lat),
        lon: sw.lng + (c / (SCOLS-1)) * (ne.lng - sw.lng),
      });

  try {
    /* Fetch all sample points with concurrency limit */
    const fetched = await fetchConcurrent(
      pts.map(pt => () => fetchPointData(pt.lat, pt.lon, speedParam, dirParam, month)),
      5
    );

    pts.forEach((pt, i) => {
      pt.speed    = fetched[i].speed;
      pt.dir      = fetched[i].dir;
      pt.humidity = fetched[i].humidity;
    });

    S.gridSamples = pts;

    /* Build dense UV grid and humidity grid via IDW */
    const COLS = CFG.GRID.COLS;
    const ROWS = CFG.GRID.ROWS;

    S.windField = { cols:COLS, rows:ROWS, uv: buildUVGrid(pts,sw,ne,COLS,ROWS), bounds:{sw,ne} };
    S.humField  = { cols:COLS, rows:ROWS, h:  buildHumGrid(pts,sw,ne,COLS,ROWS), bounds:{sw,ne} };

    if (S.layerHum)  drawHumidityCanvas();
    if (S.layerWind) startWindParticles();

    setStatus('active', alt, month);

  } catch (err) {
    console.error('[FogHarvest] Wind fetch error:', err);
    setStatus('error');
  }
}

/* Fetch wind + humidity for one lat/lon from Open-Meteo */
async function fetchPointData(lat, lon, speedParam, dirParam, month) {
  let data;

  if (month === 'current') {
    /* Forecast mode:
       - wind_speed_10m and wind_direction_10m → available in 'current' block
       - 80m / 120m wind → only available in 'hourly'
       - humidity → available in 'current'                                  */
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
    /* Archive mode: all variables available as hourly */
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

  /* Helper: average all non-null hourly values */
  const hAvg = k => {
    const a = data.hourly?.[k];
    if (!a || !a.length) return null;
    const v = a.filter(x => x != null);
    return v.length ? v.reduce((s,x)=>s+x, 0)/v.length : null;
  };

  const c        = data.current || {};
  const humidity = c['relative_humidity_2m'] ?? hAvg('relative_humidity_2m') ?? 72;

  /* Select wind by altitude mode */
  const altMode = document.getElementById('selAlt').value;
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

/* Build U/V (wind vector) grid via IDW from sample points */
function buildUVGrid(samples, sw, ne, cols, rows) {
  const uv = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat  = sw.lat + (r/(rows-1))*(ne.lat-sw.lat);
      const lon  = sw.lng + (c/(cols-1))*(ne.lng-sw.lng);
      const {speed, dir} = idwVec(lat, lon, samples);
      const rad = (dir * Math.PI) / 180;
      const idx = (r*cols+c)*2;
      uv[idx]   =  speed * Math.sin(rad);  // U: eastward
      uv[idx+1] = -speed * Math.cos(rad);  // V: northward (negated for screen coords)
    }
  }
  return uv;
}

/* Build scalar humidity grid via IDW */
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

/* Bilinear sample of wind UV field at screen pixel (px, py) */
function sampleUV(px, py) {
  const wf = S.windField;
  if (!wf) return { u:0, v:0 };
  const W  = S.windCanvas.width, H = S.windCanvas.height;
  const fc = (px/W)*(wf.cols-1);
  const fr = ((H-py)/H)*(wf.rows-1);
  const c0 = Math.floor(fc), c1 = Math.min(c0+1,wf.cols-1);
  const r0 = Math.floor(fr), r1 = Math.min(r0+1,wf.rows-1);
  const tc = fc-c0, tr = fr-r0;
  const ix = (r,c) => (r*wf.cols+c)*2;
  const u  = lerp(lerp(wf.uv[ix(r0,c0)],  wf.uv[ix(r0,c1)],  tc),
                  lerp(wf.uv[ix(r1,c0)],  wf.uv[ix(r1,c1)],  tc), tr);
  const v  = lerp(lerp(wf.uv[ix(r0,c0)+1],wf.uv[ix(r0,c1)+1],tc),
                  lerp(wf.uv[ix(r1,c0)+1],wf.uv[ix(r1,c1)+1],tc), tr);
  return { u, v };
}

/* Bilinear sample of humidity field at screen pixel (px, py) */
function sampleHum(px, py) {
  const hf = S.humField;
  if (!hf) return 72;
  const W  = S.humCanvas.width, H = S.humCanvas.height;
  const fc = (px/W)*(hf.cols-1);
  const fr = ((H-py)/H)*(hf.rows-1);
  const c0 = Math.floor(fc), c1 = Math.min(c0+1,hf.cols-1);
  const r0 = Math.floor(fr), r1 = Math.min(r0+1,hf.rows-1);
  const tc = fc-c0, tr = fr-r0;
  const g  = (r,c) => hf.h[r*hf.cols+c];
  return lerp(lerp(g(r0,c0),g(r0,c1),tc), lerp(g(r1,c0),g(r1,c1),tc), tr);
}


/* ══════════════════════════════════════════════════════
   6. WIND STREAMLINES — earth.nullschool particle animation
   ──────────────────────────────────────────────────────
   How it works:
   • 3 500 particles each have a random (x, y) on the canvas
   • Every frame:
     1. Paint a near-opaque dark rect → fades old trails (the
        "glowing comet tail" effect from earth.nullschool)
     2. For each particle: sample UV field → advance position →
        draw a short colored line segment (color = wind speed)
     3. Reset any particle that goes off-screen or reaches MAX_AGE
   • Color ramp mirrors zoom.earth wind-gust layer:
     dark-purple → blue → cyan → teal-green → yellow → amber → red
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
  const wrap     = document.getElementById('map-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

function spawnParticles() {
  const W = S.windCanvas.width, H = S.windCanvas.height;
  S.windParticles = Array.from({ length: CFG.WIND.PARTICLE_COUNT }, () => ({
    x:   Math.random() * W,
    y:   Math.random() * H,
    age: Math.floor(Math.random() * CFG.WIND.MAX_AGE),
    px:  null, py: null,
  }));
}

function startWindParticles() {
  if (S.windRAF) cancelAnimationFrame(S.windRAF);
  syncCanvasSize(S.windCanvas);
  S.windCtx.clearRect(0, 0, S.windCanvas.width, S.windCanvas.height);
  spawnParticles();

  const canvas = S.windCanvas;
  const ctx    = S.windCtx;

  function frame() {
    if (!S.layerWind) {
      cancelAnimationFrame(S.windRAF);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const W = canvas.width, H = canvas.height;

    /* ── Trail fade ────────────────────────────────────────────────────
       We clear with a transparent rect instead of a dark solid fill.
       This means old trail segments fade to nothing, NOT to a dark
       colour — so the map terrain is always fully visible underneath.
       Alpha = (1 - FADE): at 0.97 this erases ~3% of brightness each
       frame, giving short crisp trails that dissolve into transparency. */
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1 - CFG.WIND.FADE;   // 0.03 at FADE=0.97
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    for (const p of S.windParticles) {
      const { u, v } = sampleUV(p.x, p.y);
      const speed    = Math.hypot(u, v);

      if (speed < 0.08) { resetParticle(p, W, H); continue; }

      /* Advance position — scale is slow (0.18) so particles drift
         realistically; faster wind just moves them further per frame */
      const scale = CFG.WIND.SPEED_SCALE * (W / 600);
      p.px = p.x; p.py = p.y;
      p.x +=  u * scale;
      p.y -=  v * scale;   // screen Y inverted vs geographic North
      p.age++;

      if (p.x < 0 || p.x > W || p.y < 0 || p.y > H || p.age > CFG.WIND.MAX_AGE) {
        resetParticle(p, W, H); continue;
      }

      /* Alpha: very light — MIN_ALPHA at low speed → MAX_ALPHA at 15 m/s
         Both values are deliberately low so terrain reads through clearly */
      const alpha = Math.min(
        CFG.WIND.MAX_ALPHA,
        CFG.WIND.MIN_ALPHA + (speed / 15) * (CFG.WIND.MAX_ALPHA - CFG.WIND.MIN_ALPHA)
      );

      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x,  p.y);
      ctx.strokeStyle = windColor(speed);
      ctx.lineWidth   = CFG.WIND.LINE_WIDTH;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    S.windRAF = requestAnimationFrame(frame);
  }

  frame();
}

function resetParticle(p, W, H) {
  p.x = Math.random() * W; p.y = Math.random() * H;
  p.age = 0; p.px = null; p.py = null;
}

/*
 * Wind speed → colour — nullschool / zoom.earth palette
 * 0 m/s  → dark purple  #3a007a
 * 2 m/s  → deep blue    #1a3aff
 * 5 m/s  → cyan         #00c8ff
 * 8 m/s  → teal-green   #00ffaa
 * 11 m/s → yellow-green #aaff00
 * 14 m/s → amber        #ffcc00
 * 17+ m/s→ red          #ff3300
 */
function windColor(speed) {
  const stops = [
    [0,  '#3a007a'], [2,  '#1a3aff'], [5,  '#00c8ff'],
    [8,  '#00ffaa'], [11, '#aaff00'], [14, '#ffcc00'], [17, '#ff3300'],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [s0,c0] = stops[i-1], [s1,c1] = stops[i];
    if (speed <= s1) return lerpHex(c0, c1, (speed-s0)/(s1-s0));
  }
  return stops[stops.length-1][1];
}


/* ══════════════════════════════════════════════════════
   7. HUMIDITY FIELD — continuous per-pixel color wash
   ──────────────────────────────────────────────────────
   Technique: createImageData → paint every pixel by sampling
   the bilinear-interpolated humidity grid → putImageData.
   This produces a perfectly smooth, seamless field — no
   visible blobs or gradient edges.
   Color scale: zoom.earth moisture layer palette.
══════════════════════════════════════════════════════ */

function drawHumidityCanvas() {
  if (!S.humField || !S.layerHum) return;
  const canvas = S.humCanvas;
  const ctx    = S.humCtx;
  syncCanvasSize(canvas);

  const W = canvas.width, H = canvas.height;
  const img = ctx.createImageData(W, H);
  const d   = img.data;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const h   = sampleHum(px, py);
      const rgb = humColor(h);
      const i   = (py * W + px) * 4;
      d[i]   = rgb.r; d[i+1] = rgb.g; d[i+2] = rgb.b;
      d[i+3] = 145;  /* ~57% opacity — semi-transparent over map */
    }
  }
  ctx.putImageData(img, 0, 0);
}

/*
 * Humidity (%) → RGB — zoom.earth moisture palette
 * 0%  → dark crimson #8B0000
 * 25% → red-orange   #cc3300
 * 45% → amber        #ffaa00
 * 65% → yellow-green #aadd00
 * 80% → sky blue     #00ccff
 * 100%→ deep blue    #0033cc
 */
function humColor(h) {
  const stops = [
    [0,   '#8B0000'], [25,  '#cc3300'], [45,  '#ffaa00'],
    [65,  '#aadd00'], [80,  '#00ccff'], [100, '#0033cc'],
  ];
  h = Math.max(0, Math.min(100, h));
  for (let i = 1; i < stops.length; i++) {
    const [h0,c0] = stops[i-1], [h1,c1] = stops[i];
    if (h <= h1) return hexToRgb(lerpHex(c0, c1, (h-h0)/(h1-h0)));
  }
  return hexToRgb(stops[stops.length-1][1]);
}


/* ══════════════════════════════════════════════════════
   8. WEATHER FETCH — Open-Meteo point forecast / archive
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
    const year = new Date().getFullYear() - 1;
    const m    = parseInt(month, 10);
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
  const hAvg = k => {
    const a = data.hourly?.[k]; if (!a||!a.length) return null;
    const v = a.filter(x=>x!=null); return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;
  };

  let windSpeed, windDir;
  if (altMode === '10m') {
    windSpeed = c['wind_speed_10m']    ?? hAvg('wind_speed_10m')    ?? 0;
    windDir   = c['wind_direction_10m']?? hAvg('wind_direction_10m')?? 0;
  } else if (altMode === '80m') {
    windSpeed = hAvg('wind_speed_80m')    ?? c['wind_speed_10m']    ?? 0;
    windDir   = hAvg('wind_direction_80m')?? c['wind_direction_10m']?? 0;
  } else {
    windSpeed = hAvg('wind_speed_120m')    ?? c['wind_speed_10m']    ?? 0;
    windDir   = hAvg('wind_direction_120m')?? c['wind_direction_10m']?? 0;
  }

  return {
    humidity:  c['relative_humidity_2m'] ?? hAvg('relative_humidity_2m') ?? 0,
    windSpeed: windSpeed ?? 0,
    windDir:   windDir   ?? 0,
    temp:      c['temperature_2m']  ?? hAvg('temperature_2m')  ?? 15,
    cloud:     c['cloud_cover']     ?? hAvg('cloud_cover')     ?? 0,
    precip:    c['precipitation']   ?? hAvg('precipitation')   ?? 0,
  };
}


/* ══════════════════════════════════════════════════════
   9. FEASIBILITY ALGORITHM
   ──────────────────────────────────────────────────────
   Bottleneck model: overall = 40% × min_factor + 60% × average
   Four factors: fog presence (RH), elevation, wind speed, coast dist
══════════════════════════════════════════════════════ */

function computeFeasibility({ humidity, elevation, windSpeed, windDir, coastDist }) {
  const F = CFG.F;

  const fog = humidity >= F.FOG_H
    ? { score:100, r:'High', d:`${humidity}% HR — probable niebla densa` }
    : humidity >= F.FOG_M
    ? { score:50,  r:'Med',  d:`${humidity}% HR — niebla intermitente posible` }
    : { score:0,   r:'Low',  d:`${humidity}% HR — humedad insuficiente` };

  let es, er, ed;
  if (elevation >= F.ELV_HI_MIN && elevation <= F.ELV_HI_MAX)
    { es=100; er='High'; ed=`${elevation} m — banda óptima de estratos`; }
  else if ((elevation >= F.ELV_ME_MIN && elevation < F.ELV_HI_MIN) ||
           (elevation > F.ELV_HI_MAX && elevation < 1600))
    { es=50; er='Med'; ed=`${elevation} m — elevación marginal`; }
  else
    { es=0; er='Low'; ed=elevation < F.ELV_ME_MIN?`${elevation} m — muy baja`:`${elevation} m — muy alta`; }

  const wc = toDirCard(windDir);
  let ws, wr, wd;
  if (windSpeed >= F.WIN_HI_MIN && windSpeed <= F.WIN_HI_MAX)
    { ws=100; wr='High'; wd=`${windSpeed.toFixed(1)} m/s de ${wc} — ideal`; }
  else if ((windSpeed >= F.WIN_ME_MIN && windSpeed < F.WIN_HI_MIN) ||
           (windSpeed > F.WIN_HI_MAX && windSpeed <= F.WIN_ME_MAX))
    { ws=50; wr='Med'; wd=`${windSpeed.toFixed(1)} m/s de ${wc} — marginal`; }
  else
    { ws=0; wr='Low'; wd=`${windSpeed.toFixed(1)} m/s de ${wc} — fuera de rango`; }

  let cs, cr, cd;
  if (coastDist <= F.CST_HI)
    { cs=100; cr='High'; cd=`≈${coastDist.toFixed(1)} km — excelente proximidad`; }
  else if (coastDist <= F.CST_ME)
    { cs=50; cr='Med'; cd=`≈${coastDist.toFixed(1)} km — influencia moderada`; }
  else
    { cs=0; cr='Low'; cd=`≈${coastDist.toFixed(1)} km — demasiado interior`; }

  const factors = [
    { name:'Presencia de Niebla', score:fog.score, r:fog.r, d:fog.d },
    { name:'Elevación',           score:es,        r:er,    d:ed    },
    { name:'Velocidad del Viento',score:ws,        r:wr,    d:wd    },
    { name:'Proximidad Costera',  score:cs,        r:cr,    d:cd    },
  ];

  const minS    = Math.min(...factors.map(f=>f.score));
  const avgS    = Math.round(factors.reduce((s,f)=>s+f.score,0)/factors.length);
  const overall = Math.round(.4*minS + .6*avgS);
  const limiting = factors.find(f=>f.score===minS);
  const label   = overall>=75?'Excelente':overall>=50?'Prometedor':overall>=25?'Marginal':'Desfavorable';

  return { factors, overall, label, limiting };
}


/* ══════════════════════════════════════════════════════
   10. WATER YIELD — quantitative LWC model
   ──────────────────────────────────────────────────────
   MODEL ASSUMPTIONS & DERIVATION
   ────────────────────────────────────────────────────
   Fog collection works by intercepting airborne liquid water
   droplets on a mesh.  The key variables are:

   1. Liquid Water Content (LWC) of fog (g/m³)
      Direct measurement is not available from Open-Meteo.
      We estimate it from Relative Humidity (RH) using a
      two-phase empirical relationship based on Klemm et al.
      (2012) and Olivier (2002):

        RH < LWC_RH_MIN  → LWC = 0  (no fog)
        LWC_RH_MIN–MED   → LWC scales linearly  0 → 0.2 g/m³
        LWC_RH_MED–HI    → LWC scales           0.2 → 0.5 g/m³
        RH > LWC_RH_HI   → LWC = 0.5 + (RH-95)*0.1 (denser fog)
        Capped at LWC_CAP = 3.0 g/m³

      This gives LWC ≈ 0.05–0.5 g/m³ for typical coastal fog,
      up to 1–3 g/m³ for dense stratus/fog events — consistent
      with literature (Gultepe et al. 2007).

   2. Wind speed effect on collection (DeWalle, 1988):
        Collection rate ∝ wind_speed (m/s)
      Higher wind drives more droplets through the mesh.

   3. Collector efficiency:
        η = 20% (standard 35% shade-ratio Raschel mesh)
      Real collectors: 10–25% depending on mesh design.

   4. Fog hours per day:
        H = 8 h/day (conservative coastal estimate)
      Can be 2–16 h depending on season and site.

   FORMULA:
        yield (L/m²/day) = LWC × wind_speed × η × H × 3600 / 1000
                         × elevation_factor
        where:
          × 3600  converts m/s × h to m (since 1 m/s × 1 h = 3600 m)
          ÷ 1000  converts g to liters (water: 1 g ≈ 1 ml = 0.001 L)
          × elevation_factor penalises sites outside the optimal band

   EXPECTED RANGE:
     Typical coastal fog collectors: 1–10 L/m²/day
     Maximum (dense fog, moderate wind): ~15 L/m²/day
══════════════════════════════════════════════════════ */

function estimateLWC(humidity) {
  /*
   * Two-phase LWC estimate from RH alone.
   * Phase 1: near-saturation (RH 80–90%) — intermittent fog patches
   * Phase 2: dense fog (RH 90–95%) — continuous stratus
   * Phase 3: very dense (RH > 95%) — heavy coastal fog event
   */
  const Y = CFG.Y;
  if (humidity < Y.LWC_RH_MIN) return 0;

  let lwc;
  if (humidity >= Y.LWC_RH_HI) {
    /* Dense fog: steep increase above 95% RH */
    lwc = 0.5 + (humidity - Y.LWC_RH_HI) * 0.10;
  } else if (humidity >= Y.LWC_RH_MED) {
    /* Medium fog: 90–95% → 0.2 to 0.5 g/m³ */
    lwc = 0.2 + ((humidity - Y.LWC_RH_MED) / (Y.LWC_RH_HI - Y.LWC_RH_MED)) * 0.30;
  } else {
    /* Low-density fog / high humidity: 80–90% → 0 to 0.2 g/m³ */
    lwc = ((humidity - Y.LWC_RH_MIN) / (Y.LWC_RH_MED - Y.LWC_RH_MIN)) * 0.20;
  }

  return Math.min(lwc, Y.LWC_CAP);
}

function estimateYield(humidity, windSpeed, elevation) {
  const Y = CFG.Y;

  const lwc = estimateLWC(humidity);

  /* Elevation factor — only optimal band gets full yield */
  let elvFactor = 1.0;
  if (elevation < Y.ELV_OPTIMAL_MIN) {
    /* Too low: fog doesn't form or is ground-level only */
    elvFactor = Math.max(0.15, elevation / Y.ELV_OPTIMAL_MIN * 0.85);
  } else if (elevation > Y.ELV_PEN_ABOVE) {
    /* Too high: above typical stratus belt */
    elvFactor = Math.max(0.20, 1 - (elevation - Y.ELV_PEN_ABOVE) / 1200);
  }

  /* Wind factor: linear above 0.5 m/s (no collection in dead calm) */
  const windFactor = Math.max(0, windSpeed - 0.5);

  /* Core formula (see derivation above) */
  const daily = lwc * windFactor * Y.EFFICIENCY * Y.FOG_HOURS * 3600 / 1000 * elvFactor;

  return {
    daily:       Math.max(0, parseFloat(daily.toFixed(3))),
    lwc:         parseFloat(lwc.toFixed(3)),
    windFactor:  parseFloat(windFactor.toFixed(2)),
    elvFactor:   parseFloat(elvFactor.toFixed(2)),
    fogHours:    Y.FOG_HOURS,
    efficiency:  Y.EFFICIENCY,
    note:        lwc < 0.01
      ? 'HR insuficiente para niebla líquida (LWC ≈ 0)'
      : lwc < 0.2
      ? 'Niebla ligera — rendimiento bajo'
      : lwc < 0.5
      ? 'Niebla moderada — rendimiento razonable'
      : 'Niebla densa — buen potencial de captación',
  };
}


/* ══════════════════════════════════════════════════════
   MAP CLICK HANDLER
══════════════════════════════════════════════════════ */

async function onMapClick(lat, lng) {
  document.getElementById('click-hint').classList.add('hidden');
  placeMarker(lat, lng);

  const elevation = getElev(lat, lng);
  S.selectedPoint = { lat, lon: lng, elevation };

  document.getElementById('p-empty').classList.add('hidden');
  document.getElementById('p-results').classList.add('hidden');
  document.getElementById('p-loading').classList.remove('hidden');

  try {
    const [weather] = await Promise.all([fetchWeatherPoint(lat, lng)]);
    const coastDist = estimateCoastDist(lat, lng);

    S.weather     = weather;
    S.coastDist   = coastDist;
    S.feasibility = computeFeasibility({ humidity:weather.humidity, elevation,
      windSpeed:weather.windSpeed, windDir:weather.windDir, coastDist });
    S.waterYield  = estimateYield(weather.humidity, weather.windSpeed, elevation);

    renderPanel({ lat, lng, elevation, coastDist, weather,
      feasibility:S.feasibility, waterYield:S.waterYield });

    loadMonthlyChart(lat, lng);

  } catch (err) {
    console.error(err);
    renderError(err.message);
  } finally {
    document.getElementById('p-loading').classList.add('hidden');
  }
}


/* ══════════════════════════════════════════════════════
   11. MONTHLY CHART
══════════════════════════════════════════════════════ */

async function loadMonthlyChart(lat, lng) {
  document.getElementById('chartBadge').classList.remove('hidden');
  const results = [];
  for (let m = 1; m <= 12; m++) {
    try {
      const d = await fetchPointData(lat, lng, 'wind_speed_10m', 'wind_direction_10m', String(m));
      results.push(estimateYield(d.humidity, d.speed, S.selectedPoint?.elevation ?? 300).daily);
    } catch { results.push(0); }
  }
  document.getElementById('chartBadge').classList.add('hidden');
  renderMonthChart(results);
}

function renderMonthChart(data) {
  const canvas = document.getElementById('monthChart');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0,0,0,130);
  grad.addColorStop(0,   'rgba(0,200,255,0.75)');
  grad.addColorStop(0.6, 'rgba(0,255,170,0.35)');
  grad.addColorStop(1,   'rgba(0,255,170,0.05)');

  if (S.monthChart) {
    S.monthChart.data.datasets[0].data = data.map(v=>v??0);
    S.monthChart.update(); return;
  }
  S.monthChart = new Chart(canvas, {
    type: 'bar',
    data: { labels:['E','F','M','A','M','J','J','A','S','O','N','D'],
      datasets:[{ data:data.map(v=>v??0), backgroundColor:grad,
        borderColor:'rgba(0,200,255,0.7)', borderWidth:1, borderRadius:3 }] },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false},
        tooltip:{ backgroundColor:'rgba(8,10,14,.95)', titleColor:'#00c8ff',
          bodyColor:'#dde2ee', borderColor:'rgba(255,255,255,.08)', borderWidth:1,
          callbacks:{ label:c=>` ${c.parsed.y.toFixed(2)} L/m²/día` } } },
      scales:{
        x:{ ticks:{color:'#4a5570',font:{family:'DM Mono',size:9}}, grid:{color:'rgba(255,255,255,.04)'} },
        y:{ beginAtZero:true, ticks:{color:'#4a5570',font:{family:'DM Mono',size:9},callback:v=>v.toFixed(1)},
            grid:{color:'rgba(255,255,255,.04)'} },
      },
    },
  });
}


/* ══════════════════════════════════════════════════════
   12. PANEL RENDER
══════════════════════════════════════════════════════ */

function renderPanel({ lat, lng, elevation, coastDist, weather, feasibility, waterYield }) {

  /* §1 Location */
  document.getElementById('rLat').textContent   = lat.toFixed(5) + '°';
  document.getElementById('rLon').textContent   = lng.toFixed(5) + '°';
  document.getElementById('rElev').textContent  = elevation + ' m';
  document.getElementById('rCoast').textContent = coastDist.toFixed(1) + ' km';

  /* §2 Score */
  animArc(feasibility.overall);
  document.getElementById('scoreNum').textContent = feasibility.overall;
  const lbl = document.getElementById('scoreLabel');
  lbl.textContent = feasibility.label;
  lbl.style.color = scoreColor(feasibility.overall);
  document.getElementById('scoreLim').textContent =
    feasibility.limiting ? `⚠ Límite: ${feasibility.limiting.name}` : '';

  /* §3 Water yield with LWC detail cards */
  document.getElementById('yieldVal').textContent  = waterYield.daily.toFixed(2);
  document.getElementById('yieldNote').textContent = waterYield.note;

  document.getElementById('yieldDetails').innerHTML = [
    { k:'LWC ESTIMADO', v: waterYield.lwc.toFixed(3), u:'g/m³',
      title:'Contenido de agua líquida derivado de la HR' },
    { k:'FACTOR VIENTO', v: waterYield.windFactor.toFixed(2), u:'m/s efectivo',
      title:'Velocidad de arrastre de gotas (v − 0.5)' },
    { k:'HORAS NIEBLA', v: waterYield.fogHours, u:'h/día',
      title:'Estimación promedio de horas de niebla activa' },
    { k:'EFICIENCIA',   v: (waterYield.efficiency*100).toFixed(0), u:'%',
      title:'Eficiencia del colector — malla Raschel estándar' },
  ].map(d => `
    <div class="yd-item" title="${d.title}">
      <div class="yd-k">${d.k}</div>
      <div class="yd-v">${d.v}<span class="yd-u">${d.u}</span></div>
    </div>`).join('');

  /* §4 Factors */
  const fl = document.getElementById('factorList');
  fl.innerHTML = '';
  feasibility.factors.forEach(f => {
    const cls = f.r==='High'?'high':f.r==='Med'?'med':'low';
    const lim = (f===feasibility.limiting&&feasibility.overall<75)?' lim':'';
    fl.insertAdjacentHTML('beforeend', `
      <div class="factor-item${lim}">
        <div class="fi-top">
          <span class="fi-name">${f.name}</span>
          <span class="fi-badge ${cls}">${f.r==='High'?'Alto':f.r==='Med'?'Medio':'Bajo'}</span>
        </div>
        <div class="fi-bar"><div class="fi-bar-fill ${cls}" style="width:0%" data-w="${f.score}%"></div></div>
        <div class="fi-detail">${f.d}</div>
      </div>`);
  });
  requestAnimationFrame(() =>
    document.querySelectorAll('.fi-bar-fill').forEach(b => { b.style.width = b.dataset.w; })
  );

  /* §5 Atmosphere */
  document.getElementById('atmGrid').innerHTML = [
    { k:'HUMEDAD',    v: weather.humidity,              u:'%'   },
    { k:'VIENTO',     v: weather.windSpeed.toFixed(1),  u:'m/s' },
    { k:'DIRECCIÓN',  v: toDirCard(weather.windDir),    u:`${Math.round(weather.windDir)}°` },
    { k:'TEMP',       v: weather.temp.toFixed(1),       u:'°C'  },
    { k:'NUBOSIDAD',  v: weather.cloud,                 u:'%'   },
    { k:'PRECIPIT.',  v: (weather.precip||0).toFixed(1),u:'mm'  },
  ].map(i=>`<div class="atm-item">
    <div class="atm-k">${i.k}</div>
    <div class="atm-v">${i.v}<span class="atm-u">${i.u}</span></div>
  </div>`).join('');

  document.getElementById('p-results').classList.remove('hidden');
}

function renderError(msg) {
  const r = document.getElementById('p-results');
  r.classList.remove('hidden');
  r.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger);font-size:11px;line-height:1.7">
    <p style="font-size:13px;margin-bottom:8px">⚠ Error de Análisis</p>
    <p>${msg}</p>
    <p style="margin-top:10px;color:var(--mute)">Revisa tu conexión y las claves de API.</p>
  </div>`;
}

function animArc(score) {
  const arc = document.getElementById('scoreArc');
  const circ = 289;
  arc.style.transition = 'none';
  arc.style.strokeDashoffset = circ;
  requestAnimationFrame(() => {
    arc.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)';
    arc.style.strokeDashoffset = circ - (score/100)*circ;
    const [c1,c2] = score>=75?['#00c8ff','#00ffaa']:score>=50?['#0066ff','#00c8ff']:
                    score>=25?['#ff9900','#ffcc00']:['#ff2244','#ff5566'];
    document.getElementById('sg0').setAttribute('stop-color',c1);
    document.getElementById('sg1').setAttribute('stop-color',c2);
  });
}
function scoreColor(s) { return s>=75?'#00ffaa':s>=50?'#00c8ff':s>=25?'#ffb830':'#ff4466'; }


/* ══════════════════════════════════════════════════════
   13. EXPORT — CSV / JSON / Screenshot
══════════════════════════════════════════════════════ */

document.getElementById('expCSV').addEventListener('click', () => {
  const d = exportData(); if(!d) return;
  dl([Object.keys(d).join(','), Object.values(d).map(v=>`"${v}"`).join(',')].join('\n'),
     'text/csv', 'fogharvest.csv');
});
document.getElementById('expJSON').addEventListener('click', () => {
  const d = exportData(); if(!d) return;
  dl(JSON.stringify(d,null,2), 'application/json', 'fogharvest.json');
});
document.getElementById('expIMG').addEventListener('click', async () => {
  try {
    const c = await html2canvas(document.getElementById('map-wrap'),
      {useCORS:true, scale:1, logging:false});
    c.toBlob(b => {
      const u=URL.createObjectURL(b), a=document.createElement('a');
      a.href=u; a.download='fogharvest-map.png'; a.click();
      URL.revokeObjectURL(u);
    });
  } catch { alert('Captura no disponible por tiles de origen cruzado. Usa la captura del S.O.'); }
});

function exportData() {
  if (!S.selectedPoint||!S.weather||!S.feasibility) {
    alert('Selecciona un punto en el mapa primero.'); return null;
  }
  const p=S.selectedPoint, w=S.weather, f=S.feasibility, y=S.waterYield;
  return {
    latitud:p.lat, longitud:p.lon, elevacion_m:p.elevation,
    distancia_costa_km:S.coastDist??0, mes:S.selectedMonth,
    humedad_pct:w.humidity, viento_ms:w.windSpeed, dir_viento_deg:w.windDir,
    temperatura_c:w.temp, nubosidad_pct:w.cloud, precipitacion_mm:w.precip,
    lwc_g_m3:y?.lwc??0, rendimiento_l_m2_dia:y?.daily??0,
    eficiencia_colector:y?.efficiency??0, horas_niebla_dia:y?.fogHours??0,
    factibilidad_pct:f.overall, factibilidad_label:f.label,
    factor_niebla:f.factors[0].r, factor_elevacion:f.factors[1].r,
    factor_viento:f.factors[2].r, factor_costa:f.factors[3].r,
    factor_limitante:f.limiting?.name??'ninguno',
    timestamp:new Date().toISOString(),
  };
}
function dl(content, mime, name) {
  const u=URL.createObjectURL(new Blob([content],{type:mime}));
  const a=document.createElement('a'); a.href=u; a.download=name; a.click();
  URL.revokeObjectURL(u);
}


/* ══════════════════════════════════════════════════════
   14. UTILITIES
══════════════════════════════════════════════════════ */

function placeMarker(lat, lng) {
  const el = document.createElement('div');
  el.innerHTML = `<svg width="30" height="30" viewBox="0 0 30 30" fill="none">
    <circle cx="15" cy="15" r="13" stroke="#00c8ff" stroke-width="1.3" stroke-dasharray="3 3"/>
    <circle cx="15" cy="15" r="3.5" fill="#00c8ff"/>
    <line x1="15" y1="1" x2="15" y2="7" stroke="#00c8ff" stroke-width="1.3"/>
    <line x1="15" y1="23" x2="15" y2="29" stroke="#00c8ff" stroke-width="1.3"/>
    <line x1="1" y1="15" x2="7" y2="15" stroke="#00c8ff" stroke-width="1.3"/>
    <line x1="23" y1="15" x2="29" y2="15" stroke="#00c8ff" stroke-width="1.3"/>
  </svg>`;
  el.style.cssText = 'width:30px;height:30px;cursor:pointer;';
  if (S.marker) S.marker.remove();
  S.marker = new mapboxgl.Marker({ element:el, anchor:'center' })
    .setLngLat([lng,lat]).addTo(S.map);
}

function getElev(lat, lng) {
  try {
    const e = S.map.queryTerrainElevation([lng,lat], {exaggerated:false});
    return e != null ? Math.round(e) : 0;
  } catch { return 0; }
}

function estimateCoastDist(lat, lng) {
  if (!S.map.isStyleLoaded()) return 999;
  const N=16, MAX=CFG.COAST_RADIUS_KM, STEP=0.4;
  let min = MAX;
  for (let b=0; b<N; b++) {
    const bearing = (b/N)*360;
    for (let km=STEP; km<=MAX; km+=STEP) {
      const pt = turf.destination([lng,lat], km, bearing, {units:'kilometers'});
      try {
        const e = S.map.queryTerrainElevation(
          [pt.geometry.coordinates[0], pt.geometry.coordinates[1]], {exaggerated:false});
        if (e!==null && e<=10) { if(km<min) min=km; break; }
      } catch { break; }
    }
  }
  return min;
}

/* IDW interpolation for wind U/V vectors (angle-aware) */
function idwVec(lat, lon, pts, pow=2) {
  let su=0,sv=0,ss=0,sw=0;
  for (const p of pts) {
    const d = Math.hypot(lat-p.lat, lon-p.lon) || 1e-9;
    const w = 1/Math.pow(d,pow);
    const r = (p.dir*Math.PI)/180;
    su += w*Math.sin(r); sv += w*Math.cos(r); ss += w*p.speed; sw += w;
  }
  const dir = ((Math.atan2(su/sw, sv/sw)*180)/Math.PI+360)%360;
  return { speed:ss/sw, dir };
}

/* IDW interpolation for scalar field (humidity) */
function idwScalar(lat, lon, pts, key, pow=2) {
  let sv=0,sw=0;
  for (const p of pts) {
    if (p[key]==null) continue;
    const d = Math.hypot(lat-p.lat, lon-p.lon) || 1e-9;
    const w = 1/Math.pow(d,pow);
    sv += w*p[key]; sw += w;
  }
  return sw ? sv/sw : 0;
}

/* Run async task array with concurrency limit (avoids rate-limiting) */
async function fetchConcurrent(tasks, limit=5) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() { while(idx<tasks.length){const i=idx++;results[i]=await tasks[i]();} }
  await Promise.all(Array.from({length:Math.min(limit,tasks.length)}, worker));
  return results;
}

function windParams(alt) {
  if (alt==='10m') return { speedParam:'wind_speed_10m',  dirParam:'wind_direction_10m'  };
  if (alt==='80m') return { speedParam:'wind_speed_80m',  dirParam:'wind_direction_80m'  };
  return             { speedParam:'wind_speed_120m', dirParam:'wind_direction_120m' };
}

function toDirCard(d) {
  return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d/22.5)%16];
}

/* Linear interpolation */
function lerp(a,b,t) { return a+(b-a)*t; }

/* Debounce helper */
function debounce(fn,ms) { let t; return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);}; }

/* Linearly interpolate two CSS hex colors */
function lerpHex(c1,c2,t) {
  t = Math.max(0,Math.min(1,t));
  const p = c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];
  const a=p(c1), b=p(c2);
  return '#'+[0,1,2].map(i=>Math.round(a[i]+(b[i]-a[i])*t).toString(16).padStart(2,'0')).join('');
}

/* Convert hex color to {r,g,b} */
function hexToRgb(h) {
  return { r:parseInt(h.slice(1,3),16), g:parseInt(h.slice(3,5),16), b:parseInt(h.slice(5,7),16) };
}

function daysInMonth(y,m) { return new Date(y,m,0).getDate(); }
function pad(n)           { return String(n).padStart(2,'0'); }

/* Update the status indicator pill */
function setStatus(state, alt, month) {
  const dot = document.getElementById('stDot');
  const txt = document.getElementById('stText');
  dot.className = 'st-dot';
  if (state==='active') {
    dot.classList.add('on');
    const mLabel = month==='current'?'AHORA':
      ['','ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'][parseInt(month)||0];
    txt.textContent = `VIENTO ACTIVO · ${alt.toUpperCase()} · ${mLabel}`;
  } else if (state==='error') {
    dot.classList.add('err'); txt.textContent = 'ERROR AL CARGAR VIENTO';
  } else {
    txt.textContent = 'CARGANDO DATOS DE VIENTO…';
  }
}

/* Reveal app after map has loaded */
function showApp() {
  setTimeout(() => {
    document.getElementById('loader').classList.add('out');
    setTimeout(() => {
      document.getElementById('loader').style.display = 'none';
      document.getElementById('app').classList.remove('hidden');
      setTimeout(() => S.map && S.map.resize(), 80);
    }, 550);
  }, 2200);
}


/* ══════════════════════════════════════════════════════
   15. BOOT — event wiring + entry point
══════════════════════════════════════════════════════ */

/* ── Layer toggle buttons ── */
document.getElementById('btnWind').addEventListener('click', function() {
  S.layerWind = !S.layerWind;
  this.classList.toggle('active', S.layerWind);
  if (S.layerWind) startWindParticles();
  else { cancelAnimationFrame(S.windRAF); S.windCtx.clearRect(0,0,S.windCanvas.width,S.windCanvas.height); }
});

document.getElementById('btnHum').addEventListener('click', function() {
  S.layerHum = !S.layerHum;
  this.classList.toggle('active', S.layerHum);
  if (S.layerHum) drawHumidityCanvas();
  else S.humCtx.clearRect(0,0,S.humCanvas.width,S.humCanvas.height);
});

/* ── Refresh / selectors ── */
document.getElementById('btnRefresh').addEventListener('click', fetchWindField);
document.getElementById('selAlt').addEventListener('change', fetchWindField);
document.getElementById('selMonth').addEventListener('change', e => {
  S.selectedMonth = e.target.value;
  fetchWindField();
  if (S.selectedPoint) onMapClick(S.selectedPoint.lat, S.selectedPoint.lon);
});

/* ── Panel collapse ── */
document.getElementById('btnPanel').addEventListener('click', () => {
  S.panelOpen = !S.panelOpen;
  document.getElementById('panel').classList.toggle('collapsed', !S.panelOpen);
  setTimeout(() => S.map && S.map.resize(), 320);
});

/* ── Entry point ── */
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSearch();
});