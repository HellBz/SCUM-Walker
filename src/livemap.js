(function() {
  if (window.__scumWalkerLiveMapLoaded) return;
  window.__scumWalkerLiveMapLoaded = true;

  const statusEl = document.getElementById('status');
  const isTauri = typeof window.__TAURI__ !== 'undefined';
  document.body.classList.add('auto-hide-controls');
  if (isTauri) document.body.classList.add('tauri-mode');

  const closeBtn = document.getElementById('overlayClose');
  const opacitySlider = document.getElementById('opacitySlider');
  const dragHandle = document.getElementById('dragHandle');
  const toggleCoordsBtn = document.getElementById('toggleCoords');

  let currentWindow = null;
  if (isTauri) {
    try { currentWindow = window.__TAURI__.window.getCurrentWindow(); } catch (e) { currentWindow = null; }
  }

  function safeGetStorage(key, fallback) {
    try { return localStorage.getItem(key); } catch { return fallback; }
  }
  function safeSetStorage(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  async function saveOverlayState() {
    if (!currentWindow) return;
    try {
      const size = await currentWindow.innerSize();
      const pos = await currentWindow.outerPosition();
      await window.__TAURI__.core.invoke('save_overlay_config', {
        config: { x: pos.x, y: pos.y, width: size.width, height: size.height }
      });
    } catch (err) { console.error(err); }
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', async () => {
      await saveOverlayState();
      if (isTauri) {
        try { await window.__TAURI__.core.invoke('close_overlay'); } catch (err) { window.close(); }
      } else { window.close(); }
    });
  }

  if (dragHandle && currentWindow) {
    let dragging = false;
    let dragMouseStart = { x: 0, y: 0 };
    let dragWinStart = { x: 0, y: 0 };
    dragHandle.addEventListener('mousedown', async (e) => {
      if (e.target.closest('#overlayClose')) return;
      e.preventDefault();
      dragging = true;
      dragMouseStart = { x: e.screenX, y: e.screenY };
      try {
        const pos = await currentWindow.outerPosition();
        dragWinStart = { x: pos.x, y: pos.y };
      } catch (err) { console.error(err); }
    });
    window.addEventListener('mousemove', async (e) => {
      if (!dragging) return;
      const dx = e.screenX - dragMouseStart.x;
      const dy = e.screenY - dragMouseStart.y;
      try { await currentWindow.setPosition({ type: 'Physical', x: dragWinStart.x + dx, y: dragWinStart.y + dy }); } catch (err) {}
    });
    window.addEventListener('mouseup', async () => {
      if (dragging) { dragging = false; await saveOverlayState(); }
    });
  }

  let showCoords = safeGetStorage('overlay.showCoords', 'true') !== 'false';
  let followPlayer = safeGetStorage('livemap.follow', 'true') !== 'false';
  const followBtn = document.getElementById('followBtn');

  function updateFollowButton() {
    if (followBtn) followBtn.classList.toggle('active', followPlayer);
  }
  updateFollowButton();

  function disableFollow() {
    followPlayer = false;
    safeSetStorage('livemap.follow', 'false');
    updateFollowButton();
  }
  function enableFollow() {
    followPlayer = true;
    safeSetStorage('livemap.follow', 'true');
    updateFollowButton();
  }

  if (followBtn) {
    followBtn.addEventListener('click', () => {
      if (followPlayer) disableFollow();
      else { enableFollow(); centerOnCurrentPos(); }
    });
  }

  function updateCoordsVisibility() {
    if (!statusEl) return;
    statusEl.style.display = showCoords ? 'block' : 'none';
  }
  updateCoordsVisibility();

  if (toggleCoordsBtn) {
    toggleCoordsBtn.classList.toggle('active', showCoords);
    toggleCoordsBtn.addEventListener('click', () => {
      showCoords = !showCoords;
      safeSetStorage('overlay.showCoords', String(showCoords));
      toggleCoordsBtn.classList.toggle('active', showCoords);
      updateCoordsVisibility();
    });
  }

  if (opacitySlider) {
    const savedOpacity = safeGetStorage('overlay.opacity', null);
    if (savedOpacity !== null) {
      opacitySlider.value = savedOpacity;
      document.body.style.opacity = (savedOpacity / 100).toString();
    }
    opacitySlider.addEventListener('input', () => {
      const value = opacitySlider.value;
      document.body.style.opacity = (value / 100).toString();
      safeSetStorage('overlay.opacity', value);
    });
  }

  window.onerror = function(msg, url, line) {
    if (statusEl) statusEl.textContent = 'JS-Fehler: ' + msg + ' (' + line + ')';
    return false;
  };

  const API_BASE = 'http://127.0.0.1:4488';

  // World bounds in SCUM game coordinates
  const worldMinX = -904800;
  const worldMaxX = 616818;
  const worldMinY = -904800;
  const worldMaxY = 618818;
  const worldWidth = worldMaxX - worldMinX;
  const worldHeight = worldMaxY - worldMinY;

  // Tile system: 256px tiles, zoom 0-6. Image upscaled to 16384x16384 (no padding).
  // Zoom 0-3 bundled, 4-6 via download. maxNativeZoom adjusts dynamically.
  const MAP_UNITS = 256;
  const MAX_ZOOM = 6;
  const MIN_ZOOM = 0;
  const BUNDLED_MAX_ZOOM = 3;

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

  // Tile layer
  const tileLayer = L.tileLayer(API_BASE + '/tiles/{z}/{x}/{y}.png', {
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    maxNativeZoom: BUNDLED_MAX_ZOOM,
    tileSize: 256,
    noWrap: true,
    bounds: L.latLngBounds([0, 0], [MAP_UNITS, MAP_UNITS]),
  }).addTo(map);

  // Prevent panning outside map
  map.setMaxBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);

  // Fit initial view to full map
  map.fitBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);

  // Restore saved view
  const savedZoom = parseInt(safeGetStorage('livemap.leafletZoom', ''));
  const savedLat = parseFloat(safeGetStorage('livemap.leafletLat', ''));
  const savedLng = parseFloat(safeGetStorage('livemap.leafletLng', ''));
  if (!isNaN(savedZoom) && !isNaN(savedLat) && !isNaN(savedLng)) {
    map.setView([savedLat, savedLng], savedZoom);
  }

  // Update zoom label
  function updateZoomLabel() {
    const z = map.getZoom();
    const pct = Math.round(Math.pow(2, z) * 100);
    document.getElementById('zoomLabel').textContent = pct + '%';
  }
  updateZoomLabel();

  map.on('zoomend moveend', () => {
    const c = map.getCenter();
    safeSetStorage('livemap.leafletZoom', String(map.getZoom()));
    safeSetStorage('livemap.leafletLat', c.lat.toFixed(2));
    safeSetStorage('livemap.leafletLng', c.lng.toFixed(2));
    updateZoomLabel();
  });

  // Zoom buttons
  document.getElementById('zoomIn').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoomOut').addEventListener('click', () => map.zoomOut());
  document.getElementById('fitBtn').addEventListener('click', () => {
    disableFollow();
    map.fitBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);
  });

  // Data state
  let data = { routes: [], current_route_id: null, pois: [] };
  let currentPos = null;
  let connected = false;

  // Route layers
  let routeLayers = {};
  let poiMarkers = [];
  let liveMarker = null;
  let liveArrow = null;
  let livePulse = null;

  function clearRoutes() {
    Object.values(routeLayers).forEach(l => map.removeLayer(l));
    routeLayers = {};
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
    if (!data.routes) return;
    data.routes.forEach(route => {
      if (route.visible === false) return;
      if (!route.records || route.records.length < 2) return;
      const isCurrent = route.id === data.current_route_id;
      const color = route.color || '#888';
      const latlngs = route.records.map(r => gameToLatLng(r.x, r.y));
      const line = L.polyline(latlngs, {
        color: color,
        weight: isCurrent ? 3 : 2,
        opacity: 0.8,
        dashArray: isCurrent ? null : '8,8',
      }).addTo(map);
      routeLayers[route.id] = line;
    });
  }

  function renderPois() {
    clearPois();
    if (!data.pois) return;
    data.pois.forEach(poi => {
      const ll = gameToLatLng(poi.x, poi.y);
      const marker = L.circleMarker(ll, {
        radius: 6,
        fillColor: poi.color || '#ff44d3',
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
    if (!currentPos) return;
    const ll = gameToLatLng(currentPos.x, currentPos.y);

    let html = '<div class="live-marker"><div class="live-marker-dot"></div>';
    if (typeof currentPos.yaw === 'number') {
      html += `<div class="live-marker-arrow" style="transform: translate(-50%, -50%) rotate(${currentPos.yaw - 90}deg) translateY(-20px)"></div>`;
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

  function centerOnCurrentPos() {
    if (!currentPos) return;
    const ll = gameToLatLng(currentPos.x, currentPos.y);
    map.panTo(ll);
  }

  document.getElementById('centerBtn').addEventListener('click', () => {
    centerOnCurrentPos();
  });

  map.on('dragstart', disableFollow);

  async function fetchData() {
    try {
      const res = await fetch(API_BASE + '/api/data');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      const newData = payload.data || payload;
      const newPos = payload.current_position || null;

      const routesChanged = JSON.stringify(newData.routes) !== JSON.stringify(data.routes);
      const poisChanged = JSON.stringify(newData.pois) !== JSON.stringify(data.pois);
      const posChanged = JSON.stringify(newPos) !== JSON.stringify(currentPos);

      data = newData;
      currentPos = newPos;

      if (routesChanged) renderRoutes();
      if (poisChanged) renderPois();
      if (posChanged) renderLiveMarker();

      if (!connected) {
        statusEl.textContent = currentPos
          ? `Verbunden — X=${currentPos.x.toFixed(0)} Y=${currentPos.y.toFixed(0)}`
          : 'Verbunden — Keine Position';
        connected = true;
      } else {
        statusEl.textContent = currentPos
          ? `X=${currentPos.x.toFixed(0)} Y=${currentPos.y.toFixed(0)}`
          : 'Keine Position';
      }

      if (followPlayer && currentPos) centerOnCurrentPos();
    } catch (err) {
      connected = false;
      statusEl.textContent = 'Verbindung zur App verloren, versuche erneut…';
    }
  }

  fetchData();
  setInterval(fetchData, 2000);

})();
