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
  });

  // Tile layer - created after WebSocket init provides hires status
  let tileLayer = null;
  let maxNativeZoom = BUNDLED_MAX_ZOOM;

  function initTileLayer(hasHires) {
    if (tileLayer) return; // already initialized
    if (hasHires) maxNativeZoom = MAX_ZOOM;
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
    map.flyToBounds([[0, 0], [MAP_UNITS, MAP_UNITS]], { duration: 0.8 });
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
  let connectionLines = [];
  let connectionLabels = [];
  let connectedPoiIds = new Set();
  let connectionUpdatePending = false;

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

      if (poi.image_path) {
        const imgUrl = API_BASE + '/api/poi_image/' + poi.id;
        let hoverBound = false;
        marker.on('mouseover', () => {
          if (!hoverBound) {
            marker.bindPopup(`<img src="${imgUrl}" style="max-width:200px;max-height:150px;border-radius:4px">`, { maxWidth: 250, closeButton: false, autoPan: false });
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

      poiMarkers.push(marker);
    });
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

  function handleWsMessage(msg) {
    const payload = JSON.parse(msg);
    switch (payload.type) {
      case 'login-success': {
        // Full settings received after login handshake
        const newData = payload.data || { routes: [], current_route_id: null, pois: [] };
        const newPos = payload.current_position || null;
        if (payload.bounds) applyBounds(payload.bounds);
        if (payload.has_hires_tiles !== undefined) initTileLayer(payload.has_hires_tiles);
        const routesChanged = JSON.stringify(newData.routes) !== JSON.stringify(data.routes);
        const currentRouteChanged = newData.current_route_id !== data.current_route_id;
        const poisChanged = JSON.stringify(newData.pois) !== JSON.stringify(data.pois);
        const posChanged = JSON.stringify(newPos) !== JSON.stringify(currentPos);
        data = newData;
        currentPos = newPos;
        if (routesChanged || currentRouteChanged) renderRoutes();
        if (poisChanged) renderPois();
        if (posChanged) renderLiveMarker();
        if (payload.poi_connections) {
          connectedPoiIds = new Set(payload.poi_connections);
          if (connectedPoiIds.size > 0) renderConnectionLine();
        }
        lastPoiCount = (data.pois || []).length;
        connected = true;
        statusEl.textContent = currentPos
          ? `Verbunden — X=${currentPos.x.toFixed(0)} Y=${currentPos.y.toFixed(0)}`
          : 'Verbunden — Keine Position';
        if (followPlayer && currentPos) centerOnCurrentPos();
        break;
      }
      case 'coord-update': {
        const newPos = payload.data;
        const posChanged = JSON.stringify(newPos) !== JSON.stringify(currentPos);
        currentPos = newPos;
        if (posChanged) {
          const ll = gameToLatLng(currentPos.x, currentPos.y);
          updateLiveMarker(ll);
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
        const newData = payload.data || { routes: [], current_route_id: null, pois: [] };
        const routesChanged = JSON.stringify(newData.routes) !== JSON.stringify(data.routes);
        const currentRouteChanged = newData.current_route_id !== data.current_route_id;
        const poisChanged = JSON.stringify(newData.pois) !== JSON.stringify(data.pois);
        data = newData;
        if (routesChanged || currentRouteChanged) renderRoutes();
        if (poisChanged) renderPois();
        if (poisChanged && connectedPoiIds.size > 0) renderConnectionLine();
        break;
      }
      case 'poi-creating': {
        showToast('📍 POI wird erstellt...');
        break;
      }
      case 'poi-created': {
        showToast('📍 POI erstellt: ' + payload.label);
        break;
      }
      case 'chat-paused': {
        if (payload.value) {
          showToast('⏸ Chat offen – Tracking pausiert');
        }
        break;
      }
      case 'scum-status': {
        if (!payload.value) {
          statusEl.textContent = 'SCUM nicht gestartet';
        }
        break;
      }
      case 'bounds-updated': {
        if (payload.bounds) applyBounds(payload.bounds);
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
        if (payload.recording) {
          showToast('🔴 Aufnahme gestartet');
        }
        break;
      }
      case 'tracking-interval': {
        break;
      }
      case 'poi-connect': {
        connectedPoiIds.add(payload.poiId);
        renderConnectionLine();
        break;
      }
      case 'poi-disconnect': {
        connectedPoiIds.delete(payload.poiId);
        renderConnectionLine();
        break;
      }
      case 'poi-connections': {
        connectedPoiIds = new Set(payload.ids || []);
        renderConnectionLine();
        break;
      }
    }
  }

  let pingInterval = null;

  function connectWs() {
    const wsPort = window.__WS_PORT__ || '4489';
    const host = window.location.hostname || 'localhost';
    const wsUrl = 'ws://' + host + ':' + wsPort + '/ws';
    let ws;
    try {
      ws = new WebSocket(wsUrl);
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

  connectWs();

})();
