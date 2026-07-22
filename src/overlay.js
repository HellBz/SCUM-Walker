const { invoke } = window.__TAURI__.core;

const closeBtn = document.getElementById('closeBtn');
const opacitySlider = document.getElementById('opacitySlider');
const mapFrame = document.getElementById('mapFrame');

if (opacitySlider && mapFrame) {
  opacitySlider.addEventListener('input', () => {
    mapFrame.style.opacity = (opacitySlider.value / 100).toString();
  });
}

closeBtn.addEventListener('click', async () => {
  try {
    await invoke('close_overlay');
  } catch (err) {
    console.error(err);
  }
});
