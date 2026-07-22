const mapShell = document.getElementById('mapShell');
const mapContainer = document.getElementById('mapContainer');
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const poiLabelsEl = document.getElementById('poiLabels');

const MAP_SIZE = 1080;
const worldMinX = -904800;
const worldMaxX = 616818;
const worldMinY = -904800;
const worldMaxY = 618818;
const worldWidth = worldMaxX - worldMinX;
const worldHeight = worldMaxY - worldMinY;

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 6.0;
const ZOOM_STEP = 0.25;
let zoom = parseFloat(localStorage.getItem('livemap.zoom')) || 1.5;
let panX = 0;
let panY = 0;
let data = { routes: [], current_route_id: null, pois: [] };
let currentPos = null;

function saveZoom() {
  localStorage.setItem('livemap.zoom', zoom.toFixed(2));
}

function gameToPixelX(gameX) {
  return ((worldMaxX - gameX) / worldWidth) * MAP_SIZE;
}

function gameToPixelY(gameY) {
  return ((worldMaxY - gameY) / worldHeight) * MAP_SIZE;
}

function applyTransform() {
  mapContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  draw();
  renderLabels();
}

function fitAll() {
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  const scale = Math.min(w, h) / MAP_SIZE;
  zoom = Math.max(ZOOM_MIN, scale);
  saveZoom();
  panX = (w - MAP_SIZE * zoom) / 2;
  panY = (h - MAP_SIZE * zoom) / 2;
  applyTransform();
}

function centerOnCurrentPos() {
  if (!currentPos) return;
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  const px = gameToPixelX(currentPos.x);
  const py = gameToPixelY(currentPos.y);
  panX = w / 2 - px * zoom;
  panY = h / 2 - py * zoom;
  applyTransform();
}

function draw() {
  ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

  if (data.routes) {
    data.routes.forEach(route => {
      const isCurrent = route.id === data.current_route_id;
      const color = route.color || '#888';

      if (route.records && route.records.length > 1) {
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
  }

  if (data.pois) {
    data.pois.forEach(poi => {
      const px = gameToPixelX(poi.x);
      const py = gameToPixelY(poi.y);
      const r = 6 / zoom;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 2 * Math.PI);
      ctx.fillStyle = poi.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1 / zoom;
      ctx.stroke();
    });
  }

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
  if (!data.pois) return;
  const shellW = mapShell.clientWidth;
  const shellH = mapShell.clientHeight;

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

let connected = false;

async function fetchData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    data = payload.data || payload;
    currentPos = null;
    if (data.current_route_id) {
      const route = data.routes.find(r => r.id === data.current_route_id);
      if (route && route.records.length) {
        currentPos = route.records[route.records.length - 1];
      }
    }
    if (!currentPos && data.routes.length && data.routes[0].records.length) {
      currentPos = data.routes[0].records[data.routes[0].records.length - 1];
    }

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
    centerOnCurrentPos();
  } catch (err) {
    connected = false;
    statusEl.textContent = 'Verbindung zur App verloren, versuche erneut…';
  }
}

document.getElementById('zoomIn').addEventListener('click', () => {
  zoom = Math.min(ZOOM_MAX, parseFloat((zoom + ZOOM_STEP).toFixed(2)));
  saveZoom();
  centerOnCurrentPos();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  zoom = Math.max(ZOOM_MIN, parseFloat((zoom - ZOOM_STEP).toFixed(2)));
  saveZoom();
  centerOnCurrentPos();
});

document.getElementById('centerBtn').addEventListener('click', () => {
  centerOnCurrentPos();
});

document.getElementById('fitBtn').addEventListener('click', fitAll);

window.addEventListener('resize', () => centerOnCurrentPos());

fitAll();
fetchData();
setInterval(fetchData, 2000);
