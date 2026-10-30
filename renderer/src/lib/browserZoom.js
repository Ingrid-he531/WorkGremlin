/**
 * Browser remote client: keep the browser's own zoom shortcuts from resizing the office.
 *
 * The Electron window is the local app, but the same UI is also served to a browser (`--static`).
 * In the browser, Ctrl/Cmd + `+` / `-` / `0` and Ctrl+wheel change the *browser* zoom. That changes
 * the CSS pixel viewport, the canvas re-fits, and the isometric scene's text / labels visibly jump
 * in size —— the remote client cannot keep the same "space" as the local window.
 *
 * Web pages cannot turn browser zoom off globally (the menu and OS-level zoom still work), but the
 * standard shortcuts can be cancelled in Chromium-based browsers. This guard is installed **only in
 * browser mode**; the Electron app keeps its normal behaviour.
 */

/** Keys the browser uses for zoom in/out/reset. `=` is the unshifted `+` key. */
const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0']);
const ZOOM_CODES = new Set(['NumpadAdd', 'NumpadSubtract', 'Numpad0']);

/**
 * @param {{ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean, key?:string, code?:string}} e
 * @returns {boolean} whether this keydown is a browser zoom shortcut
 */
export function isBrowserZoomKey(e) {
  if (!e || (!e.ctrlKey && !e.metaKey) || e.altKey) return false;
  return ZOOM_KEYS.has(String(e.key || '')) || ZOOM_CODES.has(String(e.code || ''));
}

/**
 * Ctrl/Cmd + wheel is browser zoom on desktop; a trackpad pinch also arrives as ctrl+wheel.
 * @param {{ctrlKey?:boolean, metaKey?:boolean}} e
 * @returns {boolean}
 */
export function isBrowserZoomWheel(e) {
  return Boolean(e && (e.ctrlKey || e.metaKey));
}

/**
 * Install the capture-phase guard. Capture runs before the app's own key handlers, and the canvas
 * wheel handler still receives the event (we cancel the browser default, not propagation), so
 * Ctrl+wheel over the office still zooms the scene instead of the page.
 *
 * @param {Window|EventTarget} [target] defaults to `window` when available
 * @returns {() => void} uninstall
 */
export function installBrowserZoomGuard(target) {
  const root = target || (typeof window !== 'undefined' ? window : null);
  if (!root || typeof root.addEventListener !== 'function') return () => {};

  const onKeyDown = (e) => {
    if (!isBrowserZoomKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onWheel = (e) => {
    if (!isBrowserZoomWheel(e)) return;
    // Cancel only the browser default. The engine's canvas listener still gets the event and does
    // its own scene zoom.
    e.preventDefault();
  };

  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('wheel', onWheel, { capture: true });
  };
}
