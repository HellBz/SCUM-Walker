const { invoke } = window.__TAURI__.core;

const lockBtn = document.getElementById('lockBtn');
const closeBtn = document.getElementById('closeBtn');
const opacitySlider = document.getElementById('opacitySlider');
const mapFrame = document.getElementById('mapFrame');

let clickthrough = false;

if (opacitySlider && mapFrame) {
  opacitySlider.addEventListener('input', () => {
    mapFrame.style.opacity = (opacitySlider.value / 100).toString();
  });
}

lockBtn.addEventListener('click', async () => {
  clickthrough = !clickthrough;
  lockBtn.classList.toggle('locked', clickthrough);
  lockBtn.textContent = clickthrough ? '🔓' : '🔒';
  lockBtn.title = clickthrough ? 'Klicks gehen durch zum Spiel' : 'Klick-durchlässig umschalten';
  try {
    await invoke('set_overlay_clickthrough', { clickthrough });
  } catch (err) {
    console.error(err);
  }
});

closeBtn.addEventListener('click', async () => {
  try {
    await invoke('close_overlay');
  } catch (err) {
    console.error(err);
  }
});
