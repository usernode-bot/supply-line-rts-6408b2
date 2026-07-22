// Pointer-first input: one Pointer Events code path for mouse, touch and
// pen. Single-pointer drag pans (touch) or box-selects (mouse); pinch
// zooms; a tap within the slop threshold selects / resolves an armed
// order. Desktop extras (right-click orders, WASD/edge pan, wheel zoom,
// trackpad scroll-pan / pinch-zoom, Esc) are shortcuts layered on top —
// never the only path.

const SLOP = 8; // CSS px before a press becomes a drag

export function createInput({ canvas, minimap, view, handlers }) {
  const pointers = new Map();
  let mode = null; // null | 'maybe' | 'pan' | 'pinch' | 'box'
  let start = null;
  let panStart = null;
  let pinch = null;
  let boxRect = null;
  // shift held when the box drag started (#136) — read live from the
  // pointer event, never from tracked key state, so a missed Shift keyup
  // (focus stolen without a blur) can't leave additive select stuck on
  let boxAdditive = false;
  const keys = new Set();
  let mousePos = null;
  let mapSize = { w: 96, h: 96 };

  // selection box overlay
  const selbox = document.createElement('div');
  selbox.style.cssText = 'position:absolute;border:1px solid rgba(255,255,255,0.8);background:rgba(139,92,246,0.15);pointer-events:none;display:none;z-index:15';
  canvas.parentElement.appendChild(selbox);

  function cssSize() {
    return { w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight };
  }

  function worldFromScreen(px, py) {
    const { w, h } = cssSize();
    return { x: (px - w / 2) / view.scale + view.cx, y: (py - h / 2) / view.scale + view.cy };
  }

  function clampView() {
    const { w, h } = cssSize();
    const minScale = Math.max(3, Math.min(w / mapSize.w, h / mapSize.h) * 0.9);
    view.scale = Math.max(minScale, Math.min(96, view.scale)); // 96 px/tile ≈ close-up on a single blob (#60)
    view.cx = Math.max(0, Math.min(mapSize.w, view.cx));
    view.cy = Math.max(0, Math.min(mapSize.h, view.cy));
  }

  function setMapSize(w, h) { mapSize = { w, h }; clampView(); }

  // -- canvas pointer events ------------------------------------------

  canvas.addEventListener('pointerdown', (e) => {
    // Reclaim keyboard focus from any UI control (e.g. a panel slider);
    // preventDefault() below suppresses the browser's native focus
    // transfer, so without this a focused slider would swallow keys.
    canvas.focus({ preventScroll: true });
    if (e.button === 2) return; // handled via contextmenu
    gestureBase = null; // a real pointer takes over from any Safari pinch
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      mode = 'pinch';
      if (handlers.gesture) handlers.gesture();
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        scale: view.scale,
        mid: worldFromScreen((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      selbox.style.display = 'none';
    } else if (pointers.size === 1) {
      start = { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button };
      panStart = { cx: view.cx, cy: view.cy };
      mode = e.button === 1 ? 'pan' : 'maybe';
      if (mode === 'pan' && handlers.gesture) handlers.gesture();
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') mousePos = { x: e.clientX, y: e.clientY };
      return;
    }
    const p = pointers.get(e.pointerId);
    p.x = e.clientX; p.y = e.clientY;
    if (e.pointerType === 'mouse') mousePos = { x: e.clientX, y: e.clientY };

    if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      view.scale = pinch.scale * (d / Math.max(20, pinch.d));
      clampView();
      // keep the pinch midpoint's world position under the fingers
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      const { w, h } = cssSize();
      view.cx = pinch.mid.x - (midX - w / 2) / view.scale;
      view.cy = pinch.mid.y - (midY - h / 2) / view.scale;
      clampView();
      return;
    }
    if (mode === 'maybe' && start) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) {
        // touch box-select: in the phone UI's Drag mode a one-finger drag
        // draws a selection box (always additive — each box unions into
        // the drag group); two-finger pan/pinch is untouched
        const touchBox = start.type !== 'mouse' && handlers.touchBox && handlers.touchBox();
        mode = ((start.type === 'mouse' && start.button === 0) || touchBox) ? 'box' : 'pan';
        if (mode === 'box') boxAdditive = touchBox || e.shiftKey; // shift = add to selection (#136)
        if (handlers.gesture) handlers.gesture();
      }
    }
    if (mode === 'pan' && start) {
      view.cx = panStart.cx - (e.clientX - start.x) / view.scale;
      view.cy = panStart.cy - (e.clientY - start.y) / view.scale;
      clampView();
    } else if (mode === 'box' && start) {
      boxRect = {
        x0: Math.min(start.x, e.clientX), y0: Math.min(start.y, e.clientY),
        x1: Math.max(start.x, e.clientX), y1: Math.max(start.y, e.clientY),
      };
      selbox.style.display = 'block';
      selbox.style.left = boxRect.x0 + 'px';
      selbox.style.top = boxRect.y0 + 'px';
      selbox.style.width = (boxRect.x1 - boxRect.x0) + 'px';
      selbox.style.height = (boxRect.y1 - boxRect.y0) + 'px';
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (mode === 'pinch') {
      if (pointers.size === 1) {
        const [a] = [...pointers.values()];
        start = { x: a.x, y: a.y, type: 'touch', button: 0 };
        panStart = { cx: view.cx, cy: view.cy };
        a.sx = a.x; a.sy = a.y;
        mode = 'pan';
      } else if (pointers.size === 0) {
        mode = null;
      }
      return;
    }
    if (mode === 'maybe' && e.type === 'pointerup') {
      handlers.tap(worldFromScreen(e.clientX, e.clientY), e.pointerType, { x: e.clientX, y: e.clientY });
    } else if (mode === 'box' && boxRect) {
      const a = worldFromScreen(boxRect.x0, boxRect.y0);
      const b = worldFromScreen(boxRect.x1, boxRect.y1);
      handlers.box({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, boxAdditive);
    }
    selbox.style.display = 'none';
    boxRect = null;
    mode = null;
    start = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    handlers.rightClick(worldFromScreen(e.clientX, e.clientY), e.shiftKey);
  });

  // Trackpad two-finger scroll pans, pinch zooms (#124). Pinch arrives as
  // ctrl-wheel (Chrome/Edge/Firefox); plain wheel is classified trackpad
  // (pan) vs mouse (zoom) by the shape of its deltas, erring toward mouse.
  let trackpadUntil = 0; // hysteresis: mid-stream samples stay trackpad

  function zoomAt(clientX, clientY, factor) {
    const before = worldFromScreen(clientX, clientY);
    view.scale *= factor;
    clampView();
    const { w, h } = cssSize();
    view.cx = before.x - (clientX - w / 2) / view.scale;
    view.cy = before.y - (clientY - h / 2) / view.scale;
    clampView();
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (handlers.gesture) handlers.gesture();
    // line/page delta modes normalised to px
    let dy = e.deltaY, dx = e.deltaX;
    if (e.deltaMode === 1) { dy *= 33; dx *= 33; }
    else if (e.deltaMode === 2) { dy *= cssSize().h; dx *= cssSize().h; }

    // pinch (synthesised as ctrl-wheel) or explicit ctrl/cmd+scroll: zoom
    // at pinch rate — the conventional exp(-dy/100) mapping for pinch deltas
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-dy / 100));
      return;
    }

    // classify trackpad-scroll vs mouse-wheel: wheels never send horizontal
    // or fractional deltas, and their non-standard wheelDeltaY comes in
    // multiples of 120; ambiguous samples inside an active trackpad stream
    // stay trackpad (hysteresis) so a pan never zoom-jumps mid-flick
    const now = performance.now();
    let trackpad;
    if (e.deltaMode !== 0) trackpad = false;
    else if (e.deltaX !== 0 || !Number.isInteger(e.deltaY)) trackpad = true;
    else if (now < trackpadUntil) trackpad = true;
    else if (typeof e.wheelDeltaY === 'number') trackpad = !(e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0);
    else trackpad = false; // no signal → preserve mouse-wheel zoom

    if (trackpad) {
      trackpadUntil = now + 300;
      view.cx += dx / view.scale;
      view.cy += dy / view.scale;
      clampView();
    } else {
      trackpadUntil = 0;
      // delta-proportional zoom (#81): ~×1.08 per standard 120px wheel notch
      zoomAt(e.clientX, e.clientY, Math.pow(2, -dy * 0.0009));
    }
  }, { passive: false });

  // Safari doesn't synthesise ctrl-wheel for trackpad pinch — it fires
  // proprietary gesture events instead. preventDefault() is what stops
  // Safari's full-page pinch zoom (touch-action doesn't cover trackpads).
  // Other browsers never fire these, so the listeners are inert there.
  let gestureBase = null;
  canvas.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    // iPadOS Safari fires gesture events for touch pinches too — the
    // pointer-event pinch path already owns those
    if (pointers.size >= 2) return;
    gestureBase = { scale: view.scale, x: e.clientX, y: e.clientY };
    if (handlers.gesture) handlers.gesture();
  });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!gestureBase) return;
    zoomAt(e.clientX, e.clientY, (gestureBase.scale * e.scale) / view.scale);
  });
  canvas.addEventListener('gestureend', (e) => {
    e.preventDefault();
    gestureBase = null;
  });

  // -- minimap: tap/drag to jump --------------------------------------

  function minimapJump(e) {
    const r = minimap.getBoundingClientRect();
    view.cx = ((e.clientX - r.left) / r.width) * mapSize.w;
    view.cy = ((e.clientY - r.top) / r.height) * mapSize.h;
    clampView();
  }
  minimap.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    minimap.setPointerCapture(e.pointerId);
    if (handlers.gesture) handlers.gesture();
    minimapJump(e);
    e.preventDefault();
    e.stopPropagation();
  });
  minimap.addEventListener('pointermove', (e) => {
    if (e.buttons) { minimapJump(e); e.preventDefault(); }
  });

  // -- keyboard --------------------------------------------------------

  // Keys are tracked by KeyboardEvent.code (physical position), so WASD
  // panning works the same on AZERTY / Dvorak / remapped layouts.
  // Only genuine text-entry contexts swallow keys; non-text controls
  // (range sliders, checkboxes, buttons) must never block WASD/Esc.
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'password', 'email', 'number', 'url', 'tel']);
  function isTextEntry(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    // missing/unknown type attribute defaults to text-like
    return tag === 'INPUT' && TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase());
  }
  window.addEventListener('keydown', (e) => {
    if (isTextEntry(e.target)) return;
    // Browser/OS chords (Cmd/Ctrl/Alt + key) are never game input: don't
    // track them (macOS suppresses keyup for keys pressed under Cmd, so
    // they'd stick in the Set and pan forever) and don't preventDefault,
    // so Cmd/Ctrl+digit tab switching etc. pass through untouched. Shift
    // stays out of this guard — shift+digit assigns control groups.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    keys.add(e.code);
    if (e.code === 'Escape') handlers.cancel();
    // space toggles pause in single-player (#168); preventDefault stops
    // the page scrolling and a focused button from being "clicked"
    if (e.code === 'Space' && handlers.pauseKey) {
      handlers.pauseKey();
      e.preventDefault();
    }
    // control groups (#69): shift+digit assigns, digit selects (double-tap
    // centers) — main.js owns the group state via the groupKey handler
    const dg = /^Digit([1-9])$/.exec(e.code);
    if (dg && handlers.groupKey) {
      handlers.groupKey(+dg[1], e.shiftKey);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); });

  // called each frame for keyboard / edge panning
  function update(dtMs) {
    const panPx = 0.6 * dtMs; // px per ms
    let dx = 0, dy = 0;
    // full WASD pan
    if (keys.has('KeyW') || keys.has('ArrowUp')) dy -= panPx;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dy += panPx;
    if (keys.has('KeyA') || keys.has('KeyQ') || keys.has('ArrowLeft')) dx -= panPx;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += panPx;
    // edge scroll (mouse only, when not dragging)
    if (mousePos && mode === null && document.hasFocus()) {
      const { w, h } = cssSize();
      const M = 16;
      if (mousePos.x < M) dx -= panPx;
      if (mousePos.x > w - M) dx += panPx;
      if (mousePos.y < M) dy -= panPx;
      if (mousePos.y > h - M) dy += panPx;
    }
    if (dx || dy) {
      view.cx += dx / view.scale;
      view.cy += dy / view.scale;
      clampView();
    }
  }

  return {
    update, worldFromScreen, setMapSize, clampView,
    // last known mouse position in world coords (null before any mouse
    // move — i.e. on touch-only devices); drives the build-placement
    // hover preview (#94)
    get mouseWorld() { return mousePos ? worldFromScreen(mousePos.x, mousePos.y) : null; },
  };
}
