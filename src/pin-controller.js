const STORAGE_KEY = 'noted.pinned';

export function createPinController({
  invoke,
  pinButton,
  pinSection,
  pinSwitch
}) {
  let pinned = false;

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function store() {
    try {
      localStorage.setItem(STORAGE_KEY, pinned ? '1' : '0');
    } catch {
      // Pin state is a convenience; ignore storage failures.
    }
  }

  function render() {
    pinButton?.classList.toggle('active', pinned);
    pinButton?.setAttribute('aria-pressed', String(pinned));
    if (pinButton) pinButton.hidden = !pinned;
    pinSwitch?.setAttribute('aria-checked', String(pinned));
  }

  async function setPinned(next) {
    const target = Boolean(next);

    try {
      await invoke('set_pinned', { pinned: target });
    } catch (error) {
      console.error('Pin failed:', error);
      return;
    }

    pinned = target;
    render();
    store();
  }

  async function init() {
    const supported = await invoke('pin_supported').catch(() => false);

    if (!supported) {
      // Wayland cannot honor always-on-top; the title bar right-click menu is
      // the only route there, so keep the control out of the way.
      if (pinSection) pinSection.hidden = true;
      if (pinButton) pinButton.hidden = true;
      return;
    }

    if (pinSection) pinSection.hidden = false;

    if (readStored()) {
      await setPinned(true);
    } else {
      render();
    }
  }

  function bind() {
    pinSwitch?.addEventListener('click', () => {
      setPinned(!pinned);
    });

    // The title bar pin is the quick way to unpin.
    pinButton?.addEventListener('mousedown', (event) => {
      event.stopPropagation();
      if (pinned) setPinned(false);
    });
  }

  return {
    bind,
    init
  };
}
