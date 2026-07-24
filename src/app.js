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

const ROUTE_COLORS = ['#00ffcc', '#ff8800', '#4488ff', '#ff44d3', '#ffee00', '#44cc44', '#ff4444', '#ffffff'];
const POI_COLORS = ['#ff44d3', '#ff8800', '#44cc44', '#4488ff', '#ffee00', '#ff4444', '#ffffff'];
let selectedRouteColor = ROUTE_COLORS[0];
let selectedPoiColor = POI_COLORS[0];
let pendingPoi = null;
let editingPoiId = null;

let data = { routes: [], current_route_id: null, pois: [] };
let isRecording = false;
let currentCoord = null;

// World bounds in SCUM game coordinates (default, overridden by /api/bounds)
let worldMinX = -904800;
let worldMaxX = 619318;
let worldMinY = -904800;
let worldMaxY = 618818;
let worldWidth = worldMaxX - worldMinX;
let worldHeight = worldMaxY - worldMinY;

// Fetch live bounds from HTTP server
async function fetchBounds() {
  try {
    const url = await invoke('get_livemap_url');
    if (url) {
      const base = new URL(url);
      const r = await fetch(`${base.protocol}//${base.host}/api/bounds`);
      const b = await r.json();
      worldMinX = b.min_x; worldMaxX = b.max_x;
      worldMinY = b.min_y; worldMaxY = b.max_y;
      worldWidth = worldMaxX - worldMinX;
      worldHeight = worldMaxY - worldMinY;
    }
  } catch {}
}

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

// Get HTTP server base URL for tiles
let tileBaseUrl = 'http://127.0.0.1:4488';
async function fetchTileBaseUrl() {
  try {
    const url = await invoke('get_livemap_url');
    if (url) {
      const u = new URL(url);
      tileBaseUrl = `${u.protocol}//${u.host}`;
      const livemapUrlInput = document.getElementById('livemapUrl');
      if (livemapUrlInput) livemapUrlInput.value = url;
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
  await fetchTileBaseUrl();
  await fetchBounds();
  setInterval(fetchBounds, 2000);
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
      map.setView(ll, map.getZoom());
    }
  });
}

document.getElementById('mapCenterBtn').addEventListener('click', () => {
  if (currentCoord) {
    const ll = gameToLatLng(currentCoord.x, currentCoord.y);
    map.panTo(ll);
  }
});

document.getElementById('mapFitBtn').addEventListener('click', () => {
  followEnabled = false;
  if (mapFollowBtn) mapFollowBtn.style.background = '';
  map.fitBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);
});

// Leaflet layers for routes, POIs, live marker
let routeLayers = {};
let routeEndMarkers = {};
let poiMarkers = [];
let liveMarker = null;
let liveArrow = null;
let livePulse = null;

function clearRoutes() {
  Object.values(routeLayers).forEach(l => map.removeLayer(l));
  Object.values(routeEndMarkers).forEach(m => map.removeLayer(m));
  routeLayers = {};
  routeEndMarkers = {};
}

function clearPois() {
  poiMarkers.forEach(m => map.removeLayer(m));
  poiMarkers = [];
}

function clearLiveMarker() {
  if (liveMarker) { map.removeLayer(liveMarker); liveMarker = null; }
  if (liveArrow) { map.removeLayer(liveArrow); liveArrow = null; }
  if (livePulse) { map.removeLayer(livePulse); livePulse = null; }
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

function renderPois() {
  clearPois();
  data.pois.forEach(poi => {
    const ll = gameToLatLng(poi.x, poi.y);
    const marker = L.circleMarker(ll, {
      radius: 6,
      fillColor: poi.color,
      color: '#fff',
      weight: 1,
      fillOpacity: 1,
    }).addTo(map);
    if (poi.label) marker.bindTooltip(poi.label, { permanent: true, direction: 'top', className: 'poi-label', offset: [0, -8] });
    poiMarkers.push(marker);
  });
}

function renderLiveMarker() {
  clearLiveMarker();
  if (!currentCoord) return;
  const ll = gameToLatLng(currentCoord.x, currentCoord.y);

  let html = '<div class="live-marker"><div class="live-marker-dot"></div>';
  if (typeof currentCoord.yaw === 'number') {
    html += `<div class="live-marker-arrow" style="transform: translate(-50%, -50%) rotate(${currentCoord.yaw - 90}deg) translateY(-20px)"></div>`;
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
  }).addTo(map);
}

function renderMap() {
  renderRoutes();
  renderPois();
  renderLiveMarker();
}

function getCurrentRoute() {
  return data.routes.find(r => r.id === data.current_route_id);
}

async function loadData() {
  try {
    data = await invoke('get_data');
    if (!data.routes) data.routes = [];
    if (!data.pois) data.pois = [];
    await syncRecordingState();
    await syncLiveTrackingState();
    updateUI();
  } catch (err) {
    statusEl.textContent = 'Fehler beim Laden: ' + err;
  }
}

function updateUI() {
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
        <button class="route-icon ${recordingHere ? 'recording' : ''}" data-action="record" data-id="${route.id}" title="${recordingHere ? 'Aufzeichnung stoppen' : 'Aufzeichnung starten'}">${recordingHere ? '■' : '●'}</button>
        <button class="route-icon ${visible ? '' : 'hidden'}" data-action="toggle-visibility" data-id="${route.id}" title="${visible ? 'Auf Karte ausblenden' : 'Auf Karte einblenden'}">${visible ? '◉' : '○'}</button>
        <button class="route-icon" data-action="rename" data-id="${route.id}" title="Umbenennen">✎</button>
        <button class="route-icon" data-action="delete" data-id="${route.id}" title="Löschen">🗑</button>
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
  poiListEl.innerHTML = '';
  if (data.pois.length === 0) {
    poiListEl.innerHTML = '<p class="empty">Keine POIs</p>';
    return;
  }
  data.pois.forEach(poi => {
    const hasImage = !!poi.image_path;
    const div = document.createElement('div');
    div.className = 'poi-item';
    div.innerHTML = `<span><span class="poi-color" style="background:${poi.color}"></span>${escapeHtml(poi.label)}</span>
                     <span class="poi-actions">
                       <button class="poi-edit" data-id="${poi.id}" title="POI bearbeiten">✎</button>
                       <button class="poi-image-btn" data-id="${poi.id}" title="${hasImage ? 'Bild anzeigen' : 'Bild einfügen'}">🖼</button>
                       <button class="poi-delete" data-id="${poi.id}" title="POI löschen">🗑</button>
                     </span>`;
    poiListEl.appendChild(div);
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

  poiListEl.querySelectorAll('.poi-delete').forEach(el => {
    el.addEventListener('click', async () => {
      data = await invoke('remove_poi', { id: el.dataset.id });
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
  poiLabelInput.value = '';
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
  poiDialog.classList.add('open');
  poiLabelInput.focus();
});

poiColorPicker.addEventListener('input', (e) => {
  selectedPoiColor = e.target.value.toLowerCase();
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
});

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
  poiDialog.classList.remove('open');
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
    buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
    poiDialog.classList.add('open');
    poiLabelInput.focus();
    statusEl.textContent = `Position: X=${record.x.toFixed(0)} Y=${record.y.toFixed(0)}`;
  } catch (err) {
    statusEl.textContent = 'Fehler: ' + err;
  }
});

document.getElementById('poiSave').addEventListener('click', async () => {
  const label = poiLabelInput.value.trim() || 'POI';
  if (editingPoiId) {
    data = await invoke('update_poi', { id: editingPoiId, label, color: selectedPoiColor });
  } else {
    if (!pendingPoi) return;
    const poi = {
      id: Date.now().toString(),
      label,
      x: pendingPoi.x,
      y: pendingPoi.y,
      type: 'general',
      color: selectedPoiColor
    };
    data = await invoke('add_poi', { poi });
  }
  updateUI();
  poiDialog.classList.remove('open');
  pendingPoi = null;
  editingPoiId = null;
});

// Live tracking toggle
let isLiveTracking = false;
const liveTrackingBtn = document.getElementById('toggleLiveTracking');

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
    lockOverlayBtn.textContent = overlayLocked ? '🔓' : '🔒';
    lockOverlayBtn.title = overlayLocked ? 'Overlay entsperren' : 'Overlay sperren / Klick-durch';
    statusEl.textContent = overlayLocked ? 'Overlay gesperrt (Klick-durch)' : 'Overlay entsperrt';
  } catch (err) {
    statusEl.textContent = 'Overlay-Lock: ' + err;
  }
});

// Hi-Res Tiles Download
const downloadHiresBtn = document.getElementById('downloadHiresBtn');
const hiresStatus = document.getElementById('hiresStatus');

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
  try {
    await invoke('download_hires_tiles');
  } catch (err) {
    hiresStatus.textContent = 'Fehler: ' + err;
    downloadHiresBtn.disabled = false;
    downloadHiresBtn.textContent = '⬇ Hi-Res Tiles';
  }
});

window.__TAURI__.event.listen('hires-download-progress', (event) => {
  hiresStatus.textContent = event.payload;
});

window.__TAURI__.event.listen('hires-tiles-installed', () => {
  hiresStatus.textContent = '✓ Hi-Res Tiles installiert! Karte neu laden für volle Auflösung.';
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
    scumStatusEl.textContent = 'SCUM: läuft';
    scumStatusEl.className = 'scum-status running';
  } else {
    scumStatusEl.textContent = 'SCUM: nicht gestartet';
    scumStatusEl.className = 'scum-status not-running';
  }
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

  window.__TAURI__.event.listen('coord-update', (event) => {
    currentCoord = event.payload;
    const route = getCurrentRoute();
    if (route && isRecording) {
      route.records.push(event.payload);
    }
    statusEl.textContent = `Letzte Koordinate: X=${event.payload.x.toFixed(0)} Y=${event.payload.y.toFixed(0)}`;
    renderMap();
    if (followEnabled) {
      const ll = gameToLatLng(currentCoord.x, currentCoord.y);
      map.panTo(ll);
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

// Update livemap URL display
async function updateLivemapUrl() {
  try {
    const url = await invoke('get_livemap_url');
    const input = document.getElementById('livemapUrl');
    if (input) input.value = url;
  } catch {}
}

loadData();
checkScumStatus();
updateLivemapUrl();
