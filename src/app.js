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

// Leaflet layers for routes, POIs, live marker
let routeLayers = {};
let routeEndMarkers = {};
let poiMarkers = [];
let liveMarker = null;
let liveArrow = null;
let livePulse = null;
let connectionLines = [];
let connectionLabels = [];
let connectedPoiIds = new Set();

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
    state[id] = {
      seg1: entry.seg1 ? entry.seg1.getLatLngs().map(l => [l.lat, l.lng]) : null,
      seg2: entry.seg2 ? entry.seg2.getLatLngs().map(l => [l.lat, l.lng]) : null,
      label: entry.label ? entry.label.getLatLng() : null,
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

let connectionUpdatePending = false;
function updateConnectionLines() {
  if (connectionUpdatePending) return;
  connectionUpdatePending = true;
  requestAnimationFrame(() => {
    connectionUpdatePending = false;
    if (connectedPoiIds.size === 0) return;
    renderConnectionLine();
  });
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

    if (poi.image_path) {
      let hoverPopupBound = false;
      marker.on('mouseover', async () => {
        if (!hoverPopupBound) {
          try {
            const base64 = await invoke('get_poi_image_base64', { id: poi.id });
            marker.bindPopup(`<img src="data:image/png;base64,${base64}" style="max-width:200px;max-height:150px;border-radius:4px">`, { maxWidth: 250, closeButton: false, autoPan: false });
            hoverPopupBound = true;
          } catch (err) {}
        }
        marker.openPopup();
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

    poiMarkers.push(marker);
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
        if (stem) stem.style.transform = `translate(-50%, -50%) rotate(${currentCoord.yaw - 90}deg)`;
        if (arrow) arrow.style.transform = `translate(-50%, -50%) rotate(${currentCoord.yaw - 90}deg) translateY(-12px)`;
      }
    }
  } else {
    let html = '<div class="live-marker"><div class="live-marker-dot"></div>';
    if (typeof currentCoord.yaw === 'number') {
      html += `<div class="live-marker-stem" style="transform: translate(-50%, -50%) rotate(${currentCoord.yaw - 90}deg)"></div>`;
      html += `<div class="live-marker-arrow" style="transform: translate(-50%, -50%) rotate(${currentCoord.yaw - 90}deg) translateY(-12px)"></div>`;
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
  poiListEl.innerHTML = '';
  if (data.pois.length === 0) {
    poiListEl.innerHTML = '<p class="empty">Keine POIs</p>';
    return;
  }
  data.pois.forEach(poi => {
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
let trackingInterval = 3;
const liveTrackingBtn = document.getElementById('toggleLiveTracking');
const trackingIntervalInput = document.getElementById('trackingInterval');

function updateMarkerTransition() {
  const dur = Math.max(0.5, trackingInterval - 0.1);
  document.documentElement.style.setProperty('--marker-transition', `${dur}s linear`);
}

async function syncTrackingInterval() {
  try {
    trackingInterval = await invoke('get_tracking_interval');
    if (trackingIntervalInput) trackingIntervalInput.value = trackingInterval;
    updateMarkerTransition();
  } catch (err) {}
}
syncTrackingInterval();

if (trackingIntervalInput) {
  trackingIntervalInput.addEventListener('change', async () => {
    let val = parseInt(trackingIntervalInput.value);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 60) val = 60;
    trackingIntervalInput.value = val;
    trackingInterval = val;
    updateMarkerTransition();
    await invoke('set_tracking_interval', { seconds: val });
  });
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

  window.__TAURI__.event.listen('chat-paused', (event) => {
    const chatPausedEl = document.getElementById('chatPausedStatus');
    if (chatPausedEl) {
      chatPausedEl.style.display = event.payload ? 'block' : 'none';
    }
  });

  window.__TAURI__.event.listen('data-updated', (event) => {
    data = event.payload;
    if (!data.routes) data.routes = [];
    if (!data.pois) data.pois = [];
    updateUI();
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
    statusEl.textContent = `Letzte Koordinate: X=${event.payload.x.toFixed(0)} Y=${event.payload.y.toFixed(0)}`;
    const ll = gameToLatLng(currentCoord.x, currentCoord.y);
    updateLiveMarker(ll);
    updateConnectionLines();
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
