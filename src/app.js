const { invoke } = window.__TAURI__.core;

const mapShell = document.getElementById('mapShell');
const mapContainer = document.getElementById('mapContainer');
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const routeListEl = document.getElementById('routeList');
const poiListEl = document.getElementById('poiList');
const zoomLabel = document.getElementById('zoomLabel');
const routeDialog = document.getElementById('routeDialog');
const routeNameInput = document.getElementById('routeNameInput');
const routeColorPicker = document.getElementById('routeColorPicker');
const routeColorsEl = document.getElementById('routeColors');
const poiDialog = document.getElementById('poiDialog');
const poiLabelInput = document.getElementById('poiLabel');
const poiColorPicker = document.getElementById('poiColorPicker');
const poiColorsEl = document.getElementById('poiColors');
const imageDialog = document.getElementById('imageDialog');
const imageDialogImg = document.getElementById('imageDialogImg');
const imageDialogTitle = document.getElementById('imageDialogTitle');
const poiLabelsEl = document.getElementById('poiLabels');

const MAP_SIZE = 1080;
const worldMinX = -904800;
const worldMaxX = 616818;
const worldMinY = -904800;
const worldMaxY = 618818;
const worldWidth = worldMaxX - worldMinX;
const worldHeight = worldMaxY - worldMinY;

const ROUTE_COLORS = ['#00ffcc', '#ff8800', '#4488ff', '#ff44d3', '#ffee00', '#44cc44', '#ff4444', '#ffffff'];
const POI_COLORS = ['#ff44d3', '#ff8800', '#44cc44', '#4488ff', '#ffee00', '#ff4444', '#ffffff'];
let selectedRouteColor = ROUTE_COLORS[0];
let selectedPoiColor = POI_COLORS[0];
let pendingPoi = null;

let data = { routes: [], current_route_id: null, pois: [] };
let isRecording = false;
let currentCoord = null;

// Zoom / Pan state
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 0.1;
let zoom = 1.0;
let panX = 0;
let panY = 0;
let mapImg = new Image();
mapImg.src = 'scum_map-1080x1080.png';
mapImg.onload = () => applyTransform();

function gameToMapX(gameX) {
  return ((worldMaxX - gameX) / worldWidth) * MAP_SIZE;
}

function gameToMapY(gameY) {
  return ((worldMaxY - gameY) / worldHeight) * MAP_SIZE;
}

function worldToScreen(gameX, gameY) {
  return {
    x: panX + zoom * gameToMapX(gameX),
    y: panY + zoom * gameToMapY(gameY)
  };
}

function screenToWorld(sx, sy) {
  const mx = (sx - panX) / zoom;
  const my = (sy - panY) / zoom;
  return {
    x: worldMaxX - (mx / MAP_SIZE) * worldWidth,
    y: worldMaxY - (my / MAP_SIZE) * worldHeight
  };
}

function clampPan() {
  const shellW = mapShell.clientWidth;
  const shellH = mapShell.clientHeight;
  const contentW = MAP_SIZE * zoom;
  const contentH = MAP_SIZE * zoom;
  if (contentW <= shellW) {
    panX = (shellW - contentW) / 2;
  } else {
    panX = Math.min(0, Math.max(shellW - contentW, panX));
  }
  if (contentH <= shellH) {
    panY = (shellH - contentH) / 2;
  } else {
    panY = Math.min(0, Math.max(shellH - contentH, panY));
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
  renderLabels();
}

function applyTransform() {
  clampPan();
  resizeCanvas();
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  mapShell.style.cursor = MAP_SIZE * zoom > mapShell.clientWidth + 1 ? 'grab' : '';
}

function autoFitZoom() {
  const pad = 16;
  const availW = mapShell.clientWidth - pad;
  const availH = mapShell.clientHeight - pad;
  const fit = Math.max(ZOOM_MIN, Math.min(1.0, Math.floor(Math.min(availW, availH) / MAP_SIZE * 10) / 10));
  zoom = fit;
  const size = MAP_SIZE * zoom;
  panX = (mapShell.clientWidth - size) / 2;
  panY = (mapShell.clientHeight - size) / 2;
  applyTransform();
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

function getCurrentRoute() {
  return data.routes.find(r => r.id === data.current_route_id);
}

function updateUI() {
  renderRouteList();
  renderPoiList();
  draw();
  renderLabels();
}

async function syncRecordingState() {
  try {
    isRecording = await invoke('is_recording');
  } catch (err) {
    isRecording = false;
  }
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
        <button class="route-icon ${recordingHere ? 'recording' : ''}" data-action="record" data-id="${route.id}" title="${recordingHere ? 'Aufzeichnung stoppen' : 'Aufzeichnung starten'}">${recordingHere ? '⏹' : '⏺'}</button>
        <button class="route-icon ${visible ? '' : 'hidden'}" data-action="toggle-visibility" data-id="${route.id}" title="${visible ? 'Auf Karte ausblenden' : 'Auf Karte einblenden'}">${visible ? '👁' : '�'}</button>
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
        updateGlobalRecordingButton();
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
        } else {
          return;
        }
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
                     <span>
                       <span class="poi-image-btn poi-screenshot-btn" data-id="${poi.id}">${hasImage ? 'Bild anzeigen' : 'Bild einfügen'}</span>
                       <span class="poi-delete" data-id="${poi.id}">löschen</span>
                     </span>`;
    poiListEl.appendChild(div);
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function draw() {
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  ctx.clearRect(0, 0, w, h);

  if (mapImg && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, 0, 0, MAP_SIZE, MAP_SIZE, panX, panY, MAP_SIZE * zoom, MAP_SIZE * zoom);
  }

  data.routes.forEach(route => {
    if (route.visible === false) return;
    const isCurrent = route.id === data.current_route_id;
    const color = route.color || '#888';

    if (route.records.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = isCurrent ? 2.5 : 1.5;
      ctx.setLineDash(isCurrent ? [] : [5, 5]);
      for (let i = 0; i < route.records.length; i++) {
        const pt = worldToScreen(route.records[i].x, route.records[i].y);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (route.records.length > 0) {
      const last = route.records[route.records.length - 1];
      const pt = worldToScreen(last.x, last.y);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isCurrent ? 7 : 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  data.pois.forEach(poi => {
    const pt = worldToScreen(poi.x, poi.y);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = poi.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  if (currentCoord) {
    const pt = worldToScreen(currentCoord.x, currentCoord.y);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#00ffcc';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 14, 0, 2 * Math.PI);
    ctx.strokeStyle = '#00ffccaa';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function renderLabels() {
  poiLabelsEl.innerHTML = '';
  const shellW = mapShell.clientWidth;
  const shellH = mapShell.clientHeight;

  data.pois.forEach(poi => {
    const pt = worldToScreen(poi.x, poi.y);

    if (pt.x < -20 || pt.x > shellW + 20 || pt.y < -10 || pt.y > shellH + 10) return;

    const el = document.createElement('div');
    el.className = 'poi-label';
    el.textContent = poi.label;
    el.style.left = pt.x + 'px';
    el.style.top = pt.y + 'px';
    poiLabelsEl.appendChild(el);
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

mapShell.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = mapShell.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;
  pendingPoi = screenToWorld(vx, vy);
  poiLabelInput.value = '';
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
  poiDialog.classList.add('open');
  poiLabelInput.focus();
});

poiColorPicker.addEventListener('input', (e) => {
  selectedPoiColor = e.target.value.toLowerCase();
  buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
});

// Zoom: scroll wheel
mapShell.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = mapShell.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;

  const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat((zoom + delta).toFixed(2))));
  if (newZoom === zoom) return;

  const ratio = newZoom / zoom;
  panX = vx - ratio * (vx - panX);
  panY = vy - ratio * (vy - panY);
  zoom = newZoom;
  applyTransform();
}, { passive: false });

// Zoom: sidebar buttons
document.getElementById('zoomIn').addEventListener('click', () => {
  const shellW = mapShell.clientWidth;
  const shellH = mapShell.clientHeight;
  const newZoom = Math.min(ZOOM_MAX, parseFloat((zoom + ZOOM_STEP).toFixed(2)));
  if (newZoom === zoom) return;
  const ratio = newZoom / zoom;
  panX = shellW / 2 - ratio * (shellW / 2 - panX);
  panY = shellH / 2 - ratio * (shellH / 2 - panY);
  zoom = newZoom;
  applyTransform();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  const shellW = mapShell.clientWidth;
  const shellH = mapShell.clientHeight;
  const newZoom = Math.max(ZOOM_MIN, parseFloat((zoom - ZOOM_STEP).toFixed(2)));
  if (newZoom === zoom) return;
  const ratio = newZoom / zoom;
  panX = shellW / 2 - ratio * (shellW / 2 - panX);
  panY = shellH / 2 - ratio * (shellH / 2 - panY);
  zoom = newZoom;
  applyTransform();
});

// Pan: left-mouse drag
let isPanning = false;
let didPan = false;
let panStartX = 0;
let panStartY = 0;
let panStartPanX = 0;
let panStartPanY = 0;

function mapIsLargerThanShell() {
  return MAP_SIZE * zoom > mapShell.clientWidth + 1;
}

mapShell.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!mapIsLargerThanShell()) return;
  e.preventDefault();
  isPanning = true;
  didPan = false;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panStartPanX = panX;
  panStartPanY = panY;
  mapShell.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  const dx = e.clientX - panStartX;
  const dy = e.clientY - panStartY;
  if (!didPan && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
  didPan = true;
  panX = panStartPanX + dx;
  panY = panStartPanY + dy;
  applyTransform();
});

document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !isPanning) return;
  isPanning = false;
  mapShell.style.cursor = mapIsLargerThanShell() ? 'grab' : '';
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
    poiLabelInput.value = '';
    buildColorPicker(poiColorsEl, POI_COLORS, selectedPoiColor, c => selectedPoiColor = c, poiColorPicker);
    poiDialog.classList.add('open');
    poiLabelInput.focus();
    statusEl.textContent = `Position: X=${record.x.toFixed(0)} Y=${record.y.toFixed(0)}`;
  } catch (err) {
    statusEl.textContent = 'Fehler: ' + err;
  }
});

document.getElementById('poiSave').addEventListener('click', async () => {
  if (!pendingPoi) return;
  const label = poiLabelInput.value.trim() || 'POI';
  const poi = {
    id: Date.now().toString(),
    label,
    x: pendingPoi.x,
    y: pendingPoi.y,
    type: 'general',
    color: selectedPoiColor
  };
  data = await invoke('add_poi', { poi });
  updateUI();
  poiDialog.classList.remove('open');
  pendingPoi = null;
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
    statusEl.textContent = isLiveTracking ? 'Live-Tracking aktiv' : 'Live-Tracking pausiert';
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

// Global recording state is controlled per route via the route list icons

// Live updates
if (window.__TAURI__.event) {
  window.__TAURI__.event.listen('coord-update', (event) => {
    currentCoord = event.payload;
    const route = getCurrentRoute();
    if (route && isRecording) {
      route.records.push(event.payload);
    }
    statusEl.textContent = `Letzte Koordinate: X=${event.payload.x.toFixed(0)} Y=${event.payload.y.toFixed(0)}`;
    updateUI();
  });
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportJson() {
  const exportData = {
    exportedAt: new Date().toISOString(),
    routes: data.routes,
    pois: data.pois
  };
  download('scum-walker-export.json', JSON.stringify(exportData, null, 2), 'application/json');
}

function exportCsv() {
  let csv = 'type,route_id,route_name,record_index,time,x,y,z,pitch,yaw,roll\n';
  data.routes.forEach(route => {
    route.records.forEach((rec, idx) => {
      csv += `record,${route.id},${escapeCsv(route.name)},${idx},${rec.time},${rec.x},${rec.y},${rec.z},${rec.pitch},${rec.yaw},${rec.roll}\n`;
    });
  });
  data.pois.forEach(poi => {
    csv += `poi,${poi.id},${escapeCsv(poi.label)},,,${poi.x},${poi.y},,,,\n`;
  });
  download('scum-walker-export.csv', csv, 'text/csv');
}

function escapeCsv(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

document.getElementById('exportJson').addEventListener('click', exportJson);
document.getElementById('exportCsv').addEventListener('click', exportCsv);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(autoFitZoom, 100);
});

loadData();
autoFitZoom();
