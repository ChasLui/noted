const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

const canvas = document.getElementById('note-canvas');
let saveTimeout = null;

// Load saved note on startup
async function loadNote() {
  try {
    const content = await invoke('load_note');
    canvas.value = content;
  } catch (err) {
    console.error('Failed to load note:', err);
  }
}

// Auto-save with a short debounce
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      await invoke('save_note', { content: canvas.value });
    } catch (err) {
      console.error('Failed to save note:', err);
    }
  }, 300);
}

window.addEventListener('DOMContentLoaded', () => {
  loadNote();
  canvas.focus();

  canvas.addEventListener('input', scheduleSave);

  // Window controls — stopPropagation prevents drag region from swallowing clicks
  document.getElementById('btn-minimize')?.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    appWindow.minimize();
  });
  document.getElementById('btn-maximize')?.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    appWindow.toggleMaximize();
  });
  document.getElementById('btn-close')?.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    appWindow.close();
  });
});
