export function createUpdaterUi({
  updateBtn,
  updateVersion,
  invoke,
  Channel
}) {
  let updateAvailable = null;
  let currentVersion = null;

  function bind() {
    refreshCurrentVersion();

    updateBtn?.addEventListener('click', async () => {
      if (updateAvailable) {
        try {
          updateBtn.textContent = 'Installing…';
          updateBtn.disabled = true;
          await invoke('plugin:updater|download_and_install', {
            onEvent: new Channel(),
            rid: updateAvailable.rid
          });
          await invoke('plugin:process|restart');
        } catch (err) {
          console.error('Update install failed:', err);
          updateBtn.textContent = 'Install failed';
          updateBtn.disabled = false;
          updateBtn.classList.remove('install');
          updateAvailable = null;
        }
      } else {
        checkForUpdates();
      }
    });
  }

  async function checkForUpdates() {
    try {
      const displayVersion = currentVersion || await refreshCurrentVersion();
      const metadata = await invoke('plugin:updater|check');

      if (metadata) {
        updateAvailable = metadata;
        updateBtn.textContent = 'Install Update';
        updateBtn.classList.add('install');
        if (updateVersion) {
          updateVersion.textContent = metadata.version ? `v${metadata.version}` : `v${displayVersion}`;
        }
      } else {
        updateAvailable = null;
        updateBtn.textContent = 'Up to date';
        updateBtn.classList.remove('install');
        updateBtn.disabled = true;
        setTimeout(() => {
          updateBtn.textContent = 'Check for Updates';
          updateBtn.disabled = false;
        }, 3000);
      }
    } catch (err) {
      console.error('Update check failed:', err);
      updateBtn.textContent = 'Could not check';
      updateBtn.disabled = true;
      setTimeout(() => {
        updateBtn.textContent = 'Check for Updates';
        updateBtn.disabled = false;
      }, 3000);
    }
  }

  async function refreshCurrentVersion() {
    try {
      currentVersion = await invoke('get_app_version');
      if (updateVersion) updateVersion.textContent = `v${currentVersion}`;
      return currentVersion;
    } catch (err) {
      console.error('Could not read app version:', err);
      if (updateVersion && !updateVersion.textContent) updateVersion.textContent = 'v?';
      return currentVersion || '?';
    }
  }

  return {
    bind
  };
}
