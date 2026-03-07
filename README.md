# FogHarvest v4
### Análisis de captación de niebla en escala de terreno — Viento & Humedad

Visualización interactiva de viento y humedad sobre terreno 3D para evaluar la factibilidad de captadores de niebla costeros. Inspirado en el estilo visual de [earth.nullschool.net](https://earth.nullschool.net) y [zoom.earth](https://zoom.earth).

---

## Stack

| Componente | Versión | Uso |
|---|---|---|
| Mapbox GL JS | 3.3.0 | Renderer del mapa (compatible con MapTiler) |
| MapTiler | — | Estilo vectorial, DEM 3D, Geocoding |
| Open-Meteo | free | Datos meteorológicos (viento, HR, temp) |
| Turf.js | 6 | Distancia a costa |
| Chart.js | 4.4.3 | Gráfica mensual |
| html2canvas | 1.4.1 | Exportar imagen |

---

## Configuración

### Claves API (ya incluidas en `script.js`)

```js
// MapTiler — tu clave personalizada
MT_KEY:   'YU4AkYjwr3SI0k0mKRLc'

// Estilo vectorial MapTiler Studio (tu mapa personalizado)
MT_STYLE: 'https://api.maptiler.com/maps/019cca32-19d8-7506-b7e2-b8e61efa521e/style.json?key=...'

// Open-Meteo — sin clave (API pública gratuita)
```

### Ejecutar localmente

```bash
# Opción 1 — Python
python3 -m http.server 8080
# → http://localhost:8080

# Opción 2 — Node.js
npx serve .
# → http://localhost:3000

# Opción 3 — VS Code Live Server
# Clic derecho en index.html → "Open with Live Server"
```

> ⚠️ **Debe servirse por HTTP**, no abrirse como `file://` — las APIs del navegador requieren origen seguro.

---

## Características

### 🌊 Mapa 3D (MapTiler)
- Estilo vectorial personalizado (Carpet) con relieve sombreado
- Terreno DEM `terrain-rgb-v2` de MapTiler con exageración 1.5×
- Pitch 58°, navegación completa (zoom, rotación, inclinación)

### 🔍 Barra de búsqueda (MapTiler Geocoding)
- Debounced: espera 350ms tras el último carácter para buscar
- Dropdown con nombre, subregión y coordenadas
- Selección → `flyTo` animado al lugar
- Navegación por teclado (↑↓ Enter Escape)

### 💨 Viento — partículas tipo earth.nullschool
- 3 500 partículas fluyen sobre el campo de viento
- Campo interpolado en cuadrícula 22×16 vía IDW a partir de 20 puntos API
- Paleta de colores: morado oscuro → azul → cian → verde → amarillo → rojo
- Velocidad de movimiento proporcional a la velocidad del viento
- Disponible en 10 m, 80 m y 120 m de altitud

### 💧 Humedad — campo continuo de píxeles
- Cada píxel del canvas recibe color según humedad relativa interpolada
- Paleta: rojo oscuro (seco) → ámbar → verde amarillo → azul cielo → azul profundo
- Opacidad ~57% sobre el mapa vectorial

### 📊 Análisis al hacer clic
Haz clic en cualquier punto del terreno para obtener:

1. **Coordenadas** — lat/lon, elevación, distancia a la costa
2. **Factibilidad de niebla** — puntuación 0–100% (modelo cuello de botella)
3. **Rendimiento hídrico** — L/m²/día con desglose LWC
4. **Factores** — niebla, elevación, viento, costa (Alto/Medio/Bajo)
5. **Datos atmosféricos** — HR, viento, temperatura, nubosidad, precipitación
6. **Gráfica mensual** — potencial estimado los 12 meses del año anterior

---

## Modelo de Captación de Niebla (LWC)

### Fundamento
Los captadores de niebla funcionan interceptando gotas de agua líquida suspendidas en el aire. La variable clave es el **Contenido de Agua Líquida** (LWC, g/m³).

### Estimación del LWC desde la Humedad Relativa

Como Open-Meteo no proporciona LWC directamente, se estima empíricamente:

```
HR < 80%    →  LWC = 0 g/m³    (no hay niebla)
HR 80–90%   →  LWC = 0 – 0.2 g/m³  (niebla ligera)
HR 90–95%   →  LWC = 0.2 – 0.5 g/m³ (niebla moderada)
HR > 95%    →  LWC = 0.5 + (HR-95) × 0.10 g/m³ (niebla densa)
Máximo      →  LWC ≤ 3.0 g/m³  (tope empírico)
```

*Referencias: Klemm et al. (2012), Olivier (2002), Gultepe et al. (2007)*

### Fórmula de rendimiento

```
yield (L/m²/día) = LWC × (v_viento − 0.5) × η × H_niebla × 3600 ÷ 1000 × f_elevación

donde:
  LWC          Contenido de agua líquida (g/m³)
  v_viento     Velocidad del viento (m/s)
  η            Eficiencia del colector = 20% (malla Raschel estándar)
  H_niebla     Horas de niebla/día = 8 h (estimación costera conservadora)
  × 3600       Convierte m/s × h → m de recorrido
  ÷ 1000       Convierte g → litros (agua: 1 g ≈ 1 ml)
  f_elevación  Factor de corrección por banda altitudinal óptima (180–850 m)
```

**Rango típico:** 0.5–8 L/m²/día para costa neblosa. Máximo teórico ~15 L/m²/día en condiciones óptimas.

---

## Parámetros ajustables (`script.js`)

```js
CFG.WIND.PARTICLE_COUNT  // número de partículas de viento (3500 por defecto)
CFG.WIND.FADE            // longitud del rastro (0=corto, 1=largo)
CFG.TERRAIN_EXG          // exageración del relieve 3D (1.5 por defecto)
CFG.Y.EFFICIENCY         // eficiencia del colector (0.20 = 20%)
CFG.Y.FOG_HOURS          // horas de niebla asumidas por día (8)
CFG.F.*                  // umbrales de factibilidad por factor
```

---

## Exportación

- **CSV** — todos los datos del punto analizado en una fila
- **JSON** — objeto completo con LWC, rendimiento, factores, etc.
- **IMG** — captura del mapa con todas las capas visibles

---

## Estructura de archivos

```
fogharvest-v4/
├── index.html    — estructura HTML, topbar, panel de análisis
├── style.css     — estilos: dark UI, search bar, panel, leyenda
├── script.js     — lógica completa (mapa, viento, humedad, análisis, búsqueda)
└── README.md     — este documento
```

---

## Notas técnicas

- **MapTiler + Mapbox GL JS**: MapTiler es totalmente compatible con el renderer de Mapbox GL JS. El `accessToken` de Mapbox se establece como dummy ya que la autenticación real está en las URLs de MapTiler (parámetro `?key=`).
- **Open-Meteo**: API meteorológica gratuita sin límite de uso razonable. Los datos de viento a 80m/120m solo están disponibles en el bloque `hourly`, no en `current`.
- **Geocoding**: Endpoint `GET /geocoding/{query}.json?key=...` de MapTiler. Devuelve GeoJSON FeatureCollection con hasta 6 resultados.
- **Canvases**: El mapa se renderiza en su propio canvas (z-index 1). Encima viven `#hum-canvas` (z-index 2) y `#wind-canvas` (z-index 3), ambos con `pointer-events: none` para no bloquear el mapa.