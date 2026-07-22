const { invoke } = window.__TAURI__.core;

const mapShell = document.getElementById('mapShell');
const mapContainer = document.getElementById('mapContainer');
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const poiLabelsEl = document.getElementById('poiLabels');
const statusEl = document.getElementById('status');
const zoomLabel = document.getElementById('zoomLabel');
const lockBtn = document.getElementById('lockBtn');
const opacitySlider = document.getElementById('opacitySlider');

const MAP_SIZE = 1080;
const worldMinX = -904800;
const worldMaxX = 616818;
const worldMinY = -904800;
const worldMaxY = 618818;
const worldWidth = worldMaxX - worldMinX;
const worldHeight = worldMaxY - worldMinY;

const ZOOM_MIN = 1.0;
const ZOOM_MAX = 6.0;
const ZOOM_STEP = 0.25;
let zoom = 2.0;
let panX = 0;
let panY = 0;

let data = { routes: [], current_route_id: null, pois: [] };
let currentPos = null;
let followPlayer = true;
let locked = false;

function gameToPixelX(gameX) {
  return ((worldMaxX - gameX) / worldWidth) * MAP_SIZE;
}

function gameToPixelY(gameY) {
  return ((worldMaxY - gameY) / worldHeight) * MAP_SIZE;
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
  draw();
  renderLabels();
}

function centerOnCurrentPos() {
  if (!currentPos) return;
  const shellW = mapShell.offsetWidth;
  const shellH = mapShell.offsetHeight;
  const px = gameToPixelX(currentPos.x);
  const py = gameToPixelY(currentPos.y);
  panX = shellW / 2 - px * zoom;
  panY = shellH / 2 - py * zoom;
  applyTransform();
}

async function loadData() {
  try {
    data = await invoke('get_data');
    if (!data.routes) data.routes = [];
    if (!data.pois) data.pois = [];
    const current = getCurrentRoute();
    if (current && current.records.length) {
      currentPos = current.records[current.records.length - 1];
      if (followPlayer) centerOnCurrentPos();
    } else {
      applyTransform();
    }
  } catch (err) {
    statusEl.textContent = 'Fehler: ' + err;
  }
}

function getCurrentRoute() {
  return data.routes.find(r => r.id === data.current_route_id);
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
  });

  data.pois.forEach(poi => {
    const px = gameToPixelX(poi.x);
    const py = gameToPixelY(poi.y);
    const r = 5 / zoom;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, 2 * Math.PI);
    ctx.fillStyle = poi.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / zoom;
    ctx.stroke();
  });

  if (currentPos) {
    const px = gameToPixelX(currentPos.x);
    const py = gameToPixelY(currentPos.y);

    ctx.beginPath();
    ctx.arc(px, py, 8 / zoom, 0, 2 * Math.PI);
    ctx.fillStyle = '#00ffcc';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5 / zoom;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px, py, 14 / zoom, 0, 2 * Math.PI);
    ctx.strokeStyle = '#00ffccaa';
    ctx.lineWidth = 2 / zoom;
    ctx.stroke();
  }
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

if (window.__TAURI__.event) {
  window.__TAURI__.event.listen('coord-update', (event) => {
    const record = event.payload;
    currentPos = record;
    const route = getCurrentRoute();
    if (route) {
      route.records.push(record);
    }
    statusEl.textContent = `X=${record.x.toFixed(0)} Y=${record.y.toFixed(0)}`;
    if (followPlayer) centerOnCurrentPos();
    else draw();
  });
}

document.getElementById('zoomIn').addEventListener('click', () => {
  zoom = Math.min(ZOOM_MAX, parseFloat((zoom + ZOOM_STEP).toFixed(2)));
  followPlayer = false;
  if (currentPos) centerOnCurrentPos();
  else applyTransform();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  zoom = Math.max(ZOOM_MIN, parseFloat((zoom - ZOOM_STEP).toFixed(2)));
  followPlayer = false;
  if (currentPos) centerOnCurrentPos();
  else applyTransform();
});

document.getElementById('centerBtn').addEventListener('click', () => {
  followPlayer = true;
  centerOnCurrentPos();
});

opacitySlider.addEventListener('input', () => {
  const val = opacitySlider.value / 100;
  document.getElementById('overlayRoot').style.background = `rgba(0, 0, 0, ${0.4 + val * 0.5})`;
});

lockBtn.addEventListener('click', async () => {
  locked = !locked;
  lockBtn.title = locked ? 'Klicks durchlassen (Entsperren mit Rechtsklick?)' : 'Klick-durchlässig schalten';
  lockBtn.textContent = locked ? '🔓' : '🔒';
  lockBtn.classList.toggle('locked', locked);
  try {
    await invoke('set_overlay_clickthrough', { clickthrough: locked });
  } catch (err) {
    console.error(err);
  }
});

document.getElementById('closeBtn').addEventListener('click', async () => {
  try {
    await invoke('close_overlay');
  } catch (err) {
    console.error(err);
  }
});

window.addEventListener('resize', () => {
  if (currentPos && followPlayer) centerOnCurrentPos();
});

loadData();
centerOnCurrentPos();
applyTransform();
