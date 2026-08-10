const { invoke } = window.__TAURI__.core;

const statusEl = document.getElementById('status');
const routeListEl = document.getElementById('routeList');
const poiListEl = document.getElementById('poiList');
const routeDialog = document.getElementById('routeDialog');
const routeNameInput = document.getElementById('routeNameInput');
const routeColorPicker = document.getElementById('routeColorPicker');
const routeColorsEl = document.getElementById('routeColors');
const poiDialog = document.getElementById('poiDialog');
const poiDialogTitle = document.getElementById('poiDialogTitle');
const poiLabelInput = document.getElementById('poiLabel');
const poiColorPicker = document.getElementById('poiColorPicker');
const poiColorsEl = document.getElementById('poiColors');
const imageDialog = document.getElementById('imageDialog');
const imageDialogImg = document.getElementById('imageDialogImg');
const imageDialogTitle = document.getElementById('imageDialogTitle');
const poiCategorySelect = document.getElementById('poiCategorySelect');
const poiCategoryInput = document.getElementById('poiCategoryInput');
const poiCategoryFilter = document.getElementById('poiCategoryFilter');
const versionBadge = document.getElementById('versionBadge');
const updateLink = document.getElementById('updateLink');
const toggleCoordsBtn = document.getElementById('toggleCoordsBtn');
let showCoords = true;

const ROUTE_COLORS = ['#00ffcc', '#ff8800', '#4488ff', '#ff44d3', '#ffee00', '#44cc44', '#ff4444', '#ffffff'];
const POI_COLORS = ['#ff44d3', '#ff8800', '#44cc44', '#4488ff', '#ffee00', '#ff4444', '#ffffff'];
let selectedRouteColor = ROUTE_COLORS[0];
let selectedPoiColor = POI_COLORS[0];
let selectedPoiCategory = '';
let hiddenPoiCategories = new Set();
let pendingPoi = null;
let editingPoiId = null;
let pendingCrosshairMarker = null;
let useClustering = safeGetStorage('mainmap.clustering', 'false') === 'true';

let data = { routes: [], current_route_id: null, pois: [] };
let isRecording = false;
let currentCoord = null;

// World bounds in SCUM game coordinates
let worldMinX = -904800;
let worldMaxX = 619318;
let worldMinY = -904800;
let worldMaxY = 618818;
let worldWidth = worldMaxX - worldMinX;
let worldHeight = worldMaxY - worldMinY;

// Tile system: 256px tiles, zoom 0-6. Image upscaled to 16384x16384 (no padding).
// Zoom 0-3 bundled, 4-6 via download. maxNativeZoom adjusts dynamically.
const MAP_UNITS = 256;
const MAX_ZOOM = 6;
const MIN_ZOOM = 0;
const BUNDLED_MAX_ZOOM = 3;

function safeGetStorage(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function safeSetStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Convert SCUM game coordinates to Leaflet coordinates
// Map image: top-left = (worldMaxX, worldMaxY), bottom-right = (worldMinX, worldMinY)
// With our custom CRS, lat=0 is bottom, lat=MAP_UNITS is top (like CRS.Simple)
function gameToLatLng(gameX, gameY) {
  const px = ((worldMaxX - gameX) / worldWidth) * MAP_UNITS;
  const py = ((worldMaxY - gameY) / worldHeight) * MAP_UNITS;
  return [MAP_UNITS - py, px];
}

function latLngToGame(lat, lng) {
  const py = MAP_UNITS - lat;
  const px = lng;
  const gameX = worldMaxX - (px / MAP_UNITS) * worldWidth;
  const gameY = worldMaxY - (py / MAP_UNITS) * worldHeight;
  return { x: gameX, y: gameY };
}

const SECTOR_ROWS = ['D','C','B','A','Z'];
const SECTOR_COLS = ['4','3','2','1','0'];
function getSector(x, y) {
  const width = worldMaxX - worldMinX;
  const height = worldMaxY - worldMinY;
  // SCUM X axis is inverted: X max = west/left (col 4), X min = east/right (col 0)
  const col = Math.floor(((worldMaxX - x) / width) * SECTOR_COLS.length);
  const row = Math.floor(((worldMaxY - y) / height) * SECTOR_ROWS.length);
  const c = Math.max(0, Math.min(SECTOR_COLS.length - 1, col));
  const r = Math.max(0, Math.min(SECTOR_ROWS.length - 1, row));
  return SECTOR_ROWS[r] + SECTOR_COLS[c];
}

function showPendingCrosshair(x, y, skipFly) {
  clearPendingCrosshair();
  const ll = gameToLatLng(x, y);
  pendingCrosshairMarker = L.marker(ll, {
    icon: L.divIcon({
      html: '<div class="pending-crosshair-inner"><div class="pending-crosshair-ring"></div></div>',
      className: 'pending-crosshair',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    }),
    interactive: false
  }).addTo(map);
  if (!skipFly) map.flyTo(ll, MAX_ZOOM, { duration: 0.8 });
}

function clearPendingCrosshair() {
  if (pendingCrosshairMarker) {
    map.removeLayer(pendingCrosshairMarker);
    pendingCrosshairMarker = null;
  }
}

function getPoiCategories() {
  const cats = new Set();
  data.pois.forEach(p => { if (p.category) cats.add(p.category); });
  return Array.from(cats).sort();
}

function syncHiddenPoiCategories() {
  const cats = new Set(data.hidden_categories || []);
  hiddenPoiCategories = cats;
}

function populatePoiCategorySelect(current, fallback) {
  const cats = getPoiCategories();
  if (current && !cats.includes(current)) cats.push(current);
  if (fallback && !cats.includes(fallback)) cats.push(fallback);
  cats.sort();
  poiCategorySelect.innerHTML = '';
  cats.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === (current || fallback)) opt.selected = true;
    poiCategorySelect.appendChild(opt);
  });
  const neuOpt = document.createElement('option');
  neuOpt.value = '__new__';
  neuOpt.textContent = 'Neue Kategorie...';
  poiCategorySelect.appendChild(neuOpt);
  if ((current || fallback) && !cats.includes(current || fallback)) {
    poiCategorySelect.value = '__new__';
    poiCategoryInput.style.display = '';
    poiCategoryInput.value = current || fallback;
  } else {
    poiCategoryInput.style.display = 'none';
    poiCategoryInput.value = '';
  }
}

// Livemap server URL (cached after first fetch)
let livemapUrl = null;
let tileBaseUrl = 'http://127.0.0.1:4488';
async function initLivemapUrl() {
  try {
    livemapUrl = await invoke('get_livemap_url');
    if (livemapUrl) {
      const u = new URL(livemapUrl);
      tileBaseUrl = `${u.protocol}//${u.host}`;
      const livemapUrlInput = document.getElementById('livemapUrl');
      if (livemapUrlInput) livemapUrlInput.value = livemapUrl;
    }
  } catch {}
}

// Custom CRS: like CRS.Simple (Y-flip) but shifted so pixel coords are always positive
// Transformation: y = -lat + MAP_UNITS (instead of y = -lat)
const customCRS = L.extend({}, L.CRS.Simple, {
  transformation: new L.Transformation(1, 0, -1, MAP_UNITS),
});

// Create Leaflet map with custom CRS
const map = L.map('map', {
  crs: customCRS,
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  zoomSnap: 0,
  zoomDelta: 0.25,
  wheelPxPerZoomLevel: 60,
  zoomControl: false,
  attributionControl: false,
  preferCanvas: true,
});

let tileLayer = null;

async function initTileLayer() {
  await initLivemapUrl();
  let maxNative = BUNDLED_MAX_ZOOM;
  try {
    const installed = await invoke('check_hires_tiles');
    if (installed) {
      maxNative = MAX_ZOOM;
      if (downloadHiresBtn) {
        downloadHiresBtn.textContent = '✓ Hi-Res Tiles (installiert)';
        downloadHiresBtn.disabled = true;
      }
      if (hiresStatus) hiresStatus.textContent = '✓ Hi-Res Tiles installiert';
    }
  } catch {}
  tileLayer = L.tileLayer(tileBaseUrl + '/tiles/{z}/{x}/{y}.png', {
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    maxNativeZoom: maxNative,
    tileSize: 256,
    noWrap: true,
    bounds: L.latLngBounds([0, 0], [MAP_UNITS, MAP_UNITS]),
  }).addTo(map);
}

initTileLayer();

map.setMaxBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);
map.fitBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);

// Dedicated pane for player marker so it renders above POI markers
map.createPane('liveMarkerPane');
map.getPane('liveMarkerPane').style.zIndex = '700';

// Restore saved view
const savedZoom = parseInt(safeGetStorage('mainmap.leafletZoom', ''));
const savedLat = parseFloat(safeGetStorage('mainmap.leafletLat', ''));
const savedLng = parseFloat(safeGetStorage('mainmap.leafletLng', ''));
if (!isNaN(savedZoom) && !isNaN(savedLat) && !isNaN(savedLng)) {
  map.setView([savedLat, savedLng], savedZoom);
}

map.on('zoomend moveend', () => {
  const c = map.getCenter();
  safeSetStorage('mainmap.leafletZoom', String(map.getZoom()));
  safeSetStorage('mainmap.leafletLat', c.lat.toFixed(2));
  safeSetStorage('mainmap.leafletLng', c.lng.toFixed(2));
});

// Follow / Center / Fit (floating map controls)
let followEnabled = false;
const mapZoomLabel = document.getElementById('mapZoomLabel');
const mapClusterToggle = document.getElementById('mapClusterToggle');
function updateMapZoomLabel() {
  if (mapZoomLabel) {
    const z = map.getZoom();
    mapZoomLabel.textContent = Math.round(Math.pow(2, z) * 100) + '%';
  }
}
updateMapZoomLabel();
map.on('zoomend', updateMapZoomLabel);

document.getElementById('mapZoomIn').addEventListener('click', () => map.zoomIn());
document.getElementById('mapZoomOut').addEventListener('click', () => map.zoomOut());

const mapFollowBtn = document.getElementById('mapFollowBtn');
if (mapFollowBtn) {
  mapFollowBtn.addEventListener('click', () => {
    followEnabled = !followEnabled;
    mapFollowBtn.style.background = followEnabled ? '#00ffcc33' : '';
    if (followEnabled && currentCoord) {
      const ll = gameToLatLng(currentCoord.x, currentCoord.y);
      map.panTo(ll, { animate: true, duration: 0.5 });
    }
  });
}

document.getElementById('mapCenterBtn').addEventListener('click', () => {
  if (currentCoord) {
    const ll = gameToLatLng(currentCoord.x, currentCoord.y);
    map.panTo(ll, { animate: true, duration: 0.5 });
  }
});

document.getElementById('mapFitBtn').addEventListener('click', () => {
  followEnabled = false;
  if (mapFollowBtn) mapFollowBtn.style.background = '';
  map.flyToBounds([[0, 0], [MAP_UNITS, MAP_UNITS]], { duration: 0.8 });
});

// Measure mode
let measureMode = false;
let measureLine = null;
let measureLabel = null;
let measureStart = null;
let isMeasuring = false;
const mapMeasureBtn = document.getElementById('mapMeasureBtn');

if (mapMeasureBtn) {
  mapMeasureBtn.addEventListener('click', () => {
    measureMode = !measureMode;
    mapMeasureBtn.classList.toggle('active', measureMode);
    map.getContainer().style.cursor = measureMode ? 'crosshair' : '';
    if (!measureMode) clearMeasure();
  });
}

function clearMeasure() {
  if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
  if (measureLabel) { map.removeLayer(measureLabel); measureLabel = null; }
  measureStart = null;
  isMeasuring = false;
}

function formatDistance(cm) {
  if (cm >= 100000) return (cm / 100000).toFixed(2) + ' km';
  if (cm >= 100) return (cm / 100).toFixed(1) + ' m';
  return cm.toFixed(0) + ' cm';
}

map.on('mousedown', (e) => {
  if (!measureMode) return;
  isMeasuring = true;
  measureStart = e.latlng;
  if (measureLine) map.removeLayer(measureLine);
  if (measureLabel) map.removeLayer(measureLabel);
  measureLine = L.polyline([measureStart, measureStart], { color: '#00ffcc', weight: 2, dashArray: '6,4' }).addTo(map);
  measureLabel = L.marker(measureStart, {
    icon: L.divIcon({ className: 'measure-label', html: '', iconSize: [120, 24], iconAnchor: [60, -12] }),
    interactive: false
  }).addTo(map);
  map.dragging.disable();
});

map.on('mousemove', (e) => {
  if (!isMeasuring || !measureStart) return;
  const start = latLngToGame(measureStart.lat, measureStart.lng);
  const end = latLngToGame(e.latlng.lat, e.latlng.lng);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  measureLine.setLatLngs([measureStart, e.latlng]);
  measureLabel.setLatLng(e.latlng);
  const el = measureLabel.getElement();
  if (el) el.innerHTML = formatDistance(dist);
});

map.on('mouseup', (e) => {
  if (!isMeasuring) return;
  isMeasuring = false;
  map.dragging.enable();
});

// Leaflet layers for routes, POIs, live marker
let routeLayers = {};
let routeEndMarkers = {};
let poiClusterGroup = null;
let liveMarker = null;
let liveArrow = null;
let livePulse = null;
let connectionLines = [];
let connectionLabels = [];
let connectedPoiIds = new Set();

async function syncPoiConnections() {
  try {
    const ids = await invoke('get_poi_connections');
    connectedPoiIds = new Set(Array.isArray(ids) ? ids : []);
    updateUI();
  } catch (err) {
    console.error('POI-Verbindungen laden fehlgeschlagen:', err);
  }
}

async function syncPlayerPosition() {
  try {
    const pos = await invoke('get_player_position');
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      currentCoord = pos;
      const ll = gameToLatLng(currentCoord.x, currentCoord.y);
      updateLiveMarker(ll);
    }
  } catch (err) {
    console.error('Spielerposition laden fehlgeschlagen:', err);
  }
}

function clearRoutes() {
  Object.values(routeLayers).forEach(l => map.removeLayer(l));
  Object.values(routeEndMarkers).forEach(m => map.removeLayer(m));
  routeLayers = {};
  routeEndMarkers = {};
}

function clearPois() {
  if (poiClusterGroup) {
    map.removeLayer(poiClusterGroup);
    poiClusterGroup = null;
  }
}

function clearLiveMarker() {
  if (liveMarker) { map.removeLayer(liveMarker); liveMarker = null; }
  if (liveArrow) { map.removeLayer(liveArrow); liveArrow = null; }
  if (livePulse) { map.removeLayer(livePulse); livePulse = null; }
}

let connectionLayersByPoi = {};
let lineAnimFrame = null;
let lineAnimFrom = null;
let lineAnimStart = 0;

function lerpLatLng(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function lerpSeg(a, b, t) {
  return a.map((pt, i) => lerpLatLng(pt, b[i], t));
}

function captureLineState() {
  const state = {};
  Object.entries(connectionLayersByPoi).forEach(([id, entry]) => {
    const label = entry.label ? entry.label.getLatLng() : null;
    state[id] = {
      seg1: entry.seg1 ? entry.seg1.getLatLngs().map(l => [l.lat, l.lng]) : null,
      seg2: entry.seg2 ? entry.seg2.getLatLngs().map(l => [l.lat, l.lng]) : null,
      label: label ? [label.lat, label.lng] : null,
    };
  });
  return state;
}

function applyLineState(state, t, targetState) {
  Object.entries(targetState).forEach(([id, target]) => {
    const entry = connectionLayersByPoi[id];
    if (!entry) return;
    const from = state[id];
    if (from && target.seg1 && entry.seg1) {
      const interp = lerpSeg(from.seg1, target.seg1, t);
      entry.seg1.setLatLngs(interp);
    } else if (target.seg1 && entry.seg1) {
      entry.seg1.setLatLngs(target.seg1);
    }
    if (from && target.seg2 && entry.seg2) {
      const interp = lerpSeg(from.seg2, target.seg2, t);
      entry.seg2.setLatLngs(interp);
    } else if (target.seg2 && entry.seg2) {
      entry.seg2.setLatLngs(target.seg2);
    }
    if (from && target.label && entry.label) {
      const interp = lerpLatLng(from.label, target.label, t);
      entry.label.setLatLng(interp);
    } else if (target.label && entry.label) {
      entry.label.setLatLng(target.label);
    }
  });
}

function clearConnectionLine() {
  Object.values(connectionLayersByPoi).forEach(entry => {
    if (entry.seg1) map.removeLayer(entry.seg1);
    if (entry.seg2) map.removeLayer(entry.seg2);
    if (entry.label) map.removeLayer(entry.label);
  });
  connectionLayersByPoi = {};
  connectionLines = [];
  connectionLabels = [];
}

function renderConnectionLine() {
  if (!currentCoord) {
    clearConnectionLine();
    return;
  }
  const prevState = captureLineState();
  const activeIds = new Set();
  const targetState = {};

  connectedPoiIds.forEach(id => {
    const poi = data.pois.find(p => p.id === id);
    if (!poi) return;
    activeIds.add(id);
    const from = gameToLatLng(currentCoord.x, currentCoord.y);
    const to = gameToLatLng(poi.x, poi.y);
    const dx = poi.x - currentCoord.x;
    const dy = poi.y - currentCoord.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const color = poi.color || '#888';

    const pFrom = map.latLngToContainerPoint(L.latLng(from[0], from[1]));
    const pTo = map.latLngToContainerPoint(L.latLng(to[0], to[1]));
    const angleRad = Math.atan2(pTo.y - pFrom.y, pTo.x - pFrom.x);
    const angle = angleRad * 180 / Math.PI;
    let textAngle = angle;
    if (textAngle > 90) textAngle -= 180;
    if (textAngle < -90) textAngle += 180;

    let seg1LatLngs, seg2LatLngs, labelLatLng, hasLabel = false;

    if (dist > 200) {
      const mapSize = map.getSize();
      const inset = 50;
      const dirX = Math.cos(angleRad);
      const dirY = Math.sin(angleRad);
      let tEdge = Infinity;
      if (dirX > 0.001) tEdge = Math.min(tEdge, (mapSize.x - inset - pFrom.x) / dirX);
      if (dirX < -0.001) tEdge = Math.min(tEdge, (inset - pFrom.x) / dirX);
      if (dirY > 0.001) tEdge = Math.min(tEdge, (mapSize.y - inset - pFrom.y) / dirY);
      if (dirY < -0.001) tEdge = Math.min(tEdge, (inset - pFrom.y) / dirY);
      const distToPoi = Math.sqrt((pTo.x - pFrom.x) ** 2 + (pTo.y - pFrom.y) ** 2);
      const labelDist = Math.min(tEdge, distToPoi - 30);
      if (labelDist >= 40) {
        hasLabel = true;
        const labelPxX = pFrom.x + dirX * labelDist;
        const labelPxY = pFrom.y + dirY * labelDist;
        labelLatLng = map.containerPointToLatLng(L.point(labelPxX, labelPxY));
        const gapPx = 30;
        const gap1PxX = pFrom.x + dirX * (labelDist - gapPx);
        const gap1PxY = pFrom.y + dirY * (labelDist - gapPx);
        const gap1LatLng = map.containerPointToLatLng(L.point(gap1PxX, gap1PxY));
        const gap2PxX = pFrom.x + dirX * (labelDist + gapPx);
        const gap2PxY = pFrom.y + dirY * (labelDist + gapPx);
        const gap2LatLng = map.containerPointToLatLng(L.point(gap2PxX, gap2PxY));
        seg1LatLngs = [from, [gap1LatLng.lat, gap1LatLng.lng]];
        seg2LatLngs = [[gap2LatLng.lat, gap2LatLng.lng], to];
      } else {
        seg1LatLngs = [from, to];
        seg2LatLngs = null;
      }
    } else {
      seg1LatLngs = [from, to];
      seg2LatLngs = null;
    }

    targetState[id] = {
      seg1: seg1LatLngs ? seg1LatLngs.map(p => [p[0], p[1]]) : null,
      seg2: seg2LatLngs ? seg2LatLngs.map(p => [p[0], p[1]]) : null,
      label: hasLabel ? [labelLatLng.lat, labelLatLng.lng] : null,
      textAngle, color, poiLabel: poi.label,
    };

    let entry = connectionLayersByPoi[id];
    if (!entry) {
      entry = { seg1: null, seg2: null, label: null, color };
      connectionLayersByPoi[id] = entry;
    }

    const lineOpts = {
      color, weight: 2, opacity: 0.7,
      dashArray: '8,4,2,4', dashOffset: 0,
      className: 'poi-connection-line',
    };

    if (!entry.seg1) {
      entry.seg1 = L.polyline(seg1LatLngs, lineOpts).addTo(map);
      connectionLines.push(entry.seg1);
    }

    if (seg2LatLngs && !entry.seg2) {
      entry.seg2 = L.polyline(seg2LatLngs, lineOpts).addTo(map);
      connectionLines.push(entry.seg2);
    } else if (!seg2LatLngs && entry.seg2) {
      map.removeLayer(entry.seg2);
      entry.seg2 = null;
    }

    if (hasLabel && !entry.label) {
      entry.label = L.marker([labelLatLng.lat, labelLatLng.lng], {
        icon: L.divIcon({
          className: 'poi-connection-label',
          html: `<span style="color:${color};transform:rotate(${textAngle}deg)">${escapeHtml(poi.label)}</span>`,
          iconSize: [120, 20],
          iconAnchor: [60, 10],
        }),
        interactive: false,
      }).addTo(map);
      connectionLabels.push(entry.label);
    } else if (!hasLabel && entry.label) {
      map.removeLayer(entry.label);
      entry.label = null;
    }
  });

  Object.keys(connectionLayersByPoi).forEach(id => {
    if (!activeIds.has(id)) {
      const entry = connectionLayersByPoi[id];
      if (entry.seg1) map.removeLayer(entry.seg1);
      if (entry.seg2) map.removeLayer(entry.seg2);
      if (entry.label) map.removeLayer(entry.label);
      delete connectionLayersByPoi[id];
      delete prevState[id];
    }
  });

  if (lineAnimFrame) cancelAnimationFrame(lineAnimFrame);
  lineAnimStart = performance.now();
  const duration = Math.max(300, (trackingInterval - 0.1) * 1000);

  function animateLines(now) {
    const elapsed = now - lineAnimStart;
    const t = Math.min(1, elapsed / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t);

    Object.entries(targetState).forEach(([id, target]) => {
      const entry = connectionLayersByPoi[id];
      if (!entry) return;
      const from = prevState[id];

      if (entry.seg1 && target.seg1) {
        if (from && from.seg1) {
          entry.seg1.setLatLngs(lerpSeg(from.seg1, target.seg1, eased));
        } else {
          entry.seg1.setLatLngs(target.seg1);
        }
      }
      if (entry.seg2 && target.seg2) {
        if (from && from.seg2) {
          entry.seg2.setLatLngs(lerpSeg(from.seg2, target.seg2, eased));
        } else {
          entry.seg2.setLatLngs(target.seg2);
        }
      }
      if (entry.label && target.label) {
        if (from && from.label) {
          entry.label.setLatLng(lerpLatLng(from.label, target.label, eased));
        } else {
          entry.label.setLatLng(target.label);
        }
        const el = entry.label.getElement();
        if (el) {
          const span = el.querySelector('span');
          if (span) {
            span.style.color = target.color;
            span.style.transform = `rotate(${target.textAngle}deg)`;
            span.textContent = target.poiLabel;
          }
        }
      }
    });

    if (t < 1) {
      lineAnimFrame = requestAnimationFrame(animateLines);
    } else {
      lineAnimFrame = null;
    }
  }
  lineAnimFrame = requestAnimationFrame(animateLines);
}

function broadcastPoiConnection() {
  try {
    invoke('set_poi_connections', { ids: [...connectedPoiIds] });
  } catch (e) {}
}

function updateConnectionLines() {
  if (connectedPoiIds.size === 0) {
    clearConnectionLine();
    return;
  }
  renderConnectionLine();
}

async function wsBroadcast(msg) {
  try {
    await invoke('ws_broadcast_msg', { message: msg });
  } catch (e) {}
}

function renderRoutes() {
  clearRoutes();
  data.routes.forEach(route => {
    if (route.visible === false) return;
    if (!route.records || route.records.length < 1) return;
    const isCurrent = route.id === data.current_route_id;
    const color = route.color || '#888';

    if (route.records.length >= 2) {
      const latlngs = route.records.map(r => gameToLatLng(r.x, r.y));
      const line = L.polyline(latlngs, {
        color: color,
        weight: isCurrent ? 3 : 2,
        opacity: 0.8,
        dashArray: isCurrent ? null : '8,8',
      }).addTo(map);
      routeLayers[route.id] = line;
    }

    // End point marker
    const last = route.records[route.records.length - 1];
    const ll = gameToLatLng(last.x, last.y);
    const endMarker = L.circleMarker(ll, {
      radius: isCurrent ? 7 : 4,
      fillColor: color,
      color: '#000',
      weight: 1,
      fillOpacity: 1,
    }).addTo(map);
    routeEndMarkers[route.id] = endMarker;
  });
}

function createPoiGroup() {
  if (useClustering) {
    return L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: MAX_ZOOM,
      iconCreateFunction: function(cluster) {
        return L.divIcon({
          html: '<div class="cluster-count">' + cluster.getChildCount() + '</div>',
          className: 'marker-cluster-icon',
          iconSize: [34, 34],
          iconAnchor: [17, 17]
        });
      }
    });
  }
  return L.layerGroup();
}

function updateClusterButton() {
  if (mapClusterToggle) mapClusterToggle.classList.toggle('active', useClustering);
}

function renderPois() {
  clearPois();
  const filter = poiCategoryFilter ? poiCategoryFilter.value : '';
  poiClusterGroup = createPoiGroup();
  data.pois
    .filter(poi => !filter || poi.category === filter)
    .filter(poi => !hiddenPoiCategories.has(poi.category || 'Unkategorisiert'))
    .forEach(poi => {
    const ll = gameToLatLng(poi.x, poi.y);
    const color = poi.color || '#ff44d3';
    const marker = L.marker(ll, {
      icon: L.divIcon({
        html: '<div class="poi-dot" style="background:' + color + '"></div>',
        className: 'poi-marker',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      })
    });
    if (poi.label) marker.bindTooltip(poi.label, { permanent: true, direction: 'top', className: 'poi-label', offset: [0, -8] });

    if (poi.image_path) {
      let hoverPopupBound = false;
      marker.on('mouseover', async () => {
        if (!hoverPopupBound) {
          try {
            const base64 = await invoke('get_poi_image_base64', { id: poi.id });
            const img = new Image();
            img.onload = () => {
              const maxW = 200, maxH = 150;
              const scale = Math.min(maxW / img.width, maxH / img.height, 1);
              const w = Math.round(img.width * scale);
              const h = Math.round(img.height * scale);
              marker.bindPopup('<div style="width:' + w + 'px;height:' + h + 'px;display:flex;align-items:center;justify-content:center;background:#1a2332;border-radius:4px"><img src="data:image/png;base64,' + base64 + '" style="width:' + w + 'px;height:' + h + 'px;border-radius:4px;display:block"></div>', { maxWidth: 250, closeButton: false, autoPan: false });
              marker.openPopup();
            };
            img.src = 'data:image/png;base64,' + base64;
            hoverPopupBound = true;
          } catch (err) {}
        } else {
          marker.openPopup();
        }
      });
      marker.on('click', async () => {
        marker.closePopup();
        try {
          const base64 = await invoke('get_poi_image_base64', { id: poi.id });
          imageDialogImg.src = 'data:image/png;base64,' + base64;
          imageDialogTitle.textContent = 'Bild: ' + poi.label;
          imageDialog.classList.add('open');
        } catch (err) {
          statusEl.textContent = 'Fehler beim Laden des Bildes: ' + err;
        }
      });
    }

    poiClusterGroup.addLayer(marker);
  });
  if (poiClusterGroup) map.addLayer(poiClusterGroup);
}

updateClusterButton();
if (mapClusterToggle) {
  mapClusterToggle.addEventListener('click', () => {
    useClustering = !useClustering;
    safeSetStorage('mainmap.clustering', String(useClustering));
    updateClusterButton();
    renderPois();
  });
}

function renderLiveMarker() {
  clearLiveMarker();
  if (!currentCoord) return;
  const ll = gameToLatLng(currentCoord.x, currentCoord.y);
  updateLiveMarker(ll);
}

function updateLiveMarker(ll) {
  if (!currentCoord) return;
  if (!ll) ll = gameToLatLng(currentCoord.x, currentCoord.y);
  if (liveMarker) {
    liveMarker.setLatLng(ll);
    const el = liveMarker.getElement();
    if (el) {
      const stem = el.querySelector('.live-marker-stem');
      const arrow = el.querySelector('.live-marker-arrow');
      if (typeof currentCoord.yaw === 'number') {
        if (stem) stem.style.setProperty('--yaw', `${currentCoord.yaw - 90}deg`);
        if (arrow) arrow.style.setProperty('--yaw', `${currentCoord.yaw - 90}deg`);
      }
    }
  } else {
    let html = '<div class="live-marker"><div class="live-marker-dot"></div>';
    if (typeof currentCoord.yaw === 'number') {
      html += `<div class="live-marker-stem" style="--yaw:${currentCoord.yaw - 90}deg"></div>`;
      html += `<div class="live-marker-arrow" style="--yaw:${currentCoord.yaw - 90}deg"></div>`;
    }
    html += '</div>';
    liveMarker = L.marker(ll, {
      icon: L.divIcon({
        className: '',
        html: html,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      }),
      interactive: false,
      pane: 'liveMarkerPane',
    }).addTo(map);
  }
}

function renderMap() {
  renderRoutes();
  renderPois();
  renderLiveMarker();
  renderConnectionLine();
}

function getCurrentRoute() {
  return data.routes.find(r => r.id === data.current_route_id);
}

async function loadData() {
  try {
    data = await invoke('get_data');
    if (!data.routes) data.routes = [];
    if (!data.pois) data.pois = [];
    if (!data.hidden_categories) data.hidden_categories = [];
    syncHiddenPoiCategories();
    await syncRecordingState();
    await syncLiveTrackingState();
    await syncPoiConnections();
    await syncPlayerPosition();
    updateUI();
    updateConnectionLines();
  } catch (err) {
    statusEl.textContent = 'Fehler beim Laden: ' + err;
  }
}

function updateUI() {
  syncHiddenPoiCategories();
  renderRouteList();
  renderPoiList();
  renderMap();
}

async function syncRecordingState() {
  try {
    isRecording = await invoke('is_recording');
  } catch (err) {
    isRecording = false;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderRouteList() {
  routeListEl.innerHTML = '';
  if (data.routes.length === 0) {
    routeListEl.innerHTML = '<p class="empty">Noch keine Route</p>';
    return;
  }
  data.routes.forEach(route => {
    const isCurrent = route.id === data.current_route_id;
    const recordingHere = isCurrent && isRecording;
    const visible = route.visible !== false;
    const div = document.createElement('div');
    div.className = 'route-item' + (isCurrent ? ' active' : '');
    div.innerHTML = `
      <span class="route-color" style="background:${route.color || '#888'}"></span>
      <span class="route-name">${escapeHtml(route.name)}</span>
      <span class="route-actions">
        <button class="route-icon ${recordingHere ? 'recording' : ''}" data-action="record" data-id="${route.id}" title="${recordingHere ? 'Aufzeichnung stoppen' : 'Aufzeichnung starten'}">${recordingHere ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>' : '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>'}</button>
        <button class="route-icon ${visible ? '' : 'hidden'}" data-action="toggle-visibility" data-id="${route.id}" title="${visible ? 'Auf Karte ausblenden' : 'Auf Karte einblenden'}">${visible ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'}</button>
        <button class="route-icon" data-action="rename" data-id="${route.id}" title="Umbenennen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button class="route-icon" data-action="delete" data-id="${route.id}" title="Löschen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </span>
      <span class="route-count">${route.records.length} Punkte</span>
    `;
    div.addEventListener('click', async (e) => {
      if (e.target.closest('.route-icon')) return;
      data = await invoke('select_route', { id: route.id });
      updateUI();
    });
    routeListEl.appendChild(div);
  });

  routeListEl.querySelectorAll('.route-icon').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = el.dataset.action;
      const id = el.dataset.id;
      if (action === 'record') {
        const route = data.routes.find(r => r.id === id);
        if (!route) return;
        if (isRecording && data.current_route_id === id) {
          isRecording = await invoke('toggle_recording');
        } else {
          if (!isRecording || data.current_route_id !== id) {
            if (data.current_route_id !== id) {
              data = await invoke('select_route', { id });
            }
            isRecording = await invoke('toggle_recording');
          }
        }
      } else if (action === 'activate') {
        data = await invoke('select_route', { id });
      } else if (action === 'toggle-visibility') {
        data = await invoke('toggle_route_visibility', { id });
      } else if (action === 'rename') {
        const route = data.routes.find(r => r.id === id);
        if (!route) return;
        const newName = prompt('Neuer Name:', route.name);
        if (newName) data = await invoke('rename_route', { id, name: newName });
      } else if (action === 'delete') {
        if (confirm('Route wirklich löschen?')) {
          data = await invoke('delete_route', { id });
        } else { return; }
      }
      updateUI();
    });
  });

  routeListEl.querySelectorAll('.route-color').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.closest('.route-item').querySelector('.route-icon').dataset.id;
      const route = data.routes.find(r => r.id === id);
      if (!route) return;
      const nextIndex = (ROUTE_COLORS.indexOf(route.color) + 1) % ROUTE_COLORS.length;
      const newColor = ROUTE_COLORS[nextIndex];
      data = await invoke('set_route_color', { id, color: newColor });
      updateUI();
    });
  });
}

function renderPoiList() {
  const savedFilter = poiCategoryFilter ? poiCategoryFilter.value : '';
  const categories = getPoiCategories();
  if (poiCategoryFilter) {
    poiCategoryFilter.innerHTML = '<option value="">Alle Kategorien</option>';
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (cat === savedFilter) opt.selected = true;
      poiCategoryFilter.appendChild(opt);
    });
  }

  poiListEl.innerHTML = '';
  if (data.pois.length === 0) {
    poiListEl.innerHTML = '<p class="empty">Keine POIs</p>';
    return;
  }

  const filter = poiCategoryFilter ? poiCategoryFilter.value : '';
  const filtered = data.pois
    .filter(poi => !filter || (poi.category || 'Unkategorisiert') === filter)
    .sort((a, b) => (a.category || 'Unkategorisiert').localeCompare(b.category || 'Unkategorisiert'));
  let currentCat = null;
  const eyeOpen = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const eyeOff = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  let currentCatHidden = false;
  filtered.forEach(poi => {
    const cat = poi.category || 'Unkategorisiert';
    if (cat !== currentCat) {
      currentCat = cat;
      currentCatHidden = hiddenPoiCategories.has(cat);
      const count = filtered.filter(p => (p.category || 'Unkategorisiert') === cat).length;
      const header = document.createElement('div');
      header.className = 'poi-group-header' + (currentCatHidden ? ' hidden' : '');
      header.innerHTML = `<span class="poi-group-title"><svg class="collapse-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg><svg class="poi-group-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${cat} (${count})</span><button class="poi-visibility-toggle" data-cat="${cat}" title="${currentCatHidden ? 'Kategorie einblenden' : 'Kategorie ausblenden'}">${currentCatHidden ? eyeOff : eyeOpen}</button>`;
      poiListEl.appendChild(header);
    }
    if (currentCatHidden) return;
    const hasImage = !!poi.image_path;
    const div = document.createElement('div');
    div.className = 'poi-item';
    div.innerHTML = `<span class="poi-label-span"><span class="poi-color" style="background:${poi.color}"></span>${escapeHtml(poi.label)}</span>
                     <span class="poi-actions">
                       <button class="poi-center-btn" data-id="${poi.id}" title="Karte auf POI zentrieren"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg></button>
                       <button class="poi-connect-btn ${connectedPoiIds.has(poi.id) ? 'active' : ''}" data-id="${poi.id}" title="${connectedPoiIds.has(poi.id) ? 'Verbindungslinie entfernen' : 'Verbindungslinie zu POI'}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><line x1="6.5" y1="6.5" x2="17.5" y2="17.5" stroke-dasharray="3,3"/></svg></button>
                       <button class="poi-more-btn" data-id="${poi.id}" title="Mehr Aktionen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
                       <div class="poi-dropdown" data-id="${poi.id}">
                         <button class="poi-edit" data-id="${poi.id}" title="POI bearbeiten"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> Bearbeiten</button>
                         <button class="poi-image-btn" data-id="${poi.id}" title="${hasImage ? 'Bild anzeigen' : 'Screenshot aus SCUM'}">${hasImage ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'} ${hasImage ? 'Bild' : 'Screenshot'}</button>
                         <button class="poi-upload-btn" data-id="${poi.id}" title="Bild hochladen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload</button>
                         <button class="poi-copy" data-id="${poi.id}" title="POI in Zwischenablage kopieren"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="14" height="14" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> Kopieren</button>
                         <button class="poi-delete" data-id="${poi.id}" title="POI löschen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Löschen</button>
                       </div>
                     </span>`;
    poiListEl.appendChild(div);
  });

  poiListEl.querySelectorAll('.poi-more-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = el.nextElementSibling;
      const isOpen = dropdown.classList.contains('open');
      poiListEl.querySelectorAll('.poi-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!isOpen) dropdown.classList.add('open');
    });
  });

  document.addEventListener('click', () => {
    poiListEl.querySelectorAll('.poi-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  poiListEl.querySelectorAll('.poi-dropdown').forEach(d => {
    d.addEventListener('click', (e) => e.stopPropagation());
  });

  poiListEl.querySelectorAll('.poi-center-btn').forEach(el => {
    el.addEventListener('click', () => {
      const poi = data.pois.find(p => p.id === el.dataset.id);
      if (!poi) return;
      const ll = gameToLatLng(poi.x, poi.y);
      map.flyTo(ll, 6, { duration: 0.8 });
    });
  });

  poiListEl.querySelectorAll('.poi-connect-btn').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (connectedPoiIds.has(id)) {
        connectedPoiIds.delete(id);
      } else {
        connectedPoiIds.add(id);
      }
      renderConnectionLine();
      broadcastPoiConnection();
      updateUI();
    });
  });

  poiListEl.querySelectorAll('.poi-edit').forEach(el => {
    el.addEventListener('click', () => {
      const poi = data.pois.find(p => p.id === el.dataset.id);
      if (!poi) return;
      editingPoiId = poi.id;
      pendingPoi = null;
      selectedPoiColor = poi.color;
      poiDialogTitle.textContent = 'POI bearbeiten';
      poiLabelInput.value = poi.label;
      poiColorPicker.value = selectedPoiColor;
      populatePoiCategorySelect(poi.category, '');
      buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
      poiDialog.classList.add('open');
      poiLabelInput.focus();
      poiLabelInput.select();
    });
  });

  poiListEl.querySelectorAll('.poi-image-btn').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const poi = data.pois.find(p => p.id === id);
      if (!poi) return;
      if (poi.image_path) {
        try {
          const base64 = await invoke('get_poi_image_base64', { id });
          imageDialogImg.src = 'data:image/png;base64,' + base64;
          imageDialogTitle.textContent = 'Bild: ' + poi.label;
          imageDialog.classList.add('open');
        } catch (err) {
          statusEl.textContent = 'Fehler beim Laden des Bildes: ' + err;
        }
      } else {
        try {
          data = await invoke('paste_poi_screenshot', { id });
          updateUI();
          statusEl.textContent = 'Screenshot gespeichert.';
        } catch (err) {
          statusEl.textContent = 'Kein Bild in Zwischenablage: ' + err;
        }
      }
    });
  });

  poiListEl.querySelectorAll('.poi-upload-btn').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(',')[1];
          try {
            data = await invoke('upload_poi_image', { id, base64Data: base64 });
            updateUI();
            statusEl.textContent = 'Bild hochgeladen.';
          } catch (err) {
            statusEl.textContent = 'Fehler beim Upload: ' + err;
          }
        };
        reader.readAsDataURL(file);
      };
      input.click();
    });
  });

  poiListEl.querySelectorAll('.poi-delete').forEach(el => {
    el.addEventListener('click', async () => {
      data = await invoke('remove_poi', { id: el.dataset.id });
      updateUI();
    });
  });

  poiListEl.querySelectorAll('.poi-copy').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const poi = data.pois.find(p => p.id === el.dataset.id);
      if (!poi) return;
      const poiJson = JSON.stringify({
        label: poi.label,
        x: poi.x,
        y: poi.y,
        color: poi.color,
        category: poi.category || ''
      });
      try {
        await navigator.clipboard.writeText(poiJson);
        statusEl.textContent = 'POI kopiert: ' + poi.label;
      } catch (err) {
        statusEl.textContent = 'Kopieren fehlgeschlagen: ' + err;
      }
    });
  });

  poiListEl.querySelectorAll('.poi-visibility-toggle').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cat = el.dataset.cat;
      data = await invoke('toggle_hidden_category', { category: cat });
      syncHiddenPoiCategories();
      updateUI();
    });
  });
}

function buildColorPicker(container, colors, selected, onSelect, pickerInput) {
  container.innerHTML = '';
  colors.forEach(color => {
    const btn = document.createElement('div');
    btn.className = 'color-btn' + (color === selected ? ' selected' : '');
    btn.style.background = color;
    btn.addEventListener('click', () => {
      onSelect(color);
      if (pickerInput) pickerInput.value = color;
      buildColorPicker(container, colors, color, onSelect, pickerInput);
    });
    container.appendChild(btn);
  });
  if (pickerInput && !colors.includes(selected)) {
    pickerInput.value = selected;
  }
}

// Context menu for adding POIs via right-click on map
map.on('contextmenu', (e) => {
  const game = latLngToGame(e.latlng.lat, e.latlng.lng);
  pendingPoi = game;
  editingPoiId = null;
  poiDialogTitle.textContent = 'POI hinzufügen';
  poiLabelInput.value = '';
  poiColorPicker.value = selectedPoiColor;
  populatePoiCategorySelect('', getSector(game.x, game.y));
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
  showPendingCrosshair(game.x, game.y, true);
  poiDialog.classList.add('open', 'top-left');
  poiLabelInput.focus();
});

poiColorPicker.addEventListener('input', (e) => {
  selectedPoiColor = e.target.value.toLowerCase();
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
});

if (poiCategorySelect) {
  poiCategorySelect.addEventListener('change', () => {
    if (poiCategorySelect.value === '__new__') {
      poiCategoryInput.style.display = '';
      poiCategoryInput.focus();
    } else {
      poiCategoryInput.style.display = 'none';
      poiCategoryInput.value = '';
    }
  });
}

if (poiCategoryFilter) {
  poiCategoryFilter.addEventListener('change', () => {
    updateUI();
  });
}

// Route dialog
function openRouteDialog() {
  routeNameInput.value = `Route ${data.routes.length + 1}`;
  selectedRouteColor = ROUTE_COLORS[data.routes.length % ROUTE_COLORS.length];
  routeColorPicker.value = selectedRouteColor;
  buildColorPicker(routeColorsEl, ROUTE_COLORS, selectedRouteColor, c => selectedRouteColor = c, routeColorPicker);
  routeDialog.classList.add('open');
  routeNameInput.focus();
  routeNameInput.select();
}

document.getElementById('addRouteBtn').addEventListener('click', openRouteDialog);

routeColorPicker.addEventListener('input', (e) => {
  selectedRouteColor = e.target.value.toLowerCase();
  buildColorPicker(routeColorsEl, ROUTE_COLORS, selectedRouteColor, c => selectedRouteColor = c, routeColorPicker);
});

document.getElementById('routeCancel').addEventListener('click', () => {
  routeDialog.classList.remove('open');
});

document.getElementById('routeSave').addEventListener('click', async () => {
  const name = routeNameInput.value.trim() || 'Neue Route';
  data = await invoke('new_route', { name, color: selectedRouteColor });
  updateUI();
  routeDialog.classList.remove('open');
});

// POI dialog
document.getElementById('poiCancel').addEventListener('click', () => {
  poiDialog.classList.remove('open', 'top-left');
  clearPendingCrosshair();
  pendingPoi = null;
  editingPoiId = null;
});

document.getElementById('imageDialogClose').addEventListener('click', () => {
  imageDialog.classList.remove('open');
  imageDialogImg.src = '';
});

document.getElementById('addPoiFromLocation').addEventListener('click', async () => {
  try {
    statusEl.textContent = 'Koordinaten werden gelesen...';
    const record = await invoke('get_current_location');
    pendingPoi = { x: record.x, y: record.y };
    editingPoiId = null;
    poiDialogTitle.textContent = 'POI hinzufügen';
    poiLabelInput.value = '';
    poiColorPicker.value = selectedPoiColor;
    populatePoiCategorySelect('', getSector(record.x, record.y));
    buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
    showPendingCrosshair(record.x, record.y);
    poiDialog.classList.add('open', 'top-left');
    poiLabelInput.focus();
    statusEl.textContent = `Position: X=${record.x.toFixed(0)} Y=${record.y.toFixed(0)}`;
  } catch (err) {
    statusEl.textContent = 'Fehler: ' + err;
  }
});

const clipboardDialog = document.getElementById('clipboardDialog');
const clipboardInput = document.getElementById('clipboardInput');

document.getElementById('addPoiFromClipboard').addEventListener('click', () => {
  clipboardInput.value = '';
  clipboardDialog.classList.add('open');
  clipboardInput.focus();
});

document.getElementById('clipboardCancel').addEventListener('click', () => {
  clipboardDialog.classList.remove('open');
});

document.getElementById('clipboardParse').addEventListener('click', () => {
  const text = (clipboardInput.value || '').trim();
  if (!text) {
    statusEl.textContent = 'Bitte POI-Daten oder Koordinaten eingeben';
    clipboardInput.focus();
    return;
  }

  let poiData = null;

  // Try parsing as POI JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      poiData = {
        x: parsed.x,
        y: parsed.y,
        label: parsed.label || '',
        color: parsed.color || POI_COLORS[0],
        category: parsed.category || ''
      };
    }
  } catch {}

  // Try parsing as SCUM coordinate string
  if (!poiData) {
    const m = text.match(/\{X=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)/);
    if (m) {
      poiData = {
        x: parseFloat(m[1]),
        y: parseFloat(m[2]),
        label: '',
        color: POI_COLORS[0],
        category: ''
      };
    }
  }

  if (!poiData) {
    statusEl.textContent = 'Eingabe enthält keine gültigen Koordinaten oder POI-Daten';
    clipboardInput.focus();
    return;
  }

  clipboardDialog.classList.remove('open');
  pendingPoi = { x: poiData.x, y: poiData.y };
  editingPoiId = null;
  poiDialogTitle.textContent = 'POI Import';
  poiLabelInput.value = poiData.label;
  selectedPoiColor = poiData.color;
  poiColorPicker.value = poiData.color;
  populatePoiCategorySelect(poiData.category, getSector(poiData.x, poiData.y));
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
  showPendingCrosshair(poiData.x, poiData.y);
  poiDialog.classList.add('open', 'top-left');
  poiLabelInput.focus();
  statusEl.textContent = `Importiert: X=${poiData.x.toFixed(0)} Y=${poiData.y.toFixed(0)}`;
});

document.getElementById('poiSave').addEventListener('click', async () => {
  const label = poiLabelInput.value.trim() || 'POI';
  const rawCategory = poiCategorySelect.value === '__new__' ? poiCategoryInput.value.trim() : poiCategorySelect.value;
  const category = rawCategory || (pendingPoi ? getSector(pendingPoi.x, pendingPoi.y) : '');
  if (editingPoiId) {
    data = await invoke('update_poi', { id: editingPoiId, label, color: selectedPoiColor, category });
  } else {
    if (!pendingPoi) return;
    const poi = {
      id: Date.now().toString(),
      label,
      x: pendingPoi.x,
      y: pendingPoi.y,
      type: 'general',
      color: selectedPoiColor,
      category
    };
    data = await invoke('add_poi', { poi });
  }
  updateUI();
  poiDialog.classList.remove('open', 'top-left');
  clearPendingCrosshair();
  pendingPoi = null;
  editingPoiId = null;
});

// Live tracking toggle
let isLiveTracking = false;
let trackingInterval = 10;
const liveTrackingBtn = document.getElementById('toggleLiveTracking');

function updateMarkerTransition() {
  const dur = Math.max(0.5, trackingInterval - 0.1);
  document.documentElement.style.setProperty('--marker-transition', `${dur}s linear`);
}

async function syncLiveTrackingState() {
  try {
    isLiveTracking = await invoke('is_live_tracking');
  } catch (err) {
    isLiveTracking = false;
  }
  if (liveTrackingBtn) {
    liveTrackingBtn.textContent = isLiveTracking ? 'Live-Tracking stoppen' : 'Live-Tracking starten';
  }
}

if (window.__TAURI__.event) {
  window.__TAURI__.event.listen('live-tracking-state', (e) => {
    isLiveTracking = !!e.payload;
    if (liveTrackingBtn) {
      liveTrackingBtn.textContent = isLiveTracking ? 'Live-Tracking stoppen' : 'Live-Tracking starten';
    }
  });
}

liveTrackingBtn.addEventListener('click', async () => {
  try {
    isLiveTracking = await invoke('toggle_live_tracking');
    liveTrackingBtn.textContent = isLiveTracking ? 'Live-Tracking stoppen' : 'Live-Tracking starten';
    if (isLiveTracking) {
      await checkScumStatus();
      if (scumRunning) {
        statusEl.textContent = 'Live-Tracking aktiv';
      } else {
        statusEl.textContent = 'Live-Tracking aktiv – aber SCUM nicht gestartet';
      }
    } else {
      statusEl.textContent = 'Live-Tracking pausiert';
    }
  } catch (err) {
    statusEl.textContent = 'Live-Tracking: ' + err;
  }
});

// Live-Map Overlay
const overlayBtn = document.getElementById('openOverlay');
overlayBtn.addEventListener('click', async () => {
  try {
    await invoke('open_overlay');
    statusEl.textContent = 'Overlay geöffnet';
  } catch (err) {
    statusEl.textContent = 'Overlay: ' + err;
  }
});

document.getElementById('closeOverlay').addEventListener('click', async () => {
  try {
    await invoke('close_overlay');
    statusEl.textContent = 'Overlay geschlossen';
  } catch (err) {
    statusEl.textContent = 'Overlay: ' + err;
  }
});

document.getElementById('copyLivemapUrl').addEventListener('click', async () => {
  try {
    await invoke('copy_livemap_url');
    statusEl.textContent = 'Live-Map-URL kopiert';
  } catch (err) {
    statusEl.textContent = 'URL: ' + err;
  }
});

document.getElementById('resetOverlayPosition').addEventListener('click', async () => {
  try {
    await invoke('reset_overlay_config');
    statusEl.textContent = 'Overlay-Position zurückgesetzt (neu öffnen, um zu sehen)';
  } catch (err) {
    statusEl.textContent = 'Overlay-Reset: ' + err;
  }
});

let overlayLocked = false;
const lockOverlayBtn = document.getElementById('lockOverlay');
lockOverlayBtn.addEventListener('click', async () => {
  try {
    overlayLocked = !overlayLocked;
    await invoke('set_overlay_clickthrough', { clickthrough: overlayLocked });
    lockOverlayBtn.innerHTML = overlayLocked ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
    lockOverlayBtn.title = overlayLocked ? 'Overlay entsperren' : 'Overlay sperren / Klick-durch';
    lockOverlayBtn.classList.toggle('locked', overlayLocked);
    lockOverlayBtn.classList.toggle('unlocked', !overlayLocked);
    statusEl.textContent = overlayLocked ? 'Overlay gesperrt (Klick-durch)' : 'Overlay entsperrt';
  } catch (err) {
    statusEl.textContent = 'Overlay-Lock: ' + err;
  }
});

if (toggleCoordsBtn) {
  toggleCoordsBtn.addEventListener('click', () => {
    showCoords = !showCoords;
    toggleCoordsBtn.classList.toggle('active', showCoords);
    statusEl.textContent = showCoords ? (currentCoord ? `Letzte Koordinate: X=${currentCoord.x.toFixed(0)} Y=${currentCoord.y.toFixed(0)}` : 'Bereit') : 'Koordinaten ausgeblendet';
  });
}

// Hi-Res Tiles Download
const downloadHiresBtn = document.getElementById('downloadHiresBtn');
const hiresStatus = document.getElementById('hiresStatus');
const hiresProgressBar = document.getElementById('hiresProgressBar');
const hiresProgressFill = document.getElementById('hiresProgressFill');

function setHiresProgress(percent) {
  hiresProgressBar.style.display = '';
  hiresProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function hideHiresProgress() {
  hiresProgressBar.style.display = 'none';
  hiresProgressFill.style.width = '0%';
}

async function checkHiresTiles() {
  try {
    const installed = await invoke('check_hires_tiles');
    if (installed) {
      hiresStatus.textContent = '✓ Hi-Res Tiles installiert';
      downloadHiresBtn.textContent = '✓ Hi-Res Tiles (installiert)';
      downloadHiresBtn.disabled = true;
      if (tileLayer) {
        tileLayer.options.maxNativeZoom = MAX_ZOOM;
        tileLayer.redraw();
      }
    } else {
      hiresStatus.textContent = 'Nur Zoom 0-3 verfügbar. Hi-Res für Zoom 4-6.';
    }
  } catch {}
}
checkHiresTiles();

downloadHiresBtn.addEventListener('click', async () => {
  downloadHiresBtn.disabled = true;
  downloadHiresBtn.textContent = 'Lädt...';
  setHiresProgress(0);
  try {
    await invoke('download_hires_tiles');
  } catch (err) {
    hiresStatus.textContent = 'Fehler: ' + err;
    hideHiresProgress();
    downloadHiresBtn.disabled = false;
    downloadHiresBtn.textContent = '⬇ Hi-Res Tiles';
  }
});

window.__TAURI__.event.listen('hires-download-progress', (event) => {
  const { phase, percent, text } = event.payload;
  hiresStatus.textContent = text;
  if (phase === 'download') {
    // Download is roughly the first half of the overall progress, extraction the second half.
    setHiresProgress(percent / 2);
  } else if (phase === 'extract') {
    setHiresProgress(50 + percent / 2);
  } else if (phase === 'done') {
    setHiresProgress(100);
  }
});

window.__TAURI__.event.listen('hires-tiles-installed', () => {
  hiresStatus.textContent = '✓ Hi-Res Tiles installiert! Karte neu laden für volle Auflösung.';
  hideHiresProgress();
  downloadHiresBtn.textContent = '✓ Hi-Res Tiles (installiert)';
  if (tileLayer) {
    tileLayer.options.maxNativeZoom = MAX_ZOOM;
    tileLayer.redraw();
  }
});

// SCUM status
let scumRunning = true;
async function checkScumStatus() {
  try {
    scumRunning = await invoke('is_scum_running');
  } catch { scumRunning = false; }
  updateScumStatus();
}

function updateScumStatus() {
  const scumStatusEl = document.getElementById('scumStatus');
  if (!scumStatusEl) return;
  if (scumRunning) {
    scumStatusEl.textContent = 'SCUM läuft';
    scumStatusEl.className = 'scum-status running';
  } else {
    scumStatusEl.textContent = 'SCUM nicht gestartet';
    scumStatusEl.className = 'scum-status not-running';
  }
}

// Manuelle SCUM-Fenster-Auswahl (Debug/Fallback für den Fall, dass die
// automatische Erkennung das falsche oder kein Fenster trifft)
const scumWindowPickerDialog = document.getElementById('scumWindowPickerDialog');
const scumWindowListEl = document.getElementById('scumWindowList');
const scumWindowPickerBtn = document.getElementById('scumWindowPickerBtn');
const scumWindowPickerAutoBtn = document.getElementById('scumWindowPickerAuto');
const scumWindowPickerCloseBtn = document.getElementById('scumWindowPickerClose');

async function openScumWindowPicker() {
  if (!scumWindowPickerDialog || !scumWindowListEl) return;
  scumWindowPickerDialog.classList.add('open');
  scumWindowListEl.innerHTML = '<p class="hint">Lade Fenster...</p>';
  let windows = [];
  let manualHwnd = null;
  let detected = null;
  try {
    [windows, manualHwnd, detected] = await Promise.all([
      invoke('list_visible_windows'),
      invoke('get_manual_scum_window'),
      invoke('get_scum_window_info'),
    ]);
  } catch (err) {
    scumWindowListEl.innerHTML = `<p class="hint">Fehler: ${escapeHtml(String(err))}</p>`;
    return;
  }
  const detectedHtml = detected
    ? `<p class="hint">Aktuell automatisch erkannt: <strong>${escapeHtml(detected.title)}</strong> (PID ${detected.pid}, ${escapeHtml(detected.process_name)})</p>`
    : '<p class="hint">Aktuell wird kein SCUM-Fenster automatisch erkannt.</p>';
  if (!windows.length) {
    scumWindowListEl.innerHTML = detectedHtml + '<p class="hint">Keine Fenster gefunden.</p>';
    return;
  }
  scumWindowListEl.innerHTML = detectedHtml + windows.map(w => {
    const isManual = manualHwnd === w.hwnd;
    const isDetected = !manualHwnd && detected && detected.hwnd === w.hwnd;
    const cls = isManual ? ' active' : (isDetected ? ' detected' : '');
    const badge = isManual ? ' <span class="window-picker-badge">manuell gewählt</span>' : (isDetected ? ' <span class="window-picker-badge">automatisch erkannt</span>' : '');
    return `
    <div class="window-picker-item${cls}" data-hwnd="${w.hwnd}">
      <span class="window-picker-title">${escapeHtml(w.title)}${badge}</span>
      <span class="window-picker-meta">PID ${w.pid} · ${escapeHtml(w.process_name)}</span>
    </div>
  `;
  }).join('');
  scumWindowListEl.querySelectorAll('.window-picker-item').forEach(el => {
    el.addEventListener('click', async () => {
      const hwnd = Number(el.dataset.hwnd);
      try {
        await invoke('set_manual_scum_window', { hwnd });
        showToast('SCUM-Fenster manuell gesetzt');
        scumWindowPickerDialog.classList.remove('open');
        checkScumStatus();
      } catch (err) {
        showToast('Fehler: ' + err);
      }
    });
  });
}

if (scumWindowPickerBtn) {
  scumWindowPickerBtn.addEventListener('click', openScumWindowPicker);
}
if (scumWindowPickerCloseBtn) {
  scumWindowPickerCloseBtn.addEventListener('click', () => {
    scumWindowPickerDialog.classList.remove('open');
  });
}
if (scumWindowPickerAutoBtn) {
  scumWindowPickerAutoBtn.addEventListener('click', async () => {
    try {
      await invoke('clear_manual_scum_window');
      showToast('Automatische SCUM-Erkennung aktiv');
      scumWindowPickerDialog.classList.remove('open');
      checkScumStatus();
    } catch (err) {
      showToast('Fehler: ' + err);
    }
  });
}

let toastTimer = null;
function showToast(msg) {
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// Live updates
if (window.__TAURI__.event) {
  window.__TAURI__.event.listen('scum-status', (event) => {
    scumRunning = event.payload;
    updateScumStatus();
    if (!scumRunning && isLiveTracking) {
      statusEl.textContent = 'SCUM nicht gestartet – Live-Tracking pausiert';
    }
  });

  window.__TAURI__.event.listen('tracking-error', (event) => {
    statusEl.textContent = event.payload;
    showToast(event.payload);
  });


  window.__TAURI__.event.listen('data-updated', (event) => {
    data = event.payload;
    if (!data.routes) data.routes = [];
    if (!data.pois) data.pois = [];
    if (!data.hidden_categories) data.hidden_categories = [];
    syncHiddenPoiCategories();
    updateUI();
  });

  window.__TAURI__.event.listen('poi-connections', (event) => {
    let ids = event.payload;
    if (Array.isArray(ids) && ids.length >= 2 && typeof ids[0] === 'string') {
      ids = ids[1];
    }
    if (Array.isArray(ids)) {
      connectedPoiIds = new Set(ids);
      updateConnectionLines();
      updateUI();
    }
  });

  window.__TAURI__.event.listen('hotkey-poi-created', (event) => {
    statusEl.textContent = 'POI per F9 erstellt: ' + event.payload;
    showToast('📍 POI erstellt + Screenshot gespeichert!');
  });

  window.__TAURI__.event.listen('coord-update', (event) => {
    currentCoord = event.payload;
    const route = getCurrentRoute();
    if (route && isRecording) {
      route.records.push(event.payload);
    }
    let statusText = showCoords ? `Letzte Koordinate: X=${event.payload.x.toFixed(0)} Y=${event.payload.y.toFixed(0)}` : 'Bereit';
    if (showCoords && navTarget && currentCoord && navRemaining && navRemaining.length >= 2) {
      let remaining = 0;
      for (let i = 1; i < navRemaining.length; i++) {
        const dx = navRemaining[i].x - navRemaining[i - 1].x;
        const dy = navRemaining[i].y - navRemaining[i - 1].y;
        remaining += Math.sqrt(dx * dx + dy * dy);
      }
      const km = (remaining / 100000).toFixed(2);
      statusText += ` · Ziel: ${km} km`;
    } else if (showCoords && navTarget && currentCoord) {
      const dx = navTarget.x - currentCoord.x;
      const dy = navTarget.y - currentCoord.y;
      const km = (Math.sqrt(dx * dx + dy * dy) / 100000).toFixed(2);
      statusText += ` · Ziel: ${km} km (Luftlinie)`;
    }
    statusEl.textContent = statusText;
    const ll = gameToLatLng(currentCoord.x, currentCoord.y);
    updateLiveMarker(ll);
    updateConnectionLines();
    if (navPendingRoute && navTarget) {
      navPendingRoute = false;
      updateNavRoute();
    } else if (navTarget && navMode === 'nav') {
      updateNavRoute();
    }
    if (followEnabled) {
      map.panTo(ll, { animate: true, duration: 0.8 });
    }
  });
}

async function exportData(format) {
  try {
    const path = await invoke('export_data', { format });
    statusEl.textContent = `${format.toUpperCase()} exportiert: ${path}`;
  } catch (err) {
    if (String(err) !== 'Export abgebrochen') {
      statusEl.textContent = 'Export fehlgeschlagen: ' + err;
    }
  }
}

document.getElementById('exportJson').addEventListener('click', () => exportData('json'));
document.getElementById('exportCsv').addEventListener('click', () => exportData('csv'));

let sidebarState = { livemap_collapsed: false, routes_collapsed: false, pois_collapsed: false };

function applyCollapsedState(headerId, bodyId, collapsed) {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  if (!header || !body) return;
  header.classList.toggle('collapsed', collapsed);
  body.classList.toggle('collapsed', collapsed);
}

function setupCollapsibleSection(headerId, bodyId, stateField) {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  if (!header || !body) return;
  header.addEventListener('click', () => {
    const isCollapsed = header.classList.toggle('collapsed');
    body.classList.toggle('collapsed', isCollapsed);
    sidebarState[stateField] = isCollapsed;
    invoke('save_sidebar_state', { state: sidebarState }).catch(() => {});
  });
}

async function initSidebarState() {
  try {
    sidebarState = await invoke('get_sidebar_state');
  } catch {
    sidebarState = { livemap_collapsed: false, routes_collapsed: false, pois_collapsed: false };
  }
  applyCollapsedState('livemapSectionHeader', 'livemapSectionBody', sidebarState.livemap_collapsed);
  applyCollapsedState('routesSectionHeader', 'routesSectionBody', sidebarState.routes_collapsed);
  applyCollapsedState('poisSectionHeader', 'poisSectionBody', sidebarState.pois_collapsed);
}

setupCollapsibleSection('livemapSectionHeader', 'livemapSectionBody', 'livemap_collapsed');
setupCollapsibleSection('routesSectionHeader', 'routesSectionBody', 'routes_collapsed');
setupCollapsibleSection('poisSectionHeader', 'poisSectionBody', 'pois_collapsed');
initSidebarState();

loadData();
checkScumStatus();
checkVersion();

async function checkVersion() {
  try {
    const version = await invoke('get_version');
    if (versionBadge) versionBadge.textContent = 'v' + version;
    const update = await invoke('check_update');
    if (update && updateLink) {
      updateLink.textContent = 'Update ' + update.latest_version + ' verfügbar';
      updateLink.style.display = 'block';
      updateLink.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!update.is_windows) {
          await invoke('open_url', { url: 'https://github.com/HellBz/SCUM-Walker/releases/latest' });
          return;
        }
        updateLink.textContent = 'Lade Update...';
        updateLink.style.pointerEvents = 'none';
        try {
          await invoke('install_update');
        } catch (err) {
          updateLink.textContent = 'Update fehlgeschlagen';
          statusEl.textContent = 'Update-Fehler: ' + err;
          setTimeout(() => {
            updateLink.textContent = 'Update ' + update.latest_version + ' verfügbar';
            updateLink.style.pointerEvents = '';
          }, 3000);
        }
      });
    }
  } catch {}
}

// === Navigation integration ===
let navLayer = null;
let navTarget = null;
let navEndMarker = null;
let navStartMarker = null;
let navRouteStart = null;
let navVisible = false;
let navMode = 'nav';
let navFollow = false;
let navRemaining = null;
let navTotalDist = 0;
let navPendingRoute = false;

const navPanel = document.getElementById('navPanel');
const navStartEl = document.getElementById('navStart');
const navEndEl = document.getElementById('navEnd');
const navInfoEl = document.getElementById('navInfo');
const navProgressEl = document.getElementById('navProgress');
const navCalcBtn = document.getElementById('navCalcBtn');
const navClearBtn = document.getElementById('navClearBtn');
const navFollowBtn = document.getElementById('navFollowBtn');
const navModeRoute = document.getElementById('navModeRoute');
const navModeNav = document.getElementById('navModeNav');
const navStartRow = document.getElementById('navStartRow');
const navColorPicker = document.getElementById('navColorPicker');
const navColorReset = document.getElementById('navColorReset');
const DEFAULT_NAV_COLOR = '#00ffcc';
let navRouteColor = DEFAULT_NAV_COLOR;

function applyNavRouteColor(color) {
  navRouteColor = color.toLowerCase();
  if (navColorPicker) navColorPicker.value = navRouteColor;
  if (navLayer) navLayer.setStyle({ color: navRouteColor });
}

(async () => {
  try {
    const color = await window.__TAURI__.core.invoke('get_nav_route_color');
    if (color) applyNavRouteColor(color);
  } catch (e) {
    console.error('[nav] failed to load route color', e);
  }
})();

if (navColorPicker) {
  navColorPicker.addEventListener('input', async (e) => {
    const color = e.target.value;
    applyNavRouteColor(color);
    try {
      await window.__TAURI__.core.invoke('set_nav_route_color', { color: color.toLowerCase() });
    } catch (err) {
      console.error('[nav] set route color failed', err);
    }
  });
}
if (navColorReset) {
  navColorReset.addEventListener('click', async () => {
    applyNavRouteColor(DEFAULT_NAV_COLOR);
    try {
      await window.__TAURI__.core.invoke('set_nav_route_color', { color: DEFAULT_NAV_COLOR });
    } catch (err) {
      console.error('[nav] reset route color failed', err);
    }
  });
}

if (window.__TAURI__.event) {
  window.__TAURI__.event.listen('nav-route-color', (e) => {
    const color = (e.payload || DEFAULT_NAV_COLOR).toString();
    applyNavRouteColor(color);
  });
}

document.getElementById('mapNavBtn').addEventListener('click', () => {
  navMode = 'nav';
  navModeNav.classList.add('active');
  navModeRoute.classList.remove('active');
  if (navStartRow) navStartRow.classList.add('hidden');
  if (navCalcBtn) navCalcBtn.textContent = 'Route neu berechnen';
  navVisible = !navVisible;
  document.getElementById('mapNavBtn').classList.toggle('active', navVisible);
  if (navPanel) navPanel.classList.toggle('visible', navVisible);
  if (!navVisible) clearNavRoute();
});

document.getElementById('mapRouteBtn').addEventListener('click', () => {
  navMode = 'route';
  navModeRoute.classList.add('active');
  navModeNav.classList.remove('active');
  if (navStartRow) navStartRow.classList.remove('hidden');
  if (navCalcBtn) navCalcBtn.textContent = 'Route berechnen';
  navVisible = !navVisible;
  document.getElementById('mapRouteBtn').classList.toggle('active', navVisible);
  if (navPanel) navPanel.classList.toggle('visible', navVisible);
  if (!navVisible) clearNavRoute();
});

if (navModeRoute) {
  navModeRoute.addEventListener('click', () => {
    navMode = 'route';
    navModeRoute.classList.add('active');
    navModeNav.classList.remove('active');
    if (navStartRow) navStartRow.classList.remove('hidden');
    if (navCalcBtn) navCalcBtn.textContent = 'Route berechnen';
    clearNavRoute();
  });
}
if (navModeNav) {
  navModeNav.addEventListener('click', () => {
    navMode = 'nav';
    navModeNav.classList.add('active');
    navModeRoute.classList.remove('active');
    if (navStartRow) navStartRow.classList.add('hidden');
    if (navCalcBtn) navCalcBtn.textContent = 'Route neu berechnen';
    clearNavRoute();
  });
}
if (navCalcBtn) {
  navCalcBtn.addEventListener('click', () => {
    if (navMode === 'nav') {
      updateNavRoute();
    } else {
      calcRouteFromPoints();
    }
  });
}
if (navClearBtn) {
  navClearBtn.addEventListener('click', clearNavRoute);
}

map.on('contextmenu', (e) => {
  if (!navVisible) return;
  if (navMode === 'route') {
    if (!navRouteStart) { setNavPoint(e.latlng, true); }
    else if (!navTarget) { setNavPoint(e.latlng, false); }
    else { clearNavRoute(); setNavPoint(e.latlng, true); }
  } else {
    const g = latLngToGame(e.latlng.lat, e.latlng.lng);
    setNavTarget(g.x, g.y);
  }
});

function setNavPoint(latlng, isStart) {
  const g = latLngToGame(latlng.lat, latlng.lng);
  const label = `X=${g.x.toFixed(0)} Y=${g.y.toFixed(0)}`;
  if (isStart) {
    if (navStartMarker) map.removeLayer(navStartMarker);
    navRouteStart = latlng;
    navStartMarker = L.marker(latlng, {
      icon: L.divIcon({ className: 'nav-marker-start', iconSize: [14, 14], iconAnchor: [7, 7] }),
    }).addTo(map);
    if (navStartEl) navStartEl.textContent = label;
  } else {
    setNavTarget(g.x, g.y);
  }
}

function calcRouteFromPoints() {
  if (!navRouteStart || !navTarget) {
    showToast('Start und Ziel per Rechtsklick setzen.');
    return;
  }
  const sg = latLngToGame(navRouteStart.lat, navRouteStart.lng);
  const route = RoadNavigator.findRoute(sg.x, sg.y);
  drawNavRoute(route);
}

function updateNavProgress() {
  if (!navRemaining || navRemaining.length < 2 || !navProgressEl) {
    if (navProgressEl) navProgressEl.innerHTML = '';
    return;
  }
  let remainingDist = 0;
  for (let i = 1; i < navRemaining.length; i++) {
    const dx = navRemaining[i].x - navRemaining[i - 1].x;
    const dy = navRemaining[i].y - navRemaining[i - 1].y;
    remainingDist += Math.sqrt(dx * dx + dy * dy);
  }
  const remKm = (remainingDist / 100000).toFixed(2);
  const totalKm = (navTotalDist / 100000).toFixed(2);
  const pct = navTotalDist > 0 ? Math.round((1 - remainingDist / navTotalDist) * 100) : 0;
  navProgressEl.innerHTML = `Fortschritt: <span class="done">${pct}%</span> · Rest: <span class="dist">${remKm} km</span> / ${totalKm} km`;
}

function drawNavRoute(route) {
  if (!route || route.length < 2) {
    if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
    if (navInfoEl) navInfoEl.innerHTML = '<span style="color:#e45858">Keine Route gefunden!</span>';
    return;
  }
  const latlngs = route.map(r => gameToLatLng(r.x, r.y));
  if (navLayer) {
    navLayer.setLatLngs(latlngs);
    navLayer.setStyle({ color: navRouteColor });
  } else {
    navLayer = L.polyline(latlngs, {
      color: navRouteColor,
      weight: 5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
  }
  navRemaining = route;
  let totalDist = 0;
  for (let i = 1; i < route.length; i++) {
    const dx = route[i].x - route[i - 1].x;
    const dy = route[i].y - route[i - 1].y;
    totalDist += Math.sqrt(dx * dx + dy * dy);
  }
  navTotalDist = totalDist;
  const km = (totalDist / 100000).toFixed(2);
  if (navInfoEl) navInfoEl.innerHTML = `Route: ca. <span class="dist">${km} km</span>`;
  updateNavProgress();
}

function trimNavRoute() {
  if (!navRemaining || navRemaining.length < 2 || !currentCoord) return;
  const snapThreshold = 50000; // 500m in game units (cm)
  const snapSq = snapThreshold * snapThreshold;
  let bestIdx = -1;
  for (let i = 0; i < navRemaining.length; i++) {
    const dx = navRemaining[i].x - currentCoord.x;
    const dy = navRemaining[i].y - currentCoord.y;
    if (dx * dx + dy * dy < snapSq) { bestIdx = i; break; }
  }
  if (bestIdx < 0) return;
  if (bestIdx === navRemaining.length - 1) {
    if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
    navRemaining = null;
    if (navProgressEl) navProgressEl.innerHTML = '<span class="done">Ziel erreicht!</span>';
    return;
  }
  navRemaining = navRemaining.slice(bestIdx);
  const latlngs = navRemaining.map(r => gameToLatLng(r.x, r.y));
  if (navLayer) {
    navLayer.setLatLngs(latlngs);
  } else {
    navLayer = L.polyline(latlngs, {
      color: navRouteColor, weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
    }).addTo(map);
  }
  updateNavProgress();
}

function needsReroute() {
  if (!navRemaining || navRemaining.length < 2 || !currentCoord) return false;
  const maxDist = 50000; // 500m deviation threshold
  const maxSq = maxDist * maxDist;
  let minSq = Infinity;
  for (let i = 0; i < navRemaining.length; i++) {
    const dx = navRemaining[i].x - currentCoord.x;
    const dy = navRemaining[i].y - currentCoord.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < minSq) minSq = distSq;
  }
  return minSq > maxSq;
}

// WebSocket for nav sync (like road editor / livemap)
let navWs = null;
function connectNavWs() {
  const port = window.__WS_PORT__ || '4488';
  try {
    navWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  } catch (e) { return; }
  navWs.onopen = () => { navWs.send(JSON.stringify({ type: 'login' })); };
  navWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const type = msg[0];
      const data = msg[1];
      if (type === 'nav-target') {
        if (data && typeof data.x === 'number' && typeof data.y === 'number') {
          setNavTarget(data.x, data.y, true);
        }
      } else if (type === 'nav-cleared') {
        clearNavRoute(true);
      }
    } catch (e) {}
  };
  navWs.onclose = () => { setTimeout(connectNavWs, 5000); };
}

async function initNavigation() {
  try {
    const port = window.__WS_PORT__ || '4488';
    const url = `http://127.0.0.1:${port}/roads.json`;
    await RoadNavigator.init({ urls: [url] });
    if (!RoadNavigator.graph) return;
    connectNavWs();
    const savedTarget = await invoke('get_nav_target');
    if (savedTarget && typeof savedTarget.x === 'number' && typeof savedTarget.y === 'number') {
      await setNavTarget(savedTarget.x, savedTarget.y, true);
    }
  } catch (err) {
    console.warn('[nav] Fehler beim Laden:', err);
  }
}

function updateNavRoute() {
  if (!RoadNavigator.graph || !navTarget || !currentCoord) {
    if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
    return;
  }
  const route = RoadNavigator.findRoute(currentCoord.x, currentCoord.y);
  drawNavRoute(route);
}

async function setNavTarget(x, y, fromRemote) {
  navTarget = { x, y };
  RoadNavigator.setTarget(x, y);
  if (navEndMarker) map.removeLayer(navEndMarker);
  const ll = gameToLatLng(x, y);
  navEndMarker = L.marker(ll, {
    icon: L.divIcon({ className: 'nav-marker-end', iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: true,
  }).addTo(map);
  navEndMarker.on('click', () => clearNavRoute());
  if (navEndEl) navEndEl.textContent = `X=${x.toFixed(0)} Y=${y.toFixed(0)}`;
  if (!fromRemote) {
    try { await invoke('set_nav_target', { x, y }); } catch (e) { console.warn('[nav] set_nav_target fehlgeschlagen:', e); }
  }
  if (!currentCoord) {
    try { await syncPlayerPosition(); } catch (e) {}
  }
  if (currentCoord) {
    navPendingRoute = false;
    updateNavRoute();
  } else {
    navPendingRoute = true;
  }
}

function clearNavRoute(fromRemote) {
  if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
  if (navStartMarker) { map.removeLayer(navStartMarker); navStartMarker = null; }
  if (navEndMarker) { map.removeLayer(navEndMarker); navEndMarker = null; }
  navTarget = null;
  navRouteStart = null;
  navRemaining = null;
  navTotalDist = 0;
  if (navStartEl) navStartEl.textContent = '– Rechtsklick setzen';
  if (navEndEl) navEndEl.textContent = '– Rechtsklick setzen';
  if (navInfoEl) navInfoEl.innerHTML = '';
  if (navProgressEl) navProgressEl.innerHTML = '';
  if (!fromRemote) invoke('clear_nav_target');
}

// === Settings panel ===
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel = document.getElementById('settingsPanel');
const settingsClose = document.getElementById('settingsClose');
const settingsTrackingInterval = document.getElementById('settingsTrackingInterval');
const settingsAutoStartTracking = document.getElementById('settingsAutoStartTracking');
const settingsAutoOpenOverlay = document.getElementById('settingsAutoOpenOverlay');
const settingsAutoLockOverlay = document.getElementById('settingsAutoLockOverlay');
const settingsPoiHotkey = document.getElementById('settingsPoiHotkey');
const settingsBigmapHotkey = document.getElementById('settingsBigmapHotkey');
const settingsRecenterHotkey = document.getElementById('settingsRecenterHotkey');
const settingsNavRouteColor = document.getElementById('settingsNavRouteColor');
const settingsAutoPoiColor = document.getElementById('settingsAutoPoiColor');
const settingsAutoPoiUseSector = document.getElementById('settingsAutoPoiUseSector');
const settingsAutoPoiCategory = document.getElementById('settingsAutoPoiCategory');
const settingsAutoPoiPrefix = document.getElementById('settingsAutoPoiPrefix');
const settingsSave = document.getElementById('settingsSave');
const settingsSaveStatus = document.getElementById('settingsSaveStatus');

let recordingTarget = null;
let lastChangedHotkeyId = null;

function keyFromEvent(e) {
  // For letter/digit keys the physical code is more reliable than e.key,
  // especially for AltGr combinations on German keyboards (e.g. AltGr+M -> µ).
  if (e.code && e.code.startsWith('Key')) return e.code.slice(3).toUpperCase();
  if (e.code && e.code.startsWith('Digit')) return e.code.slice(5);
  const fMatch = e.code && e.code.match(/^F(1[0-9]?|2[0-4]?|[1-9])$/);
  if (fMatch) return e.code;

  const ignore = ['Control', 'Alt', 'Shift', 'AltGraph', 'Meta', 'OS'];
  let key = e.key;
  if (!key || ignore.includes(key)) return null;
  if (key.length === 1) key = key.toUpperCase();
  return key;
}

function formatHotkey(e) {
  const parts = [];
  const isAltGr = e.getModifierState && e.getModifierState('AltGraph');
  if (isAltGr) {
    parts.push('AltGr');
  } else {
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
  }
  if (e.shiftKey) parts.push('Shift');

  const key = keyFromEvent(e);
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

function startRecording(input) {
  recordingTarget = input;
  input.value = 'Taste drücken...';
  input.classList.add('recording');
}

function stopRecording() {
  if (!recordingTarget) return;
  recordingTarget.classList.remove('recording');
  recordingTarget = null;
}

function validateHotkeys() {
  const inputs = [settingsPoiHotkey, settingsBigmapHotkey, settingsRecenterHotkey].filter(Boolean);
  const counts = {};
  inputs.forEach((input) => {
    const v = (input.value || '').toUpperCase();
    if (v) counts[v] = (counts[v] || 0) + 1;
  });
  let hasDuplicate = false;
  inputs.forEach((input) => {
    input.classList.remove('hotkey-duplicate', 'hotkey-other-duplicate');
    const v = (input.value || '').toUpperCase();
    if (v && counts[v] > 1) {
      if (lastChangedHotkeyId && input.id !== lastChangedHotkeyId) {
        input.classList.add('hotkey-other-duplicate');
      } else {
        input.classList.add('hotkey-duplicate');
      }
      hasDuplicate = true;
    }
  });
  if (settingsSave) settingsSave.disabled = hasDuplicate;
  if (settingsSaveStatus) {
    settingsSaveStatus.textContent = hasDuplicate ? 'Hotkeys müssen eindeutig sein' : '';
  }
}

window.addEventListener('keydown', (e) => {
  if (!recordingTarget) return;
  e.preventDefault();
  e.stopPropagation();
  const combo = formatHotkey(e);
  if (combo) {
    recordingTarget.value = combo;
    lastChangedHotkeyId = recordingTarget.id;
    stopRecording();
    validateHotkeys();
  }
}, true);

['settingsRecordPoiHotkey', 'settingsRecordBigmapHotkey', 'settingsRecordRecenterHotkey'].forEach((btnId, idx) => {
  const btn = document.getElementById(btnId);
  const input = [settingsPoiHotkey, settingsBigmapHotkey, settingsRecenterHotkey][idx];
  if (btn && input) {
    btn.addEventListener('click', () => startRecording(input));
  }
});

function toggleSettingsPanel(show) {
  if (settingsPanel) settingsPanel.classList.toggle('visible', show);
}
if (settingsToggle && settingsPanel) settingsToggle.addEventListener('click', () => toggleSettingsPanel(!settingsPanel.classList.contains('visible')));
if (settingsClose) settingsClose.addEventListener('click', () => toggleSettingsPanel(false));

async function loadSettings() {
  try {
    const s = await invoke('get_settings');
    if (settingsTrackingInterval) settingsTrackingInterval.value = s.tracking_interval;
    if (settingsAutoStartTracking) settingsAutoStartTracking.checked = s.auto_start_live_tracking;
    if (settingsAutoOpenOverlay) settingsAutoOpenOverlay.checked = s.auto_open_overlay;
    if (settingsAutoLockOverlay) settingsAutoLockOverlay.checked = s.auto_lock_overlay;
    if (settingsPoiHotkey) settingsPoiHotkey.value = s.poi_hotkey;
    if (settingsBigmapHotkey) settingsBigmapHotkey.value = s.bigmap_hotkey;
    if (settingsRecenterHotkey) settingsRecenterHotkey.value = s.bigmap_recenter_hotkey;
    if (settingsNavRouteColor) settingsNavRouteColor.value = s.nav_route_color;
    if (settingsAutoPoiColor) settingsAutoPoiColor.value = s.auto_poi_color;
    if (settingsAutoPoiUseSector) settingsAutoPoiUseSector.checked = s.auto_poi_use_sector_category;
    if (settingsAutoPoiCategory) settingsAutoPoiCategory.value = s.auto_poi_category || '';
    if (settingsAutoPoiPrefix) settingsAutoPoiPrefix.value = s.auto_poi_name_prefix;
    if (navColorPicker) navColorPicker.value = s.nav_route_color;
    trackingInterval = s.tracking_interval || 10;
    updateMarkerTransition();
    validateHotkeys();
  } catch (err) {
    console.error('[settings] load failed', err);
  }
}

async function saveSettings() {
  try {
    let interval = parseInt(settingsTrackingInterval?.value || '10', 10);
    if (isNaN(interval) || interval < 1) interval = 1;
    if (interval > 300) interval = 300;
    const payload = {
      tracking_interval: interval,
      auto_start_live_tracking: settingsAutoStartTracking?.checked || false,
      auto_open_overlay: settingsAutoOpenOverlay?.checked || false,
      auto_lock_overlay: settingsAutoLockOverlay?.checked || false,
      poi_hotkey: settingsPoiHotkey?.value || 'F9',
      bigmap_hotkey: settingsBigmapHotkey?.value || 'AltGr+M',
      bigmap_recenter_hotkey: settingsRecenterHotkey?.value || 'AltGr+N',
      nav_route_color: settingsNavRouteColor?.value || '#00ffcc',
      auto_poi_color: settingsAutoPoiColor?.value || '#ff8800',
      auto_poi_use_sector_category: settingsAutoPoiUseSector?.checked ?? true,
      auto_poi_category: settingsAutoPoiCategory?.value || '',
      auto_poi_name_prefix: settingsAutoPoiPrefix?.value || 'POI',
    };
    const saved = await invoke('save_settings', { settings: payload });
    trackingInterval = saved.tracking_interval;
    updateMarkerTransition();
    if (navColorPicker) navColorPicker.value = saved.nav_route_color;
    navRouteColor = saved.nav_route_color;
    if (navLayer) updateNavRoute();
    if (settingsSaveStatus) {
      settingsSaveStatus.textContent = 'Gespeichert';
      setTimeout(() => { settingsSaveStatus.textContent = ''; }, 2000);
    }
  } catch (err) {
    console.error('[settings] save failed', err);
    const msg = err?.message || err?.toString?.() || 'Fehler';
    if (settingsSaveStatus) settingsSaveStatus.textContent = msg;
  }
}
if (settingsSave) settingsSave.addEventListener('click', saveSettings);

function resetColorInput(input) {
  if (!input) return;
  input.value = input.dataset.default || input.value;
}

document.getElementById('settingsResetNavRouteColor')?.addEventListener('click', () => resetColorInput(settingsNavRouteColor));
document.getElementById('settingsResetAutoPoiColor')?.addEventListener('click', () => resetColorInput(settingsAutoPoiColor));

loadSettings();

initNavigation();

window.__TAURI__.event.listen('nav-target', (event) => {
  const t = event.payload;
  if (t && typeof t.x === 'number' && typeof t.y === 'number') {
    setNavTarget(t.x, t.y, true);
  }
});

window.__TAURI__.event.listen('nav-cleared', () => {
  clearNavRoute(true);
});
