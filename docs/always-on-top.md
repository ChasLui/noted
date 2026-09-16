# Always-on-top / pinned windows in Tauri 2

Research notes for adding a pin / "always on top" feature to noted.

Scope: **Tauri 2.x**, Linux uses **GTK3** (`gtk` 0.18 / `webkit2gtk`), Windows uses
Win32. API facts verified against tauri 2.11.x, the `tao` `dev` branch, GTK
3.24 sources, the Wayland protocol XML, and Microsoft Learn. Where something
could not be verified against a primary source it is called out explicitly.

## TL;DR

- Tauri exposes this on all three layers: config `alwaysOnTop`, Rust
  `set_always_on_top` / `is_always_on_top`, JS `setAlwaysOnTop` /
  `isAlwaysOnTop`.
- **Windows: works.** Backed by `WS_EX_TOPMOST` via
  `SetWindowPos(HWND_TOPMOST)` and it does not steal focus.
- **Linux/X11: works.** Backed by the EWMH `_NET_WM_STATE_ABOVE` hint via
  `gtk_window_set_keep_above`.
- **Linux/Wayland (GNOME, Ubuntu default): does NOT work, and does not error.**
  The core `xdg-shell` protocol has no "above" state. Tauri calls GTK, GTK's
  Wayland backend implements `set_keep_above` as an empty function, so the call
  is a silent no-op and the Promise resolves successfully. This is the single
  biggest caveat for this app.

## 1. Tauri 2 API surface

### 1.1 Config field (startup state)

`WindowConfig.alwaysOnTop` is a `boolean` ("Whether the window should always be
on top of other windows"), default `false`:

- Config reference: <https://v2.tauri.app/reference/config/#windowconfig>

It is applied when the window is built, not through IPC, so it needs no
capability permission. On Linux the startup path calls GTK's
`set_keep_above` during window construction
(<https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/linux/window.rs#L204>),
which means the Wayland no-op applies here too (see section 3).

### 1.2 Rust

`tauri::WebviewWindow` (and `tauri::window::Window`) expose:

```rust
pub fn set_always_on_top(&self, always_on_top: bool) -> tauri::Result<()>;
pub fn is_always_on_top(&self) -> tauri::Result<bool>;
pub fn set_always_on_bottom(&self, always_on_bottom: bool) -> tauri::Result<()>;
```

- docs.rs: <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.set_always_on_top>
  and `#method.is_always_on_top`.
- Source: <https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/webview/webview_window.rs#L2173>

The implementation is a thin pass-through to the runtime; there is no Linux
platform gate and no `Err` on Wayland. `set_always_on_top` is documented
"desktop only"; `is_always_on_top` is "iOS / Android: Unsupported".

### 1.3 JavaScript

With `withGlobalTauri: true` (this repo), the frontend can use
`window.__TAURI__.window`:

```js
const { getCurrentWindow } = window.__TAURI__.window;

await getCurrentWindow().setAlwaysOnTop(true);
const pinned = await getCurrentWindow().isAlwaysOnTop();
```

- API reference: <https://v2.tauri.app/reference/javascript/api/namespacewindow/#setalwaysontop>
- Source: <https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/window.ts#L1283>

This repo already gets the window this way in `src/main.js`
(`const { getCurrentWindow } = window.__TAURI__.window;`) and passes `appWindow`
into `createWindowControls` in `src/window-controls.js`.

### 1.4 Capability / permission strings

Permissions are `core:window:*` entries in a capability file that targets the
window (this repo: `src-tauri/capabilities/default.json`, `"windows": ["main"]`).

| Purpose | Permission |
| --- | --- |
| Enable `setAlwaysOnTop` IPC | `core:window:allow-set-always-on-top` |
| Read `isAlwaysOnTop` | `core:window:allow-is-always-on-top` (already in `core:window:default`) |
| Enable `setAlwaysOnBottom` IPC | `core:window:allow-set-always-on-bottom` |

- Core permissions list: <https://v2.tauri.app/reference/acl/core-permissions/#window>
- Capability format: <https://v2.tauri.app/reference/acl/capability/>

Note: `core:window:default` (already present in this repo) includes
`allow-is-always-on-top` but **not** `allow-set-always-on-top`, so the getter
already works via JS and only the setter needs to be added.

Application-defined `#[tauri::command]` functions (like the ones in this repo)
are not gated by these capability strings, so a Rust wrapper command needs no
capability change. Only the direct JS window API path needs the permission.

## 2. Windows

- Mechanism: the window is given the extended style `WS_EX_TOPMOST`
  (`0x00000008`): "The window should be placed above all non-topmost windows and
  should stay above them, even when the window is deactivated. To add or remove
  this style, use the `SetWindowPos` function."
  <https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles>
- `tao` does exactly that: it flips a `WindowFlags::ALWAYS_ON_TOP` bit and calls
  `SetWindowPos(hwnd, HWND_TOPMOST | HWND_NOTOPMOST, 0,0,0,0,
  SWP_ASYNCWINDOWPOS | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)`.
  <https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/windows/window_state.rs#L322>
- Survives focus changes: yes. `HWND_TOPMOST` means "the window maintains its
  topmost position even when it is deactivated."
  <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos>
- Does not steal focus: confirmed by the `SWP_NOACTIVATE` flag above. It changes
  z-order only.
- Taskbar: topmost is independent of the taskbar button; use
  `set_skip_taskbar` to hide that button.
- Fullscreen: Microsoft's docs do not specify interaction with exclusive
  fullscreen (DirectX) apps. A topmost window is still in the normal desktop
  z-order band, so it is not guaranteed to cover a true exclusive-fullscreen
  game. Treat this as **unverified**.
- Virtual desktops: `tao`'s Windows backend has no
  `set_visible_on_all_workspaces` implementation, so Tauri's
  `setVisibleOnAllWorkspaces` is a no-op on Windows. Windows exposes virtual
  desktops through the `IVirtualDesktopManager` COM API, which has no
  "show on all desktops" primitive.

## 3. Linux

### 3.1 X11

On X11, GTK maps `gtk_window_set_keep_above` to the window manager request
`_NET_WM_STATE_ABOVE` (EWMH). GTK's own docs describe it as a request the WM may
ignore:

- `gtk_window_set_keep_above`:
  <https://docs.gtk.org/gtk3/method.Window.set_keep_above.html>
- `gdk_window_set_keep_above` (GDK layer):
  <https://docs.gtk.org/gdk3/method.Window.set_keep_above.html>

`tao`'s Linux backend calls `window.set_keep_above(...)` for
`WindowRequest::AlwaysOnTop`:
<https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/linux/event_loop.rs#L387>

On X11 this works under common WMs, including Mutter's XWayland/X11 path. The
window stays above other normal windows without taking focus.

### 3.2 Wayland (the critical part)

**The Wayland `xdg-shell` protocol has no client-controlled "always on top"
request.** The `xdg_toplevel` state enum is `maximized`, `fullscreen`,
`resizing`, `activated`, `tiled_left/right/top/bottom`, `suspended`, and
`constrained_*`. There is no "above"/"topmost" state, and no request to set one.
Source (protocol XML):
<https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/xdg-shell/xdg-shell.xml>

Stacking is controlled entirely by the compositor. GNOME's own historical
Wayland port notes list "Always on top won't work" as a known regression for
Wayland clients:
<https://wiki.gnome.org/ThreePointNine/Features/WaylandSupport>

**What Tauri actually does on Wayland.** Tauri passes the call down to `tao`,
which calls `gtk_window_set_keep_above` unconditionally. GTK forwards it to
`gdk_window_set_keep_above`, which dispatches to the backend. The GDK Wayland
backend implements it as an empty function:

```c
static void
gdk_wayland_window_set_keep_above (GdkWindow *window, gboolean setting)
{
}
```

Source:
<https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gdk/wayland/gdkwindow-wayland.c#L4684>
(the sibling `gdk_wayland_window_stick` / `_unstick` are likewise empty).

**Verdict:** on GNOME Wayland (Ubuntu's default), `set_always_on_top(true)`
**silently does nothing and returns success**. Nothing raises an error: the GDK
function returns `void`, `tao` returns `()`, and Tauri wraps it in `Ok(())`.
The JS `setAlwaysOnTop` Promise resolves.

There is a second gotcha: `is_always_on_top` on Linux is not stored from the
request. `tao` derives it from GTK's `GdkWindowState::ABOVE` window-state
signal (initialized from the config value at construction):
<https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/linux/window.rs>
On Wayland no such compositor state ever arrives, so after a runtime toggle
`isAlwaysOnTop()` can report `false` even though nothing happened either way.
Do not use the getter as a success check on Linux.

### 3.3 Ubuntu default session

- **Ubuntu 26.04 LTS (latest LTS, released 2026-04-23): Wayland-only.** Since
  25.10 "The Ubuntu Desktop session now runs only on the Wayland back end,
  because GNOME Shell can no longer run as an X.org session. You can still run
  applications developed for X.org through the XWayland compatibility layer."
  <https://documentation.ubuntu.com/release-notes/26.04/summary-for-lts-users>
- Ubuntu 24.04 LTS ships a Wayland session as the normal login and also offers
  an "Ubuntu on Xorg" session; its release notes still discuss Xorg sessions as
  a fallback for Nvidia.
  <https://documentation.ubuntu.com/release-notes/24.04/>

So on current Ubuntu the native X11 path is gone, but **XWayland is still
present and usable**.

### 3.4 Workarounds and their limits

| Approach | Works on GNOME Wayland? | Notes |
| --- | --- | --- |
| `GDK_BACKEND=x11` (run via XWayland) | Yes, practically | GTK uses its X11 backend, so `_NET_WM_STATE_ABOVE` is sent and Mutter honors it for XWayland clients. Must be set **before** GTK initializes (launcher env, not mid-process). XWayland is still shipped on Ubuntu 26.04. |
| GNOME Shell extension / window menu | Yes, user-driven | GNOME exposes "Always on Top" from its own window menu; it is compositor-side and not something a normal client requests. Extensions can toggle it, but that is a runtime dependency. |
| `wlr-layer-shell` | No (on GNOME) | It assigns a `layer_surface` role (background/bottom/top/overlay) for shell components; it is not a normal toplevel and is not a general "make my window topmost" API. Mutter has not implemented it: <https://gitlab.gnome.org/GNOME/mutter/-/issues/973> and <https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/1141>. It is supported by wlroots-based compositors (Sway, Hyprland, labwc, etc.), not Mutter. Protocol: <https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-layer-shell-unstable-v1.xml> |
| Set `alwaysOnTop` in config and hope | No | Same silent no-op, applied at window construction. |

## 3.5 Frameless windows: triggering the compositor's own menu

noted runs with `decorations: false`, so there is no title bar for the desktop to
hang its menu on. But the "Always on Top" entry is not owned by the title bar, it
is owned by the compositor, and a client can ask the compositor to show it. This
is the one route that works on GNOME Wayland without an extension, XWayland, or
a programmatic always-on-top request.

### How a normal (decorated) window does it

1. GTK3 `gtk_window_do_popup()` calls
   `gdk_window_show_window_menu(gdk_window, event)`:
   <https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gtk/gtkwindow.c#L9411>
2. The GDK Wayland backend implements that as
   `xdg_toplevel_show_window_menu(toplevel, seat, serial, x, y)`:
   <https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gdk/wayland/gdkwindow-wayland.c#L4999>
3. Mutter's `xdg_toplevel_show_window_menu` validates the seat serial, then calls
   `meta_window_show_menu(window, META_WINDOW_MENU_WM, x, y)`:
   <https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/wayland/meta-wayland-xdg-shell.c#L294>
4. GNOME Shell's `WindowMenu` builds the popup. It contains "Always on Top",
   wired to `window.make_above()` / `window.unmake_above()`:
   <https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/windowMenu.js#L85>

Nothing in that chain depends on decorations. A CSD title bar is just the widget
that normally calls step 1. A frameless app can call the same thing from its own
title bar.

### Two hard requirements

- **It must happen during the button press.** Mutter validates the serial with
  `meta_wayland_seat_get_grab_info`; after the click ends there is no implicit
  grab and the request is dropped. GDK derives the serial from the Wayland seat's
  current press serial:
  <https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gdk/wayland/gdkdevice-wayland.c#L5556>
- **It needs a real `GdkEvent`.** `gdk_wayland_window_show_window_menu` reads the
  device and coordinates off the event and walks the event window up to the
  toplevel. A synthetic event with no device or no window will not do.

The clean way to satisfy both is a capture-phase `GtkGestureMultiPress` on the
main `GtkWindow`. Its callback runs while the press (and the implicit grab) is
live, and `gtk_get_current_event()` hands back the real `GdkEvent`. That is
essentially what GTK's own
`multipress_gesture_pressed_cb` does:
<https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gtk/gtkwindow.c#L1469>

### Rust sketch (Linux only)

`tauri::WebviewWindow::gtk_window()` returns the `gtk::ApplicationWindow`, and
the `gdk` crate exposes `Window::show_window_menu(&mut Event) -> bool`:

```rust
#[cfg(target_os = "linux")]
fn install_window_menu_gesture(window: &tauri::WebviewWindow, titlebar_height: i32) {
    use gtk::prelude::*;

    let Ok(gtk_window) = window.gtk_window() else { return };

    let gesture = gtk::GestureMultiPress::new(&gtk_window);
    gesture.set_button(3);
    gesture.set_propagation_phase(gtk::PropagationPhase::Capture);
    gesture.connect_pressed(move |gesture, _n_press, _x, y| {
        // Only the custom title strip; leave right-clicks in the editor alone.
        if y as i32 >= titlebar_height {
            return;
        }
        let Some(mut event) = gtk::get_current_event() else { return };
        if let Some(gdk_window) = gesture.widget().and_then(|w| w.window()) {
            gdk_window.show_window_menu(&mut event);
        }
        // Claim the sequence so the webview does not also handle the click.
        gesture.set_state(gtk::EventSequenceState::Claimed);
    });
}
```

Notes:

- Must run on the GTK main thread. Tauri's `setup` hook is already there.
- `tauri::WebviewWindow::gtk_window()` is Linux/BSD only:
  <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.gtk_window>
- On X11 the same call sends `_GTK_SHOW_WINDOW_MENU`, and if the WM ignores it
  `gdk_window_show_window_menu` returns `false`; GTK's own fallback menu also has
  "Always on Top", but that fallback is a private GTK function, so for X11 prefer
  the real `set_always_on_top` toggle (section 1).
- What this gives you is the operating system's menu, the user still clicks
  "Always on Top". It is not a programmatic toggle and the app gets no state
  back. A true in-app pin toggle on GNOME Wayland needs a Shell extension or the
  XWayland route.

### Already available with no code

GNOME Shell maintainer Florian Müllner notes that **Super+right-click anywhere in
the window** opens the same menu, which means a frameless window can already
reach "Always on Top" today:
<https://discourse.gnome.org/t/add-a-way-to-access-always-on-top-for-apps-without-titlebar-or-apps-with-a-titlebar-that-doesnt-activate-the-gnome-decorations-menu-on-right-click/26849>

The gesture above just makes that discoverable from the app's own title bar.

## 4. UX / behavior caveats

- **Focus:** always-on-top affects stacking only, not focus. Windows uses
  `SWP_NOACTIVATE`; on X11 it is a WM hint. It will not steal focus when
  toggled, but a pinned window will still be raised above others when focused.
- **Hide/show + the existing `--toggle` hotkey:** the single-instance callback
  in `src-tauri/src/lib.rs` hides/shows the `main` window and calls
  `set_focus()`. Pinning is a window flag, so in principle it survives
  hide/show. Hiding unmaps the window, though; some X11 WMs drop
  `_NET_WM_STATE_ABOVE` on unmap. If this feature is added, **re-assert
  `set_always_on_top(true)` after `show()`** in the toggle path when the pinned
  preference is on. This is cheap and avoids the inconsistency.
- **"Always on top" vs "on desktop":** the request "pinned on desktop" is
  ambiguous. Two different behaviors exist:
  - `set_always_on_top(true)` -> floats above all normal windows (what the
    described behavior sounds like).
  - `set_always_on_bottom(true)` -> stays below other windows; closest to a
    desktop-widget / pinned-to-desktop feel. On Windows this is `HWND_BOTTOM`,
    on Linux `set_keep_below`; both are no-ops on Wayland for the same reason.
  Confirm which one the user wants before implementing.
- **Virtual desktops / workspaces:**
  - X11: `setVisibleOnAllWorkspaces(true)` -> `gtk_window_stick()`
    (`_NET_WM_STATE_STICKY`).
  - Wayland: `gdk_wayland_window_stick` is empty, so it is a no-op (GNOME's
    "Always on Visible Workspace" is user-controlled).
  - Windows: not implemented by `tao`, effectively a no-op.

## 5. Implementation sketch for noted

Default state in `src-tauri/tauri.conf.json` under the `main` window (currently
has no such key):

```json
{
  "title": "noted",
  "width": 340,
  "height": 440,
  "minWidth": 340,
  "minHeight": 440,
  "decorations": false,
  "transparent": true,
  "center": true,
  "alwaysOnTop": false
}
```

Rust command in `src-tauri/src/lib.rs`, added next to the existing commands and
registered in `generate_handler![...]`:

```rust
#[tauri::command]
fn set_pinned(window: tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    window
        .set_always_on_top(pinned)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn is_pinned(window: tauri::WebviewWindow) -> Result<bool, String> {
    window
        .is_always_on_top()
        .map_err(|error| error.to_string())
}
```

Frontend toggle (e.g. in `src/window-controls.js`, mirroring the existing
`minimize` / `toggleMaximize` handlers):

```js
export function createWindowControls({ appWindow, invoke, pinButton, /* ... */ }) {
  let pinned = false;

  function bind() {
    pinButton?.addEventListener('mousedown', async (e) => {
      e.stopPropagation();
      pinned = !pinned;
      try {
        await appWindow.setAlwaysOnTop(pinned);
        pinButton.dataset.pinned = pinned ? 'true' : 'false';
      } catch (error) {
        console.error('Pin failed:', error);
        pinned = !pinned;
      }
    });
  }
}
```

Capabilities: if using the JS window API (`appWindow.setAlwaysOnTop`) instead of
the Rust command, add the setter permission to
`src-tauri/capabilities/default.json`. Reading already works via
`core:window:default`.

```json
"core:window:allow-set-always-on-top"
```

**Linux note:** on Ubuntu's default Wayland session the JS call above resolves
but has no visible effect. For the feature to actually work on Ubuntu, ship the
XWayland workaround: launch the app with `GDK_BACKEND=x11` (set in the packaged
`.desktop` `Exec=` or a wrapper, before GTK initializes). Otherwise gate the UI
with a note that pinning is unavailable on Wayland, or accept that it silently
does nothing.

