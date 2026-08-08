(function() {
  if (window.__scumWalkerLiveMapLoaded) return;
  window.__scumWalkerLiveMapLoaded = true;

  const statusEl = document.getElementById('status');
  const toastEl = document.getElementById('toast');
  let lastPoiCount = 0;
  let toastTimer = null;

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s || '';
    return div.innerHTML;
  }

  const isTauri = typeof window.__TAURI__ !== 'undefined';
  const isBigMap = new URLSearchParams(window.location.search).get('bigmap') === '1';
  document.body.classList.add('auto-hide-controls');
  if (isTauri) {
    document.body.classList.add('tauri-mode');
    document.documentElement.classList.add('tauri-mode');
  }
  if (isBigMap) document.body.classList.add('bigmap-mode');

  const closeBtn = document.getElementById('overlayClose');
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
  let followPlayer = isBigMap ? false : safeGetStorage('livemap.follow', 'true') !== 'false';
  const clusterKey = isTauri ? 'overlay.clustering' : 'livemap.clustering';
  let useClustering = safeGetStorage(clusterKey, 'false') === 'true';
  const followBtn = document.getElementById('followBtn');
  const toggleClusterBtn = document.getElementById('toggleCluster');

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

  function updateClusterButton() {
    if (toggleClusterBtn) toggleClusterBtn.classList.toggle('active', useClustering);
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

  if (toggleClusterBtn) {
    toggleClusterBtn.addEventListener('click', () => {
      useClustering = !useClustering;
      safeSetStorage(clusterKey, String(useClustering));
      updateClusterButton();
      renderPois();
    });
  }
  updateClusterButton();

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

  window.onerror = function(msg, url, line) {
    if (statusEl) statusEl.textContent = 'JS-Fehler: ' + msg + ' (' + line + ')';
    return false;
  };

  const API_BASE = window.location.origin;

  // World bounds in SCUM game coordinates (default, overridden by /api/bounds)
  let worldMinX = -904800;
  let worldMaxX = 619318;
  let worldMinY = -904800;
  let worldMaxY = 618818;
  let worldWidth = worldMaxX - worldMinX;
  let worldHeight = worldMaxY - worldMinY;

  function applyBounds(b) {
    worldMinX = b.min_x; worldMaxX = b.max_x;
    worldMinY = b.min_y; worldMaxY = b.max_y;
    worldWidth = worldMaxX - worldMinX;
    worldHeight = worldMaxY - worldMinY;
  }

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
    dragging: !isBigMap,
    scrollWheelZoom: !isBigMap,
    doubleClickZoom: !isBigMap,
    boxZoom: !isBigMap,
    keyboard: !isBigMap,
    touchZoom: !isBigMap,
    tap: !isBigMap,
  });

  // Tile layer - created after WebSocket init provides hires status
  let tileLayer = null;
  let maxNativeZoom = BUNDLED_MAX_ZOOM;

  function initTileLayer(hasHires) {
    if (tileLayer) return; // already initialized
    if (hasHires) maxNativeZoom = MAX_ZOOM;
    // Bigmap overlays SCUM's own map directly (visible through the transparent window),
    // so no tile image is rendered here - only markers/connection lines on top.
    if (isBigMap) return;
    tileLayer = L.tileLayer(API_BASE + '/tiles/{z}/{x}/{y}.png', {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxNativeZoom: maxNativeZoom,
      tileSize: 256,
      noWrap: true,
      bounds: L.latLngBounds([0, 0], [MAP_UNITS, MAP_UNITS]),
    }).addTo(map);
  }

  // Prevent panning outside map
  map.setMaxBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);

  // Fit initial view to full map
  map.fitBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);

  // Bigmap mode: the window is created hidden at a placeholder size and only resized
  // to match SCUM's window *after* this page has already loaded. Leaflet computes its
  // container size once at creation and the DOM 'resize' event is not reliably fired by
  // WebView2 for windows that are hidden/resized programmatically, so the map can be left
  // rendered at its old (smaller) size, anchored top-left, with empty space on the right.
  // A ResizeObserver watches the actual rendered box of the container directly and fires
  // regardless of what caused the change, which is robust against this.
  if (isBigMap) {
    // fitBounds computes an exact fractional zoom to fill the container, but DPI/subpixel
    // rounding between the native window size (physical px) and the webview's CSS layout
    // (logical px) can leave a residual gap of a few pixels top/bottom. Nudging the zoom
    // in very slightly makes the map overflow instead of underfill; #mapShell's
    // overflow:hidden clips the negligible excess so no gap is ever visible.
    const fitBigMapBounds = () => {
      map.fitBounds([[0, 0], [MAP_UNITS, MAP_UNITS]]);
      map.setZoom(map.getZoom() + 0.15, { animate: false });
    };
    const mapShellEl = document.getElementById('mapShell');
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      fitBigMapBounds();
    });
    ro.observe(mapShellEl);
    fitBigMapBounds();
  }

  // Dedicated pane for player marker so it renders above POI markers
  map.createPane('liveMarkerPane');
  map.getPane('liveMarkerPane').style.zIndex = '700';

  // Restore saved view (not in bigmap mode - it always shows the full fixed map)
  if (!isBigMap) {
    const savedZoom = parseInt(safeGetStorage('livemap.leafletZoom', ''));
    const savedLat = parseFloat(safeGetStorage('livemap.leafletLat', ''));
    const savedLng = parseFloat(safeGetStorage('livemap.leafletLng', ''));
    if (!isNaN(savedZoom) && !isNaN(savedLat) && !isNaN(savedLng)) {
      map.setView([savedLat, savedLng], savedZoom);
    }
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
    if (isBigMap && activeWs) {
      const g = latLngToGame(c.lat, c.lng);
      sendWs({ type: 'bigmap-center', x: g.x, y: g.y });
    }
  });

  if (isBigMap) {
    map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());
    map.on('contextmenu', (e) => {
      if (navMode === 'route') {
        if (!navRouteStart) { setNavPoint(e.latlng, true); }
        else if (!navTarget) { setNavPoint(e.latlng, false); }
        else { clearNav(); setNavPoint(e.latlng, true); }
      } else {
        const g = latLngToGame(e.latlng.lat, e.latlng.lng);
        setNavTarget(g.x, g.y);
      }
    });
  }

  function setNavTarget(x, y) {
    navTarget = { x, y };
    RoadNavigator.setTarget(x, y);
    showToast(`🧭 Ziel gesetzt: X=${x.toFixed(0)} Y=${y.toFixed(0)}`);
    if (navEndEl) navEndEl.textContent = `X=${x.toFixed(0)} Y=${y.toFixed(0)}`;
    sendWs({ type: 'set-nav-target', x, y });
    if (navMode === 'nav') updateNavRoute();
  }

  function updateNavRoute() {
    if (!RoadNavigator.graph || !navTarget || !currentPos) {
      if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
      return;
    }
    const route = RoadNavigator.findRoute(currentPos.x, currentPos.y);
    drawNavRoute(route);
  }

  // Zoom buttons
  document.getElementById('zoomIn').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoomOut').addEventListener('click', () => map.zoomOut());
  document.getElementById('fitBtn').addEventListener('click', () => {
    disableFollow();
    map.flyToBounds([[0, 0], [MAP_UNITS, MAP_UNITS]], { duration: 0.8 });
  });

  // Data state
  let data = { routes: [], current_route_id: null, pois: [], hidden_categories: [] };
  let currentPos = null;
  let connected = false;

  // Navigation state
  let navLayer = null;
  let navTarget = null;
  let navStartMarker = null;
  let navEndMarker = null;
  let navVisible = false;
  let navMode = 'nav';
  let navFollow = false;
  let navRemaining = null;
  let navTotalDist = 0;

  const toggleNavBtn = document.getElementById('toggleNav');
  const navPanel = document.getElementById('nav-panel');
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

  if (isBigMap && toggleNavBtn) {
    toggleNavBtn.style.display = '';
    toggleNavBtn.addEventListener('click', () => {
      navVisible = !navVisible;
      toggleNavBtn.classList.toggle('active', navVisible);
      if (navPanel) navPanel.classList.toggle('visible', navVisible);
      if (!navVisible) clearNav();
    });
  }

  if (navModeRoute) {
    navModeRoute.addEventListener('click', () => {
      navMode = 'route';
      navModeRoute.classList.add('active');
      navModeNav.classList.remove('active');
      if (navStartRow) navStartRow.classList.remove('hidden');
      if (navCalcBtn) navCalcBtn.textContent = 'Route berechnen';
      clearNav();
    });
  }
  if (navModeNav) {
    navModeNav.addEventListener('click', () => {
      navMode = 'nav';
      navModeNav.classList.add('active');
      navModeRoute.classList.remove('active');
      if (navStartRow) navStartRow.classList.add('hidden');
      if (navCalcBtn) navCalcBtn.textContent = 'Route neu berechnen';
      clearNav();
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
    navClearBtn.addEventListener('click', clearNav);
  }
  if (navFollowBtn) {
    navFollowBtn.addEventListener('click', () => {
      navFollow = !navFollow;
      navFollowBtn.classList.toggle('active', navFollow);
      if (navFollow && navRemaining) updateNavProgress();
      if (!navFollow && navProgressEl) navProgressEl.innerHTML = '';
    });
  }

  function clearNav() {
    if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
    if (navStartMarker) { map.removeLayer(navStartMarker); navStartMarker = null; }
    if (navEndMarker) { map.removeLayer(navEndMarker); navEndMarker = null; }
    navTarget = null;
    navRemaining = null;
    navTotalDist = 0;
    navFollow = false;
    if (navFollowBtn) navFollowBtn.classList.remove('active');
    if (navStartEl) navStartEl.textContent = '– Rechtsklick setzen';
    if (navEndEl) navEndEl.textContent = '– Rechtsklick setzen';
    if (navInfoEl) navInfoEl.innerHTML = '';
    if (navProgressEl) navProgressEl.innerHTML = '';
    sendWs({ type: 'clear-nav-target' });
  }

  let navRouteStart = null;

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
      if (navEndMarker) map.removeLayer(navEndMarker);
      navTarget = { x: g.x, y: g.y };
      RoadNavigator.setTarget(g.x, g.y);
      navEndMarker = L.marker(latlng, {
        icon: L.divIcon({ className: 'nav-marker-end', iconSize: [14, 14], iconAnchor: [7, 7] }),
        interactive: true,
      }).addTo(map);
      navEndMarker.on('click', clearNav);
      if (navEndEl) navEndEl.textContent = label;
      sendWs({ type: 'set-nav-target', x: g.x, y: g.y });
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

  function trimNavRoute() {
    if (!navRemaining || navRemaining.length < 2 || !currentPos) return;
    const snapThreshold = 50000; // 500m in game units (cm)
    const snapSq = snapThreshold * snapThreshold;
    let bestIdx = -1;
    for (let i = 0; i < navRemaining.length; i++) {
      const dx = navRemaining[i].x - currentPos.x;
      const dy = navRemaining[i].y - currentPos.y;
      if (dx * dx + dy * dy < snapSq) { bestIdx = i; break; }
    }
    if (bestIdx < 0) return;
    if (bestIdx === navRemaining.length - 1) {
      if (navLayer) { map.removeLayer(navLayer); navLayer = null; }
      navRemaining = null;
      if (navProgressEl) navProgressEl.innerHTML = '<span class="done">Ziel erreicht!</span>';
      navFollow = false;
      if (navFollowBtn) navFollowBtn.classList.remove('active');
      return;
    }
    navRemaining = navRemaining.slice(bestIdx);
    const latlngs = navRemaining.map(r => gameToLatLng(r.x, r.y));
    if (navLayer) {
      navLayer.setLatLngs(latlngs);
    } else {
      navLayer = L.polyline(latlngs, {
        color: '#00ffcc', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
      }).addTo(map);
    }
    updateNavProgress();
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
    } else {
      navLayer = L.polyline(latlngs, {
        color: '#00ffcc',
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
    if (navFollow) updateNavProgress();
  }

  // Route layers
  let routeLayers = {};
  let poiClusterGroup = null;
  let liveMarker = null;
  let liveArrow = null;
  let livePulse = null;
  let connectionLines = [];
  let connectionLabels = [];
  let connectedPoiIds = new Set();
  let connectionUpdatePending = false;

  function clearRoutes() {
    Object.values(routeLayers).forEach(l => map.removeLayer(l));
    routeLayers = {};
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
        label: entry.label ? [entry.label.getLatLng().lat, entry.label.getLatLng().lng] : null,
      };
    });
    return state;
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
    if (!currentPos) {
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
      const from = gameToLatLng(currentPos.x, currentPos.y);
      const to = gameToLatLng(poi.x, poi.y);
      const dx = poi.x - currentPos.x;
      const dy = poi.y - currentPos.y;
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
    const animStart = performance.now();
    const duration = 800;

    function animateLines(now) {
      const elapsed = now - animStart;
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

  function renderRoutes() {
    clearRoutes();
    if (isBigMap) return;
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
    const hidden = data.hidden_categories || [];
    poiClusterGroup = createPoiGroup();
    data.pois.filter(poi => !hidden.includes(poi.category || 'Unkategorisiert')).forEach(poi => {
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

      if (isBigMap) {
        // Bigmap mode: long-press on marker opens delete confirmation, short click toggles navigation.
        let longPressTimer = null;
        let longPressTriggered = false;

        marker.on('mousedown', (e) => {
          L.DomEvent.stopPropagation(e);
          longPressTriggered = false;
          longPressTimer = setTimeout(() => {
            longPressTriggered = true;
            bigmapShowDeleteModal(poi);
          }, 600);
        });

        marker.on('mouseup', (e) => {
          L.DomEvent.stopPropagation(e);
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        });

        marker.on('mouseout', () => {
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        });

        // Bigmap mode: click on a marker starts/stops the live navigation guide line to it.
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (longPressTriggered) { longPressTriggered = false; return; }
          if (connectedPoiIds.has(poi.id)) {
            connectedPoiIds.delete(poi.id);
            showToast('🧭 Navigation gestoppt: ' + poi.label);
          } else {
            connectedPoiIds.add(poi.id);
            showToast('🧭 Navigation gestartet: ' + poi.label);
          }
          renderConnectionLine();
          if (!sendWs({ type: 'set-poi-connections', ids: [...connectedPoiIds] })) {
            console.error('set-poi-connections nicht gesendet: WebSocket nicht verbunden');
            showToast('⚠️ Verbindung konnte nicht synchronisiert werden: keine WebSocket-Verbindung');
          }
        });
      }

      if (poi.image_path && !isBigMap) {
        const imgUrl = API_BASE + '/api/poi_image/' + poi.id;
        let hoverBound = false;
        marker.on('mouseover', () => {
          if (!hoverBound) {
            marker.bindPopup('<img src="' + imgUrl + '" style="max-width:200px;max-height:150px;border-radius:4px">', { maxWidth: 250, closeButton: false, autoPan: false });
            hoverBound = true;
          }
          marker.openPopup();
        });
        marker.on('click', () => {
          marker.closePopup();
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer';
          const img = document.createElement('img');
          img.src = imgUrl;
          img.style.cssText = 'max-width:90vw;max-height:85vh;border-radius:8px;border:1px solid #00ffcc55';
          overlay.appendChild(img);
          overlay.onclick = () => document.body.removeChild(overlay);
          document.body.appendChild(overlay);
        });
      }

      poiClusterGroup.addLayer(marker);
    });
    map.addLayer(poiClusterGroup);
  }

  function renderLiveMarker() {
    clearLiveMarker();
    if (!currentPos) return;
    const ll = gameToLatLng(currentPos.x, currentPos.y);
    updateLiveMarker(ll);
  }

  function updateLiveMarker(ll) {
    if (!currentPos) return;
    if (!ll) ll = gameToLatLng(currentPos.x, currentPos.y);
    if (liveMarker) {
      liveMarker.setLatLng(ll);
      const el = liveMarker.getElement();
      if (el) {
        const stem = el.querySelector('.live-marker-stem');
        const arrow = el.querySelector('.live-marker-arrow');
        if (typeof currentPos.yaw === 'number') {
          if (stem) stem.style.setProperty('--yaw', `${currentPos.yaw - 90}deg`);
          if (arrow) arrow.style.setProperty('--yaw', `${currentPos.yaw - 90}deg`);
        }
      }
    } else {
      let html = '<div class="live-marker"><div class="live-marker-dot"></div>';
      if (typeof currentPos.yaw === 'number') {
        html += `<div class="live-marker-stem" style="--yaw:${currentPos.yaw - 90}deg"></div>`;
        html += `<div class="live-marker-arrow" style="--yaw:${currentPos.yaw - 90}deg"></div>`;
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

  function centerOnCurrentPos() {
    if (!currentPos) return;
    const ll = gameToLatLng(currentPos.x, currentPos.y);
    map.panTo(ll, { animate: true, duration: 0.5 });
  }

  document.getElementById('centerBtn').addEventListener('click', () => {
    centerOnCurrentPos();
  });

  map.on('dragstart', disableFollow);

  // Bigmap mode: click on empty map area opens a modal to create a POI.
  let bigmapPendingPoi = null;
  let bigmapSelectedColor = '#ff44d3';
  const BIGMAP_POI_COLORS = ['#ff44d3', '#ff8800', '#44cc44', '#4488ff', '#ffee00', '#ff4444', '#ffffff'];

  const SECTOR_ROWS = ['D','C','B','A','Z'];
  const SECTOR_COLS = ['4','3','2','1','0'];
  function bigmapGetSector(x, y) {
    const width = worldMaxX - worldMinX;
    const height = worldMaxY - worldMinY;
    const c = Math.min(4, Math.max(0, Math.floor((worldMaxX - x) / width * 5)));
    const r = Math.min(4, Math.max(0, Math.floor((worldMaxY - y) / height * 5)));
    return SECTOR_ROWS[r] + SECTOR_COLS[c];
  }

  function bigmapPopulateCategories(fallback) {
    const cats = new Set();
    (data.pois || []).forEach(p => { if (p.category) cats.add(p.category); });
    if (fallback && !cats.has(fallback)) cats.add(fallback);
    const sorted = Array.from(cats).sort();
    const sel = document.getElementById('bigmapPoiCategory');
    sel.innerHTML = '';
    sorted.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      sel.appendChild(opt);
    });
    const neuOpt = document.createElement('option');
    neuOpt.value = '__new__';
    neuOpt.textContent = 'Neue Kategorie...';
    sel.appendChild(neuOpt);
    if (fallback) sel.value = fallback;
    const newCatInput = document.getElementById('bigmapPoiNewCategory');
    newCatInput.style.display = 'none';
    newCatInput.value = '';
  }

  function bigmapBuildColorPicker() {
    const container = document.getElementById('bigmapPoiColors');
    container.innerHTML = '';
    BIGMAP_POI_COLORS.forEach(c => {
      const sw = document.createElement('div');
      sw.className = 'bigmap-color-swatch' + (c === bigmapSelectedColor ? ' selected' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        bigmapSelectedColor = c;
        bigmapBuildColorPicker();
      });
      container.appendChild(sw);
    });
  }

  let bigmapModalOpen = false;

  function bigmapShowModal(game) {
    bigmapPendingPoi = game;
    const modal = document.getElementById('bigmapPoiModal');
    const labelInput = document.getElementById('bigmapPoiLabel');
    labelInput.value = '';
    bigmapPopulateCategories(bigmapGetSector(game.x, game.y));
    bigmapBuildColorPicker();
    modal.style.display = 'flex';
    bigmapModalOpen = true;
    sendWs({ type: 'bigmap-modal-state', open: true });
    labelInput.focus();
  }

  function bigmapHideModal() {
    document.getElementById('bigmapPoiModal').style.display = 'none';
    bigmapPendingPoi = null;
    if (bigmapModalOpen) {
      bigmapModalOpen = false;
      sendWs({ type: 'bigmap-modal-state', open: false });
    }
  }

  let bigmapDeletePendingPoi = null;

  function bigmapShowDeleteModal(poi) {
    bigmapDeletePendingPoi = poi;
    document.getElementById('bigmapDeleteLabel').textContent = poi.label || 'Unbenannter Marker';
    document.getElementById('bigmapDeleteModal').style.display = 'flex';
    bigmapModalOpen = true;
    sendWs({ type: 'bigmap-modal-state', open: true });
  }

  function bigmapHideDeleteModal() {
    document.getElementById('bigmapDeleteModal').style.display = 'none';
    bigmapDeletePendingPoi = null;
    if (bigmapModalOpen) {
      bigmapModalOpen = false;
      sendWs({ type: 'bigmap-modal-state', open: false });
    }
  }

  if (isBigMap) {
    map.on('click', (e) => {
      const game = latLngToGame(e.latlng.lat, e.latlng.lng);
      bigmapShowModal(game);
    });

    document.getElementById('bigmapPoiCancel').addEventListener('click', bigmapHideModal);

    document.getElementById('bigmapPoiCategory').addEventListener('change', function() {
      const newCatInput = document.getElementById('bigmapPoiNewCategory');
      if (this.value === '__new__') {
        newCatInput.style.display = '';
        newCatInput.focus();
      } else {
        newCatInput.style.display = 'none';
        newCatInput.value = '';
      }
    });

    document.getElementById('bigmapPoiSave').addEventListener('click', () => {
      if (!bigmapPendingPoi) return;
      const label = document.getElementById('bigmapPoiLabel').value.trim() || 'POI';
      const catSel = document.getElementById('bigmapPoiCategory');
      const rawCat = catSel.value === '__new__' ? document.getElementById('bigmapPoiNewCategory').value.trim() : catSel.value;
      const category = rawCat || bigmapGetSector(bigmapPendingPoi.x, bigmapPendingPoi.y);
      const id = String(Date.now());
      const poi = {
        id,
        label,
        x: bigmapPendingPoi.x,
        y: bigmapPendingPoi.y,
        type: 'manual',
        color: bigmapSelectedColor,
        image_path: null,
        category,
      };
      if (sendWs({ type: 'add-poi', poi })) {
        showToast('📍 Marker gesetzt: ' + label);
      } else {
        showToast('⚠️ Marker konnte nicht gesendet werden: keine WebSocket-Verbindung');
      }
      bigmapHideModal();
    });

    document.getElementById('bigmapPoiLabel').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('bigmapPoiSave').click();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        bigmapHideModal();
      }
    });

    document.getElementById('bigmapPoiModal').addEventListener('click', (e) => {
      if (e.target.id === 'bigmapPoiModal') bigmapHideModal();
    });

    // Delete confirmation modal
    document.getElementById('bigmapDeleteCancel').addEventListener('click', bigmapHideDeleteModal);

    document.getElementById('bigmapDeleteConfirm').addEventListener('click', () => {
      if (!bigmapDeletePendingPoi) return;
      const poi = bigmapDeletePendingPoi;
      if (sendWs({ type: 'remove-poi', id: poi.id })) {
        showToast('🗑️ Marker gelöscht: ' + (poi.label || ''));
      } else {
        showToast('⚠️ Marker konnte nicht gelöscht werden: keine WebSocket-Verbindung');
      }
      bigmapHideDeleteModal();
    });

    document.getElementById('bigmapDeleteModal').addEventListener('click', (e) => {
      if (e.target.id === 'bigmapDeleteModal') bigmapHideDeleteModal();
    });
  }

  function handleWsMessage(msg) {
    const raw = JSON.parse(msg);
    const type = Array.isArray(raw) ? raw[0] : (raw && raw.type);
    const msgData = Array.isArray(raw) ? raw[1] : undefined;
    switch (type) {
      case 'login-success': {
        const info = msgData || raw;
        if (info.bounds) applyBounds(info.bounds);
        if (info.has_hires_tiles !== undefined) initTileLayer(info.has_hires_tiles);
        connected = true;
        statusEl.textContent = 'Verbunden — Initialisiere...';
        if (followPlayer && currentPos) centerOnCurrentPos();
        break;
      }
      case 'nav-target': {
        const t = msgData;
        if (t && typeof t.x === 'number' && typeof t.y === 'number') {
          navTarget = { x: t.x, y: t.y };
          RoadNavigator.setTarget(t.x, t.y);
          if (navEndEl) navEndEl.textContent = `X=${t.x.toFixed(0)} Y=${t.y.toFixed(0)}`;
          if (isBigMap) {
            const ll = gameToLatLng(t.x, t.y);
            if (navEndMarker) map.removeLayer(navEndMarker);
            navEndMarker = L.marker(ll, {
              icon: L.divIcon({ className: 'nav-marker-end', iconSize: [14, 14], iconAnchor: [7, 7] }),
              interactive: true,
            }).addTo(map);
            navEndMarker.on('click', clearNav);
          }
          updateNavRoute();
        }
        break;
      }
      case 'nav-cleared': {
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
        break;
      }
      case 'coord-update': {
        const newPos = msgData;
        const posChanged = JSON.stringify(newPos) !== JSON.stringify(currentPos);
        currentPos = newPos;
        if (posChanged) {
          const ll = gameToLatLng(currentPos.x, currentPos.y);
          updateLiveMarker(ll);
          if (navMode === 'nav' && navFollow && navTarget) {
            updateNavRoute();
          } else if (navFollow && navRemaining) {
            trimNavRoute();
          }
          if (connectedPoiIds.size > 0) {
            if (!connectionUpdatePending) {
              connectionUpdatePending = true;
              requestAnimationFrame(() => {
                connectionUpdatePending = false;
                renderConnectionLine();
              });
            }
          }
        }
        statusEl.textContent = `X=${currentPos.x.toFixed(0)} Y=${currentPos.y.toFixed(0)}`;
        if (followPlayer && currentPos) centerOnCurrentPos();
        break;
      }
      case 'data-updated': {
        const newData = msgData || { routes: [], current_route_id: null, pois: [], hidden_categories: [] };
        if (!newData.hidden_categories) newData.hidden_categories = [];
        const routesChanged = JSON.stringify(newData.routes) !== JSON.stringify(data.routes);
        const currentRouteChanged = newData.current_route_id !== data.current_route_id;
        const poisChanged = JSON.stringify(newData.pois) !== JSON.stringify(data.pois);
        const hiddenChanged = JSON.stringify(newData.hidden_categories) !== JSON.stringify(data.hidden_categories || []);
        data = newData;
        if (routesChanged || currentRouteChanged) renderRoutes();
        if (poisChanged || hiddenChanged) renderPois();
        if ((poisChanged || hiddenChanged) && connectedPoiIds.size > 0) renderConnectionLine();
        break;
      }
      case 'poi-creating': {
        showToast('📍 POI wird erstellt...');
        break;
      }
      case 'poi-created': {
        const info = msgData || raw;
        showToast('📍 POI erstellt: ' + (info.label || ''));
        break;
      }
      case 'scum-status': {
        if (!msgData) {
          statusEl.textContent = 'SCUM nicht gestartet';
        }
        break;
      }
      case 'bounds-updated': {
        const info = msgData || raw;
        if (info.bounds) applyBounds(info.bounds);
        if (currentPos) renderLiveMarker();
        renderRoutes();
        renderPois();
        break;
      }
      case 'hires-tiles-installed': {
        if (tileLayer) {
          map.removeLayer(tileLayer);
          tileLayer = null;
        }
        initTileLayer(true);
        showToast('🗺️ Hi-Res Tiles installiert!');
        break;
      }
      case 'tracking-state': {
        if (msgData && msgData.recording) {
          showToast('🔴 Aufnahme gestartet');
        }
        break;
      }
      case 'tracking-interval': {
        break;
      }
      case 'poi-connect': {
        const info = msgData || raw;
        connectedPoiIds.add(info.poiId);
        renderConnectionLine();
        break;
      }
      case 'poi-disconnect': {
        const info = msgData || raw;
        connectedPoiIds.delete(info.poiId);
        renderConnectionLine();
        break;
      }
      case 'poi-connections': {
        connectedPoiIds = new Set(Array.isArray(msgData) ? msgData : (msgData && msgData.ids ? msgData.ids : []));
        renderConnectionLine();
        break;
      }
      case 'bigmap-closing': {
        if (typeof bigmapHideModal === 'function') bigmapHideModal();
        if (typeof bigmapHideDeleteModal === 'function') bigmapHideDeleteModal();
        break;
      }
    }
  }

  let pingInterval = null;
  let activeWs = null;

  function sendWs(obj) {
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function connectWs() {
    let wsPort = window.__WS_PORT__ || window.location.port || '4488';
    if (!/^\d+$/.test(wsPort)) wsPort = window.location.port || '4488';
    const host = window.location.hostname || 'localhost';
    const wsUrl = 'ws://' + host + ':' + wsPort + '/ws';
    let ws;
    try {
      ws = new WebSocket(wsUrl);
      activeWs = ws;
    } catch (e) {
      statusEl.textContent = 'Verbindung fehlgeschlagen, versuche erneut…';
      setTimeout(connectWs, 2000);
      return;
    }

    ws.onopen = () => {
      connected = true;
      statusEl.textContent = 'Verbunden — login...';
      ws.send(JSON.stringify({ type: 'login', client: 'overlay' }));
      // Send ping every 25 seconds to keep connection alive
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'pong') return; // ignore pong
        handleWsMessage(event.data);
      } catch (e) {}
    };

    ws.onclose = () => {
      connected = false;
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      statusEl.textContent = 'Verbindung verloren, versuche erneut…';
      setTimeout(connectWs, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  // Load road network for navigation
  (async () => {
    await RoadNavigator.init();
    if (RoadNavigator.graph) {
      showToast('🛣️ Straßennetz für Navigation geladen');
      updateNavRoute();
    } else {
      showToast('⚠️ Straßennetz für Navigation konnte nicht geladen werden');
    }
  })();

  connectWs();

})();
