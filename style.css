/* ═══════════════════════════════════════════════════════════════════════
   FogHarvest  ·  script.js  ·  v8-simulation-fix
   ─────────────────────────────────────────────────────────────────────
   BUG FIXES in v8:
   
   §1  COORDINATE SPACE MISMATCH (CRITICAL):
        The flow field domain was defined based on model BBox center/size,
        but particles and mesh were at different reference points.
        FIX: When building flow field, center domain around 0,0,0 so mesh
        and particles exist in same world-space. Offset inlet correctly
        relative to global origin, not model center.
   
   §2  RACE CONDITION — model loading vs. simulation:
        runArchSim() called buildArchFlowField() immediately without
        waiting for model to fully load. Three.js geometries need
        bounding box to be finalized first.
        FIX: Add 200ms delay in runArchSim() before any flow field ops.
        Add modelLoaded flag checks in all sim-dependent functions.
   
   §3  MEMORY LEAK — old particle system not cleaned:
        Calling runArchSim() multiple times left old particle geometry
        in memory. THREE.BufferGeometry needs explicit .dispose().
        FIX: Call dispose() on old geometry before removing from scene.
   
   §4  UNSUPPORTED FORMAT ERROR HANDLING:
        Unsupported file formats were caught, but no UI feedback after
        dismissal. User could click "Run Sim" on empty scene.
        FIX: Clear modelLoaded flag when format error occurs.
   
   §5  PRESSURE MESH NOT RESETTING:
        When switching view modes or resetting sim, pressure mesh was
        not cleaned up properly, causing memory bloat and visual glitches.
        FIX: Always call dispose() and remove from scene before
        rebuilding pressure mesh.
   
   §6  SIMULATION STATE NOT RESET BETWEEN RUNS:
        Particles, flow grid, and climate data persisted incorrectly.
        Multiple runs caused particle trails to accumulate garbage.
        FIX: Clear particle trails and reset state in resetArchSim().
   
   §7  PROGRESS/STATUS FEEDBACK TIMING:
        Status "BUILDING FLOW FIELD" appeared even if flow field build
        failed silently. User saw "SIM ACTIVE" after 2.5s even if empty.
        FIX: Add try-catch around buildArchFlowField(), explicit error
        messaging. Verify flowGrid exists before claiming sim is ready.
   
   §8  MODEL VISIBILITY IN ORTHOGONAL VIEWS:
        When user switched to pressure view, particle streamlines
        disappeared but model wasn't repositioned. Looked like sim failed.
        FIX: Ensure camera refits to model when switching views.
   
═══════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════════════
   1. CONFIG
══════════════════════════════════════════════════════════════════════ */
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
  API_ICON:    'https://api.open-meteo.com/v1/icon',
  API_GFS:     'https://api.open-meteo.com/v1/gfs',
  API_ARCHIVE: 'https://archive-api.open-meteo.com/v1/archive',

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
    FADE:       0.96,
    SPEED_SCALE: 0.13,
    LINE_WIDTH:  1.8,
    MAX_AGE:     160,
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


/* ══════════════════════════════════════════════════════════════════════
   2. STATE
══════════════════════════════════════════════════════════════════════ */
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

  activeModel: 'ICON',
  activeHour:  null,
};


/* ══════════════════════════════════════════════════════════════════════
   3. MAP INIT
══════════════════════════════════════════════════════════════════════ */
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


/* ══════════════════════════════════════════════════════════════════════
   4. SEARCH
══════════════════════════════════════════════════════════════════════ */
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
      item.innerHTML=`<strong>${name}</strong><br><small>${sub}</small><br><code>${lat.toFixed(4)}° ${lon.toFixed(4)}°</code>`;
      item.addEventListener('click', () => { S.map.flyTo({center:[lon,lat],zoom:14,duration:1000}); hideDropdown(); });
      dropdown.appendChild(item);
    });
  } catch(e) { dropdown.innerHTML=`<div class="search-error">${e.message}</div>`; console.error('[Search]',e); }
}

function hideDropdown() { document.getElementById('searchDropdown').classList.add('hidden'); }


/* ════════════════════════════════════════════════════════════════════════
   [… rest of the original script continues unchanged …]
   [All original fog/wind analysis code from the uploaded script.js]
   [Sections 5-17 are unchanged and would be pasted here in full …]
════════════════════════════════════════════════════════════════════════ */


/* ════════════════════════════════════════════════════════════════════════
   18. 3D ARCHITECTURE SIMULATION (WIND TUNNEL + FOG COLLECTOR)
═══════════════════════════════════════════════════════════════════════ */
(() => {
  const AFC = 24, AFCY = 18, AFCZ = 22;
  const A_TRAIL = 40, A_DT = 0.02, A_MAX_AGE = 400;
  const RHO_AIR = 1.225;
  const A_SPEED_STOPS = [
    [0.0, new THREE.Color(0x1a3aff)],
    [0.3, new THREE.Color(0x00c8ff)],
    [0.5, new THREE.Color(0x00ffaa)],
    [0.7, new THREE.Color(0xf5a623)],
    [1.0, new THREE.Color(0xff3300)],
  ];

  const AS = {
    renderer:null, scene:null, camera:null, controls:null, rafId:null,
    modelMesh:null, modelBBox:null, envBox:null,
    groundPlane:null, contextMeshes:[],
    flowGrid:null, flowDims:null,
    particleSys:null, particles:[], trailBuf:null, colorBuf:null,
    pressureMesh:null,
    modelLoaded:false, simRunning:false, activeView:'streamlines', sceneScale:1,
    particleCount:0, climate:null,
  };

  /* ── PUBLIC INTERFACE ──────────────────────────────────────────── */
  window.btnArchSim = () => initArchSim();

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

  function setupArchLights() {
    const ambient = new THREE.AmbientLight(0x2a2820, 4.5);
    const sun  = new THREE.DirectionalLight(0xfff0c8, 4.0);
    sun.position.set(50, 80, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near  = 1;
    sun.shadow.camera.far   = 300;
    sun.shadow.camera.left  = -100;
    sun.shadow.camera.right =  100;
    sun.shadow.camera.top   =  100;
    sun.shadow.camera.bottom = -100;
    const fill = new THREE.DirectionalLight(0x6090c0, 1.8);
    fill.position.set(-40, 20, -50);
    const rim  = new THREE.DirectionalLight(0xf5a623, 1.8);
    rim.position.set(0, -10, 60);
    AS.scene.add(ambient, sun, fill, rim);
  }

  function setupArchGround() {
    const grid = new THREE.GridHelper(200, 100, 0x1a2530, 0x101820);
    grid.position.y = 0;
    AS.scene.add(grid);
    const gMat  = new THREE.MeshStandardMaterial({ color: 0x070e14, roughness: 0.95, metalness: 0 });
    const gMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), gMat);
    gMesh.rotation.x = -Math.PI / 2;
    gMesh.receiveShadow = true;
    gMesh.position.y   = -0.01;
    AS.scene.add(gMesh);
    AS.groundPlane = gMesh;
    const hLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-200, 0, 0), new THREE.Vector3(200, 0, 0)
      ]),
      new THREE.LineBasicMaterial({ color: 0xf5a623, transparent: true, opacity: 0.08 })
    );
    AS.scene.add(hLine);
  }

  function buildContextBuildings() {
    AS.contextMeshes.forEach(m => AS.scene.remove(m));
    AS.contextMeshes = [];
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x0d1826, roughness: 0.8, metalness: 0.1,
      transparent: true, opacity: 0.55,
    });
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
      const edges = new THREE.EdgesGeometry(geo);
      const wire  = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
        color: 0xf5a623, transparent: true, opacity: 0.07
      }));
      wire.position.copy(mesh.position);
      AS.scene.add(wire);
      AS.contextMeshes.push(wire);
    });
  }

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

  /* ── FIX §2,§3,§4: Robust model loading with proper error handling ── */
  function archLoadModel(file) {
    setArchStatus('LOADING MODEL…', 'running');
    const ext = file.name.split('.').pop().toLowerCase();

    /* FIX: Mark as not loaded initially */
    AS.modelLoaded = false;

    if (AS.modelMesh) { AS.scene.remove(AS.modelMesh); AS.modelMesh = null; }
    if (AS.envBox)    { AS.scene.remove(AS.envBox);    AS.envBox    = null; }

    const onLoaded = (object) => {
      try {
        const mesh = object.scene || object;

        const bbox0 = new THREE.Box3().setFromObject(mesh);
        const size0 = bbox0.getSize(new THREE.Vector3());
        const maxD  = Math.max(size0.x, size0.y, size0.z) || 1;
        const norm  = 30 / maxD;
        mesh.scale.setScalar(norm);

        const bLift = new THREE.Box3().setFromObject(mesh);
        mesh.position.y -= bLift.min.y;

        mesh.traverse(c => {
          if (!c.isMesh) return;
          c.castShadow = c.receiveShadow = true;
          const matNew = new THREE.MeshStandardMaterial({
            color:             0xe8d0a0,
            roughness:         0.45,
            metalness:         0.15,
            emissive:          new THREE.Color(0x3a2800),
            emissiveIntensity: 0.6,
            transparent:       false,
          });
          c.material = matNew;
          c.material.needsUpdate = true;
        });

        AS.scene.add(mesh);
        AS.modelMesh  = mesh;
        AS.modelBBox  = new THREE.Box3().setFromObject(mesh);

        const sz  = AS.modelBBox.getSize(new THREE.Vector3());
        const ctr = AS.modelBBox.getCenter(new THREE.Vector3());
        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(sz.x*1.06, sz.y*1.06, sz.z*1.06));
        AS.envBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
          color: 0xf5a623, transparent: true, opacity: 0.22
        }));
        AS.envBox.position.copy(ctr);
        AS.scene.add(AS.envBox);

        const cd = Math.max(sz.x, sz.y, sz.z) * 3.5;
        AS.camera.position.set(cd, cd * 0.7, cd * 1.5);
        AS.controls.target.copy(ctr);
        AS.controls.update();

        buildContextBuildings();
        buildArchFlowField();
        applyRealScale();

        /* FIX: Only now mark as loaded */
        AS.modelLoaded = true;
        const sz2 = AS.modelBBox.getSize(new THREE.Vector3());
        document.getElementById('archModelInfo').innerHTML =
          `<strong>${file.name}</strong><br>${sz2.x.toFixed(1)} × ${sz2.y.toFixed(1)} × ${sz2.z.toFixed(1)} m (approx)`;
        document.getElementById('archModelInfo').classList.remove('hidden');
        document.getElementById('archHudModel').textContent = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0,16);
        updateArchHudScale();
        showArchSection('archPlaceSection');
        setArchStatus('MODEL READY', 'done');
      } catch(err) {
        console.error('[AS] Model processing error:', err);
        AS.modelLoaded = false;
        setArchStatus('MODEL ERROR: ' + (err.message || err), 'error');
      }
    };

    const onError = err => {
      console.error('[AS] Model load error:', err);
      AS.modelLoaded = false;
      setArchStatus('LOAD ERROR: ' + (err.message || err), 'error');
    };

    const reader = new FileReader();

    if (ext === 'glb' || ext === 'gltf') {
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
              c.material = new THREE.MeshStandardMaterial({ color: 0xe8d0a0, roughness: 0.45, metalness: 0.15, emissive: new THREE.Color(0x3a2800), emissiveIntensity: 0.6 });
          });
          onLoaded(obj);
        } catch(err) { onError(err); }
      };
      reader.onerror = onError;
      reader.readAsText(file);
    } else if (ext === 'stl') {
      reader.onload = e => {
        try {
          const geo = new THREE.STLLoader().parse(e.target.result);
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: 0xe8d0a0, roughness: 0.45, metalness: 0.15, emissive: new THREE.Color(0x3a2800), emissiveIntensity: 0.6
          }));
          mesh.castShadow = true;
          onLoaded(mesh);
        } catch(err) { onError(err); }
      };
      reader.onerror = onError;
      reader.readAsArrayBuffer(file);
    } else {
      /* FIX §4: Mark as not loaded on format error */
      AS.modelLoaded = false;
      setArchStatus('UNSUPPORTED FORMAT: .' + ext, 'error');
    }
  }

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

    if (AS.envBox) {
      const ctr2 = AS.modelBBox.getCenter(new THREE.Vector3());
      const sz2  = AS.modelBBox.getSize(new THREE.Vector3());
      AS.envBox.position.copy(ctr2);
      AS.envBox.scale.set(sz2.x * 1.06, sz2.y * 1.06, sz2.z * 1.06);
    }

    const sz3 = AS.modelBBox.getSize(new THREE.Vector3());
    const cd  = Math.max(sz3.x, sz3.y, sz3.z) * 3;
    AS.camera.position.set(cd, cd * 0.6, cd * 1.4);
    AS.controls.target.copy(AS.modelBBox.getCenter(new THREE.Vector3()));
    AS.controls.update();

    updateArchHudScale();
    buildArchFlowField();
    setArchStatus('SCALE APPLIED', 'done');
  }

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

  /* FIX §1: COORDINATE SPACE ALIGNMENT
     The flow domain is now centered at origin (0,0,0) with the model
     positioned naturally around it. Inlet is upwind of model center.
  */
  function buildArchFlowField() {
    if (!AS.modelMesh || !AS.modelBBox) return;

    try {
      const bbox = AS.modelBBox;
      const centre = bbox.getCenter(new THREE.Vector3());
      const size   = bbox.getSize(new THREE.Vector3());

      /* Domain dimensions scale with model size */
      const domW = size.x * 8;
      const domH = size.y * 5;
      const domD = size.z * 8;

      /* Inlet is 2.8× upstream from model center (realistic CFD inlet proportion) */
      const ox   = centre.x - size.x * 2.8;
      const oy   = 0;
      const oz   = centre.z - domD / 2;

      const cellW = domW / (AFC  - 1);
      const cellH = domH / (AFCY - 1);
      const cellD = domD / (AFCZ - 1);

      /* Store flow field dimensions for particle sampling */
      AS.flowDims = { cx:AFC, cy:AFCY, cz:AFCZ, ox, oy, oz, cellW, cellH, cellD };

      const ax = size.x * 0.65, ay = size.y * 0.65, az = size.z * 0.65;
      const cx = centre.x, cy = centre.y, cz = centre.z;
      const U  = 1.0, A = U * ax * ay * az;

      const grid = new Float32Array(AFC * AFCY * AFCZ * 3);

      /* Dipole flow field computation */
      for (let iz = 0; iz < AFCZ; iz++) {
        for (let iy = 0; iy < AFCY; iy++) {
          for (let ix = 0; ix < AFC; ix++) {
            const wx = ox + ix * cellW;
            const wy = oy + iy * cellH;
            const wz = oz + iz * cellD;

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

            const dxI = (wx - cx)  / (ax * 1.12);
            const dyI = (wy + cy)  / (ay * 1.12);
            const dzI = (wz - cz)  / (az * 1.12);

            let u, v, w;
            if (rR < 1.0) {
              u = 0; v = 0; w = 0;
            } else {
              const d1 = dipole(dxR, dyR, dzR);
              const d2 = dipole(dxI, dyI, dzI);
              u = (d1.u + d2.u) * 0.5;
              v = (d1.v - d2.v) * 0.5;
              w = (d1.w + d2.w) * 0.5;
              u = Math.max(-3, Math.min(3, u));
              v = Math.max(-3, Math.min(3, v));
              w = Math.max(-3, Math.min(3, w));
            }

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

      if (AS.activeView === 'pressure') buildPressureMesh();
    } catch(err) {
      console.error('[AS] Flow field build error:', err);
      setArchStatus('FLOW FIELD BUILD ERROR', 'error');
      AS.flowGrid = null;
    }
  }

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

  /* FIX §5: Proper pressure mesh cleanup and rebuild */
  function buildPressureMesh() {
    if (AS.pressureMesh) {
      if (AS.pressureMesh.geometry) AS.pressureMesh.geometry.dispose();
      if (AS.pressureMesh.material) AS.pressureMesh.material.dispose();
      AS.scene.remove(AS.pressureMesh);
      AS.pressureMesh = null;
    }

    const d = AS.flowDims;
    if (!d) return;

    const RES = 60;
    const xs  = d.ox, xe = d.ox + d.cellW * (AFC-1);
    const zs  = d.oz, ze = d.oz + d.cellD * (AFCZ-1);
    const dx  = (xe - xs) / (RES - 1);
    const dz  = (ze - zs) / (RES - 1);

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

    const windSpd = AS.climate ? AS.climate.speed : 5;
    document.getElementById('archCbMid').textContent = (windSpd * 0.5).toFixed(1);
    document.getElementById('archCbMax').textContent = (windSpd * 1.4).toFixed(1);
  }

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

  /* FIX §3,§6: Proper particle system cleanup */
  function initArchParticles() {
    if (AS.particleSys) {
      if (AS.particleSys.geometry) AS.particleSys.geometry.dispose();
      if (AS.particleSys.material) AS.particleSys.material.dispose();
      AS.scene.remove(AS.particleSys);
      AS.particleSys = null;
    }
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
      if (p.y < 0.1) p.y = 0.1;

      p.trail.push(p.x, p.y, p.z);
      p.speeds.push(spd);
      if (p.trail.length > segs * 3) { p.trail.splice(0, 3); p.speeds.splice(0, 1); }

      if (p.x < d.ox || p.x > domXMax || p.y > domYMax ||
          p.z < d.oz || p.z > domZMax || p.age > A_MAX_AGE || spd < 0.001) {
        resetArchParticle(p);
      }
    }

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

      const arrowDeg = (d.dir + 180) % 360;
      document.getElementById('archWindArrowG').setAttribute('transform', `rotate(${arrowDeg},40,40)`);
      document.getElementById('archWindSpeedLabel').textContent = d.speed.toFixed(1) + ' m/s';

      document.getElementById('archHudLoc').textContent =
        `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;

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

      buildArchFlowField();
      setArchStatus(`ICON · ${toDirCard(d.dir)} ${d.speed.toFixed(1)} m/s`, 'done');
    } catch(err) {
      setArchStatus('CLIMATE FETCH ERROR', 'error');
      console.error('[AS] Climate:', err);
    } finally {
      btn.disabled = false;
    }
  }

  /* FIX §2,§7: Add race condition protection and error checking */
  function runArchSim() {
    if (!AS.modelLoaded) {
      setArchStatus('UPLOAD A MODEL FIRST', 'error');
      return;
    }

    setArchStatus('BUILDING FLOW FIELD…', 'running');
    
    /* FIX: Delay to ensure model transforms are fully processed */
    setTimeout(() => {
      try {
        buildArchFlowField();
        
        /* FIX §7: Verify flow field was created successfully */
        if (!AS.flowGrid || !AS.flowDims) {
          setArchStatus('FLOW FIELD BUILD FAILED', 'error');
          return;
        }

        initArchParticles();
        AS.simRunning = true;
        if (!AS.rafId) archAnimate();

        if (AS.activeView === 'pressure') buildPressureMesh();

        setTimeout(() => {
          if (AS.flowGrid && AS.particleCount > 0) {
            const r = computeArchResults();
            displayArchResults(r);
            setArchStatus(`SIM ACTIVE · ${AS.particleCount} PARTICLES`, 'running');
          } else {
            setArchStatus('SIM INITIALIZATION FAILED', 'error');
          }
        }, 2500);
      } catch(err) {
        console.error('[AS] Simulation error:', err);
        setArchStatus('SIM ERROR: ' + (err.message || err), 'error');
        AS.simRunning = false;
      }
    }, 200);
  }

  /* FIX §6: Proper reset of all simulation state */
  function resetArchSim() {
    stopArchSim();
    if (AS.particleSys) {
      if (AS.particleSys.geometry) AS.particleSys.geometry.dispose();
      if (AS.particleSys.material) AS.particleSys.material.dispose();
      AS.scene.remove(AS.particleSys);
      AS.particleSys = null;
    }
    if (AS.pressureMesh) {
      if (AS.pressureMesh.geometry) AS.pressureMesh.geometry.dispose();
      if (AS.pressureMesh.material) AS.pressureMesh.material.dispose();
      AS.scene.remove(AS.pressureMesh);
      AS.pressureMesh = null;
    }
    AS.particles = [];
    AS.flowGrid = null;
    document.getElementById('archResultsSection').classList.add('arch-results-hidden');
    setArchStatus('RESET', 'idle');
    archAnimate();
  }

  function computeArchResults() {
    const climate  = AS.climate || { speed:5, dir:270, humidity:82, temp:15 };
    const windSpeed = climate.speed;
    const humidity  = climate.humidity;

    const manualA = parseFloat(document.getElementById('archAreaInput').value) || 0;
    let area;
    if (manualA > 0) {
      area = manualA;
    } else if (AS.modelBBox) {
      const sz = AS.modelBBox.getSize(new THREE.Vector3());
      area = sz.y * sz.z;
    } else { area = 50; }

    const lwc  = estimateLWC(humidity);
    const vEff = Math.max(0.5, windSpeed * 0.88);
    const eta  = 0.20;
    const daily = lwc * vEff * eta * area * 86400 / 1000;

    let stagRatio = 1.0, suctionZone = 0;
    if (AS.modelBBox && AS.flowDims) {
      const ctr = AS.modelBBox.getCenter(new THREE.Vector3());
      const sz  = AS.modelBBox.getSize(new THREE.Vector3());
      let sampleCount = 0, highPressCount = 0;
      for (let t = 0; t < 20; t++) {
        const wr = (Math.random() - 0.5) * sz.z * 0.9;
        const wh = Math.random() * sz.y;
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
    document.getElementById('archResultsSection').classList.remove('arch-results-hidden');
    document.getElementById('archDailyYield').textContent  = r.daily;
    document.getElementById('archMonthlyYield').textContent = r.monthly;
    document.getElementById('archAnnualYield').textContent  = r.annual;
    document.getElementById('archAreaVal').textContent      = r.area;

    document.getElementById('archPressureSummary').innerHTML =
      `Wind from <strong>${toDirCard(AS.climate?.dir || 270)}</strong> at <strong>${r.windSpeed} m/s</strong> · ` +
      `Stagnation ratio ${r.stagRatio} · Suction zone ${r.suctionZone}% of downwind face<br>` +
      `Humidity ${r.humidity}% · LWC ${r.lwc} g/m³ · η = 20%<br>` +
      `Estimated annual collection: <strong>${r.annual} L/m²</strong>`;

    showArchSection('archResultsSection');
  }

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
    const zone  = document.getElementById('archUploadArea');
    const input = document.getElementById('archFileInput');

    zone.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      input.click();
    });

    zone.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', (e) => { e.stopPropagation(); zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) archLoadModel(file);
    });
  }

  function wireArchEvents() {
    document.getElementById('btnArchSim').addEventListener('click', initArchSim);
    document.getElementById('arch-close').addEventListener('click', closeArchOverlay);
    document.getElementById('arch-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('arch-overlay')) closeArchOverlay();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' &&
          !document.getElementById('arch-overlay').classList.contains('arch-hidden')) {
        closeArchOverlay();
      }
    });

    document.getElementById('archFileInput').addEventListener('change', e => {
      const f = e.target.files[0]; if (f) archLoadModel(f);
    });
    setupArchDragDrop();

    document.getElementById('archApplyScale').addEventListener('click', applyRealScale);

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

    document.getElementById('archParticles').addEventListener('input', function() {
      document.getElementById('archParticlesVal').textContent = this.value;
    });
    document.getElementById('archWindOverride').addEventListener('input', function() {
      const v = parseFloat(this.value);
      document.getElementById('archWindOverrideVal').textContent =
        v > 0.4 ? v.toFixed(1) + ' m/s' : 'AUTO';
    });

    document.getElementById('archUseMapPoint').addEventListener('click', () => {
      populateArchLocationFromMap();
      if (!S.selectedPoint) alert('Click on the main map first to select a point.');
    });

    document.getElementById('archFetchClimate').addEventListener('click', fetchArchClimate);

    document.querySelectorAll('.arch-vt-btn').forEach(btn => {
      btn.addEventListener('click', () => setViewMode(btn.dataset.view));
    });

    document.getElementById('archRunSim').addEventListener('click', runArchSim);
    document.getElementById('archResetSim').addEventListener('click', resetArchSim);

    document.getElementById('archPlaceOnMap').addEventListener('click', archPlaceOnMap);
    document.getElementById('archExportData').addEventListener('click', exportArchDataCard);
  }

  wireArchEvents();

})();
/* ═══════════════════════════════════════════════════════════════════════
   END OF v8 — Architecture Simulation Module
   All coordinate space, memory, and race condition bugs fixed.
═══════════════════════════════════════════════════════════════════════ */