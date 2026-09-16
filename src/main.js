import { bindKeyboardShortcuts } from './keyboard-shortcuts.js';
import { createEditorController } from './editor-controller.js';
import { createNavigation } from './navigation.js';
import { createNotesController } from './notes-controller.js';
import { createPinController } from './pin-controller.js';
import { createSettingsUi } from './settings-ui.js';
import { createStatusController } from './status-ui.js';
import { createThemeUi } from './theme-ui.js';
import { createUpdaterUi } from './updater-ui.js';
import { createWindowControls } from './window-controls.js';

const { invoke, Channel } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

const editorMount = document.getElementById('note-editor');
const container = document.getElementById('canvas-container');
const indicator = document.getElementById('note-indicator');
const settingsButton = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const appStatus = document.getElementById('app-status');
const shortcutTrigger = document.getElementById('shortcut-trigger');
const shortcutBody = document.getElementById('shortcut-body');
const importThemeButton = document.getElementById('btn-import-theme');
const themeFileInput = document.getElementById('theme-file-input');
const dropdownTrigger = document.getElementById('theme-dropdown-trigger');
const dropdownPanel = document.getElementById('theme-dropdown-panel');
const dropdownLabel = document.getElementById('theme-dropdown-label');
const updateBtn = document.getElementById('update-btn');
const updateVersion = document.getElementById('update-version');
const pinSection = document.getElementById('pin-section');
const pinSwitch = document.getElementById('pin-switch');
const pinButton = document.getElementById('btn-pin');

window.addEventListener('DOMContentLoaded', async () => {
  const status = createStatusController(appStatus);
  const editor = createEditorController({
    mount: editorMount,
    disabled: true
  });
  const notes = createNotesController({
    editor,
    indicator,
    invoke,
    status
  });

  const themeUi = createThemeUi({
    dropdownTrigger,
    dropdownPanel,
    dropdownLabel,
    importThemeButton,
    themeFileInput,
    status
  });
  const settings = createSettingsUi({
    settingsButton,
    settingsPanel,
    shortcutTrigger,
    shortcutBody
  });
  const navigation = createNavigation({
    editor,
    container,
    notes
  });
  const updater = createUpdaterUi({
    updateBtn,
    updateVersion,
    invoke,
    Channel
  });
  const pin = createPinController({
    invoke,
    pinButton,
    pinSection,
    pinSwitch
  });
  const windowControls = createWindowControls({
    appWindow,
    closeButton: document.getElementById('btn-close'),
    maximizeButton: document.getElementById('btn-maximize'),
    minimizeButton: document.getElementById('btn-minimize'),
    flushPendingSave: notes.flushPendingSave,
    invoke,
    status
  });

  editor.setDisabled(true);
  editor.onChange(notes.scheduleSave);

  themeUi.bind();
  settings.bind();
  navigation.bindWheel();
  updater.bind();
  pin.bind();
  windowControls.bind();
  bindKeyboardShortcuts({
    document,
    editor,
    navigation,
    notes,
    settings
  });

  try {
    await Promise.all([themeUi.init(), notes.init(), pin.init()]);
  } catch (error) {
    console.error('Startup failed:', error);
    status.show('Could not load notes');
  } finally {
    editor.setDisabled(false);
    editor.focus();
  }
});
