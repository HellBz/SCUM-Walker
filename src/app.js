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

// Zoom / Pan state (matches nerdmaps index.php logic)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 0.1;
let zoom = 1.0;
let panX = 0;
let panY = 0;

function gameToPixelX(gameX) {
  return ((worldMaxX - gameX) / worldWidth) * MAP_SIZE;
}

function gameToPixelY(gameY) {
  return ((worldMaxY - gameY) / worldHeight) * MAP_SIZE;
}

function pixelToGameX(px) {
  return worldMaxX - (px / MAP_SIZE) * worldWidth;
}

function pixelToGameY(py) {
  return worldMaxY - (py / MAP_SIZE) * worldHeight;
}

function viewportToCanvas(vx, vy) {
  return {
    cx: (vx - panX) / zoom,
    cy: (vy - panY) / zoom
  };
}

function clampPan() {
  const shellW = mapShell.offsetWidth;
  const shellH = mapShell.offsetHeight;
  const contentW = MAP_SIZE * zoom;
  const contentH = MAP_SIZE * zoom;
  const maxPanX = contentW - shellW;
  const maxPanY = contentH - shellH;
  panX = maxPanX <= 0 ? 0 : Math.max(-maxPanX, Math.min(0, panX));
  panY = maxPanY <= 0 ? 0 : Math.max(-maxPanY, Math.min(0, panY));
}

function applyTransform() {
  clampPan();
  mapContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  mapShell.style.cursor = MAP_SIZE * zoom > mapShell.offsetWidth + 1 ? 'grab' : '';
  draw();
  renderLabels();
}

function autoFitZoom() {
  const pad = 16;
  const availW = mapShell.clientWidth - pad;
  const availH = mapShell.clientHeight - pad;
  const fit = Math.max(ZOOM_MIN, Math.min(1.0, Math.floor(Math.min(availW, availH) / MAP_SIZE * 10) / 10));
  zoom = fit;
  const size = Math.round(MAP_SIZE * zoom);
  panX = Math.max(0, (mapShell.clientWidth - size) / 2);
  panY = Math.max(0, (mapShell.clientHeight - size) / 2);
  applyTransform();
}

async function loadData() {
  try {
    data = await invoke('get_data');
    if (!data.routes) data.routes = [];
    if (!data.pois) data.pois = [];
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

function renderRouteList() {
  routeListEl.innerHTML = '';
  if (data.routes.length === 0) {
    routeListEl.innerHTML = '<p class="empty">Noch keine Route</p>';
    return;
  }
  data.routes.forEach(route => {
    const isCurrent = route.id === data.current_route_id;
    const div = document.createElement('div');
    div.className = 'route-item' + (isCurrent ? ' active' : '');
    div.innerHTML = `
      <span class="route-color" style="background:${route.color || '#888'}"></span>
      <span class="route-name">${escapeHtml(route.name)}</span>
      <span class="route-actions">
        <span class="route-rename" data-id="${route.id}">umbenennen</span>
        ${isCurrent ? '' : '<span class="route-select" data-id="' + route.id + '">aktivieren</span>'}
        <span class="route-delete" data-id="${route.id}">löschen</span>
      </span>
      <span class="route-count">${route.records.length} Punkte</span>
    `;
    routeListEl.appendChild(div);
  });

  routeListEl.querySelectorAll('.route-select').forEach(el => {
    el.addEventListener('click', async () => {
      data = await invoke('select_route', { id: el.dataset.id });
      updateUI();
    });
  });

  routeListEl.querySelectorAll('.route-rename').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const route = data.routes.find(r => r.id === id);
      if (!route) return;
      const newName = prompt('Neuer Name:', route.name);
      if (newName) {
        data = await invoke('rename_route', { id, name: newName });
        updateUI();
      }
    });
  });

  routeListEl.querySelectorAll('.route-delete').forEach(el => {
    el.addEventListener('click', async () => {
      data = await invoke('delete_route', { id: el.dataset.id });
      updateUI();
    });
  });

  routeListEl.querySelectorAll('.route-color').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.closest('.route-item').querySelector('.route-rename').dataset.id;
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
  ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

  data.routes.forEach(route => {
    const isCurrent = route.id === data.current_route_id;
    const color = route.color || '#888';

    if (route.records.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = (isCurrent ? 2.5 : 1.5) / zoom;
      ctx.setLineDash(isCurrent ? [] : [5 / zoom, 5 / zoom]);
      for (let i = 0; i < route.records.length; i++) {
        const px = gameToPixelX(route.records[i].x);
        const py = gameToPixelY(route.records[i].y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (route.records.length > 0) {
      const last = route.records[route.records.length - 1];
      const px = gameToPixelX(last.x);
      const py = gameToPixelY(last.y);
      ctx.beginPath();
      ctx.arc(px, py, (isCurrent ? 7 : 4) / zoom, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1 / zoom;
      ctx.stroke();
    }
  });

  // POIs (scaled inversely so they shrink as you zoom in)
  data.pois.forEach(poi => {
    const px = gameToPixelX(poi.x);
    const py = gameToPixelY(poi.y);
    const r = 6 / zoom;
    const lw = 1 / zoom;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, 2 * Math.PI);
    ctx.fillStyle = poi.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = lw;
    ctx.stroke();

  });
}

function renderLabels() {
  poiLabelsEl.innerHTML = '';
  const shellW = mapShell.offsetWidth;
  const shellH = mapShell.offsetHeight;

  data.pois.forEach(poi => {
    const px = gameToPixelX(poi.x);
    const py = gameToPixelY(poi.y);
    const vx = panX + px * zoom;
    const vy = panY + py * zoom;

    if (vx < -20 || vx > shellW + 20 || vy < -10 || vy > shellH + 10) return;

    const el = document.createElement('div');
    el.className = 'poi-label';
    el.textContent = poi.label;
    el.style.left = vx + 'px';
    el.style.top = vy + 'px';
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

mapContainer.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = mapShell.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;
  const { cx, cy } = viewportToCanvas(vx, vy);
  pendingPoi = {
    x: pixelToGameX(cx),
    y: pixelToGameY(cy)
  };
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
  zoom = Math.min(ZOOM_MAX, parseFloat((zoom + ZOOM_STEP).toFixed(2)));
  panX = panX - (MAP_SIZE / 2) * ZOOM_STEP;
  panY = panY - (MAP_SIZE / 2) * ZOOM_STEP;
  applyTransform();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  zoom = Math.max(ZOOM_MIN, parseFloat((zoom - ZOOM_STEP).toFixed(2)));
  panX = panX + (MAP_SIZE / 2) * ZOOM_STEP;
  panY = panY + (MAP_SIZE / 2) * ZOOM_STEP;
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
  return Math.round(MAP_SIZE * zoom) > mapShell.offsetWidth + 1;
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
document.getElementById('newRoute').addEventListener('click', () => {
  routeNameInput.value = `Route ${data.routes.length + 1}`;
  selectedRouteColor = ROUTE_COLORS[data.routes.length % ROUTE_COLORS.length];
  routeColorPicker.value = selectedRouteColor;
  buildColorPicker(routeColorsEl, ROUTE_COLORS, selectedRouteColor, c => selectedRouteColor = c, routeColorPicker);
  routeDialog.classList.add('open');
  routeNameInput.focus();
  routeNameInput.select();
});

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

// Overlay
const overlayBtn = document.getElementById('openOverlay');
overlayBtn.addEventListener('click', async () => {
  try {
    await invoke('open_overlay');
    statusEl.textContent = 'Overlay geöffnet';
  } catch (err) {
    statusEl.textContent = 'Overlay: ' + err;
  }
});

// Recording toggle
const toggleBtn = document.getElementById('toggleRecording');
toggleBtn.addEventListener('click', async () => {
  if (!data.current_route_id) {
    statusEl.textContent = 'Bitte zuerst eine Route erstellen.';
    return;
  }
  const recording = await invoke('toggle_recording');
  toggleBtn.textContent = recording ? 'Aufzeichnung stoppen' : 'Aufzeichnung starten';
  statusEl.textContent = recording ? 'Aufzeichnung läuft...' : 'Aufzeichnung pausiert';
});

// Live updates
if (window.__TAURI__.event) {
  window.__TAURI__.event.listen('coord-update', (event) => {
    const route = getCurrentRoute();
    if (route) {
      route.records.push(event.payload);
      statusEl.textContent = `Letzte Koordinate: X=${event.payload.x.toFixed(0)} Y=${event.payload.y.toFixed(0)}`;
      updateUI();
    }
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
