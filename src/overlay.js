const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const closeBtn = document.getElementById('closeBtn');
const opacitySlider = document.getElementById('opacitySlider');
const mapFrame = document.getElementById('mapFrame');
const currentWindow = getCurrentWindow();

function applyOpacity(value) {
  if (mapFrame) mapFrame.style.opacity = (value / 100).toString();
}

function safeGetStorage(key, fallback) {
  try { return localStorage.getItem(key); } catch { return fallback; }
}
function safeSetStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const savedOpacity = safeGetStorage('overlay.opacity', null);
if (opacitySlider && savedOpacity !== null) {
  opacitySlider.value = savedOpacity;
  applyOpacity(savedOpacity);
}

if (opacitySlider && mapFrame) {
  opacitySlider.addEventListener('input', () => {
    const value = opacitySlider.value;
    applyOpacity(value);
    safeSetStorage('overlay.opacity', value);
    saveOverlayState();
  });
}

async function saveOverlayState() {
  try {
    const size = await currentWindow.innerSize();
    const pos = await currentWindow.outerPosition();
    const opacity = parseFloat(safeGetStorage('overlay.opacity', '85'));
    await invoke('save_overlay_config', {
      config: {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        opacity
      }
    });
  } catch (err) {
    console.error(err);
  }
}

closeBtn.addEventListener('click', async () => {
  await saveOverlayState();
  try {
    await invoke('close_overlay');
  } catch (err) {
    console.error(err);
  }
});
