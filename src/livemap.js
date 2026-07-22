const mapShell = document.getElementById('mapShell');
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
const ZOOM_MAX = 8.0;
const ZOOM_STEP = 0.25;

const params = new URLSearchParams(window.location.search);
let zoom = parseFloat(localStorage.getItem('livemap.zoom')) || 1.5;
const urlZoom = parseFloat(params.get('zoom'));
if (!isNaN(urlZoom) && urlZoom >= ZOOM_MIN && urlZoom <= ZOOM_MAX) {
  zoom = urlZoom;
}
let panX = 0;
let panY = 0;
let data = { routes: [], current_route_id: null, pois: [] };
let currentPos = null;
let connected = false;
let mapImg = null;

function saveZoom() {
  localStorage.setItem('livemap.zoom', zoom.toFixed(2));
}

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
}

function updateZoomLabel() {
  document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
}

function draw() {
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  ctx.clearRect(0, 0, w, h);

  if (!mapImg) return;

  const mapW = MAP_SIZE * zoom;
  const mapH = MAP_SIZE * zoom;
  ctx.drawImage(mapImg, 0, 0, MAP_SIZE, MAP_SIZE, panX, panY, mapW, mapH);

  if (data.routes) {
    data.routes.forEach(route => {
      const isCurrent = route.id === data.current_route_id;
      const color = route.color || '#888';
      if (!route.records || route.records.length < 2) return;
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
    });
  }

  if (data.pois) {
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
  }

  if (currentPos) {
    const pt = worldToScreen(currentPos.x, currentPos.y);
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

  renderLabels();
}

function renderLabels() {
  poiLabelsEl.innerHTML = '';
  if (!data.pois) return;
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;

  data.pois.forEach(poi => {
    const pt = worldToScreen(poi.x, poi.y);
    if (pt.x < -20 || pt.x > w + 20 || pt.y < -10 || pt.y > h + 10) return;
    const el = document.createElement('div');
    el.className = 'poi-label';
    el.textContent = poi.label;
    el.style.left = pt.x + 'px';
    el.style.top = pt.y + 'px';
    poiLabelsEl.appendChild(el);
  });
}

function fitAll() {
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  zoom = Math.max(ZOOM_MIN, Math.min(w, h) / MAP_SIZE);
  saveZoom();
  panX = (w - MAP_SIZE * zoom) / 2;
  panY = (h - MAP_SIZE * zoom) / 2;
  updateZoomLabel();
  draw();
}

function centerOnCurrentPos() {
  if (!currentPos) return;
  const w = mapShell.clientWidth;
  const h = mapShell.clientHeight;
  const mx = gameToMapX(currentPos.x);
  const my = gameToMapY(currentPos.y);
  panX = w / 2 - zoom * mx;
  panY = h / 2 - zoom * my;
  updateZoomLabel();
  draw();
}

async function fetchData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    data = payload.data || payload;
    currentPos = null;
    if (payload.current_position) {
      currentPos = payload.current_position;
    } else if (data.current_route_id) {
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

document.getElementById('centerBtn').addEventListener('click', centerOnCurrentPos);
document.getElementById('fitBtn').addEventListener('click', fitAll);

window.addEventListener('resize', resizeCanvas);

mapImg = new Image();
mapImg.src = '/map.png';
mapImg.onload = () => {
  resizeCanvas();
  fitAll();
  fetchData();
  setInterval(fetchData, 2000);
};
