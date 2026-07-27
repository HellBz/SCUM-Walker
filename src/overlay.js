const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const closeBtn = document.getElementById('closeBtn');
const opacitySlider = document.getElementById('opacitySlider');
const mapFrame = document.getElementById('mapFrame');
const currentWindow = getCurrentWindow();

// Set iframe src dynamically from actual server port
(async () => {
  try {
    const url = await invoke('get_livemap_url');
    if (url && mapFrame) mapFrame.src = url;
  } catch (err) {
    console.error('Failed to get livemap URL:', err);
  }
})();

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
  });
}

async function saveOverlayState() {
  try {
    await invoke('save_overlay_state');
  } catch (err) {
    console.error(err);
  }
}

currentWindow.listen('tauri://resize', () => saveOverlayState());
currentWindow.listen('tauri://move', () => saveOverlayState());

closeBtn.addEventListener('click', async () => {
  await saveOverlayState();
  try {
    await invoke('close_overlay');
  } catch (err) {
    console.error(err);
  }
});
