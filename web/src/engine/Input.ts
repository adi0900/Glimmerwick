/**
 * Input: keyboard + mouse (pointer-lock or drag) + gamepad + touch (virtual stick placeholder) folded into the
 * `Float32Array[16]` block the sim consumes (ARCHITECTURE.md §4):
 *
 *   0 move_x(-1..1, right+) · 1 move_y(-1..1, forward+) · 2 look_dx · 3 look_dy (px since last poll) ·
 *   4 buttons bitmask · 5 camera_yaw (rad) · 6 camera_pitch · 7 zoom · 8-15 reserved
 *
 * Camera yaw/pitch/zoom are integrated HERE from the look deltas so the sim, the follow camera and the UI agree
 * on one source of truth (`input.yaw / pitch / zoom`). Conventions:
 *   yaw   : rotation about +Y; camera forward = (-sin yaw, 0, -cos yaw); mouse right => yaw decreases
 *   pitch : camera elevation above the horizon in radians (+ = camera above, looking down); mouse up => pitch decreases
 *   zoom  : 0 (close) .. 1 (far), mouse wheel
 * A quick tap is latched so it survives until the next poll even if the key is released in between.
 */

export const Btn = {
  JUMP: 1,
  INTERACT: 2,
  SPRINT: 4,
  USE_TOOL: 8,
  CANCEL: 16,
  MENU: 32,
  BUILD_TOGGLE: 64,
  PHOTO: 128,
  TOOL_NEXT: 256,
  TOOL_PREV: 512,
} as const;

const KEY_BUTTONS: Record<string, number> = {
  Space: Btn.JUMP,
  KeyE: Btn.INTERACT,
  Enter: Btn.INTERACT,
  ShiftLeft: Btn.SPRINT,
  ShiftRight: Btn.SPRINT,
  KeyF: Btn.USE_TOOL,
  Escape: Btn.CANCEL,
  Tab: Btn.MENU,
  KeyB: Btn.BUILD_TOGGLE,
  KeyP: Btn.PHOTO,
  KeyR: Btn.TOOL_NEXT,
  KeyQ: Btn.TOOL_PREV,
};

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ...Object.keys(KEY_BUTTONS),
]);

const STICK_RADIUS = 64;
const GAMEPAD_LOOK_PX_PER_S = 760;
const DEADZONE = 0.16;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export class Input {
  /** when false (menu open, photo mode, ...) gameplay input is zeroed; CANCEL/MENU still pass */
  enabled = true;
  yaw = 0;
  pitch = 0.42;
  zoom = 0.45;
  lookSensitivity = 0.0024;
  invertY = false;
  /** the engine sets this false while a gallery/photo camera override owns the camera */
  lookEnabled = true;
  /** allow click-to-capture the mouse (game view, interactive sessions) */
  pointerLockEnabled = false;
  touchActive = false;
  gamepadName = '';

  /**
   * gallery-orbit hooks (engine): raw drag in px with the buttons mask, and wheel delta.
   * Return true when the event was consumed (otherwise it falls through to mouse-look / zoom).
   */
  onDrag: ((dx: number, dy: number, buttons: number, e: PointerEvent) => boolean) | null = null;
  onWheel: ((deltaY: number, e: WheelEvent) => boolean) | null = null;

  private readonly keys = new Set<string>();
  private mouseButtons = 0;
  private latch = 0;
  private lookDx = 0;
  private lookDy = 0;
  private lastPointer: { x: number; y: number } | null = null;
  private gestureCbs: Array<() => void> = [];
  private gestured = false;
  private disposers: Array<() => void> = [];

  // touch
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private touchLook: { id: number; x: number; y: number } | null = null;
  private touchBtn = 0;
  private touchUi: { ring: HTMLElement; knob: HTMLElement; root: HTMLElement } | null = null;

  constructor(private readonly target: HTMLElement) {
    const on = <K extends keyof WindowEventMap>(t: Window | HTMLElement | Document, ev: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opts);
      this.disposers.push(() => t.removeEventListener(ev, fn, opts));
    };
    on(window, 'keydown', (e: KeyboardEvent) => this.keyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.keyUp(e));
    on(window, 'blur', () => this.releaseAll());
    on(document, 'visibilitychange', () => document.hidden && this.releaseAll());
    on(target, 'pointerdown', (e: PointerEvent) => this.pointerDown(e));
    on(window, 'pointermove', (e: PointerEvent) => this.pointerMove(e));
    on(window, 'pointerup', (e: PointerEvent) => this.pointerUp(e));
    on(window, 'pointercancel', (e: PointerEvent) => this.pointerUp(e));
    on(target, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(target, 'contextmenu', (e: Event) => e.preventDefault());
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.target || document.pointerLockElement?.tagName === 'CANVAS';
  }

  /** raw key state (e.code), for modules that need extra keys */
  key(code: string): boolean {
    return this.keys.has(code);
  }

  /** run `cb` once on the first user gesture (browsers need one to unlock audio / pointer lock) */
  onFirstGesture(cb: () => void): void {
    if (this.gestured) cb();
    else this.gestureCbs.push(cb);
  }

  setLook(yaw: number, pitch: number, zoom?: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
    if (zoom !== undefined) this.zoom = zoom;
  }

  /** Fill the sim input block for this frame and clear the per-frame deltas. */
  poll(dt: number, out: Float32Array): void {
    out.fill(0);
    let mx = 0;
    let my = 0;
    let buttons = 0;
    let dx = this.lookDx;
    let dy = this.lookDy;
    this.lookDx = this.lookDy = 0;

    if (this.enabled) {
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my -= 1;
      for (const k of this.keys) buttons |= KEY_BUTTONS[k] ?? 0;
      if (this.pointerLocked && (this.mouseButtons & 1) !== 0) buttons |= Btn.USE_TOOL;
      buttons |= this.touchBtn;

      if (this.stick) {
        const sx = (this.stick.x - this.stick.ox) / STICK_RADIUS;
        const sy = (this.stick.y - this.stick.oy) / STICK_RADIUS;
        mx += clamp(sx, -1, 1);
        my += clamp(-sy, -1, 1);
      }

      // gamepad
      const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        this.gamepadName = pad.id;
        const ax = (i: number) => pad.axes[i] ?? 0;
        const b = (i: number) => pad.buttons[i]?.pressed || (pad.buttons[i]?.value ?? 0) > 0.45;
        const [lx, ly] = radialDeadzone(ax(0), ax(1));
        const [rx, ry] = radialDeadzone(ax(2), ax(3));
        mx += lx;
        my -= ly;
        dx += rx * GAMEPAD_LOOK_PX_PER_S * dt;
        dy += ry * GAMEPAD_LOOK_PX_PER_S * dt;
        if (b(0)) buttons |= Btn.JUMP;
        if (b(1)) buttons |= Btn.CANCEL;
        if (b(2)) buttons |= Btn.INTERACT;
        if (b(3)) buttons |= Btn.PHOTO;
        if (b(4)) buttons |= Btn.TOOL_PREV;
        if (b(5)) buttons |= Btn.TOOL_NEXT;
        if (b(6) || b(10)) buttons |= Btn.SPRINT;
        if (b(7)) buttons |= Btn.USE_TOOL;
        if (b(9)) buttons |= Btn.MENU;
        if (b(12)) buttons |= Btn.BUILD_TOGGLE;
        break; // first pad only
      }

      const len = Math.hypot(mx, my);
      if (len > 1) {
        mx /= len;
        my /= len;
      }
    } else {
      buttons |= this.latch & (Btn.CANCEL | Btn.MENU);
      dx = dy = 0;
    }
    buttons |= this.latch;
    this.latch = 0;

    if (this.lookEnabled && this.enabled) {
      this.yaw -= dx * this.lookSensitivity;
      this.pitch += dy * this.lookSensitivity * (this.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, 0.02, 1.4);
      this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    } else {
      dx = dy = 0;
    }

    out[0] = mx;
    out[1] = my;
    out[2] = dx;
    out[3] = dy;
    out[4] = buttons;
    out[5] = this.yaw;
    out[6] = this.pitch;
    out[7] = this.zoom;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.touchUi?.root.remove();
  }

  // ------------------------------------------------------------------ keyboard

  private gesture(): void {
    if (this.gestured) return;
    this.gestured = true;
    for (const cb of this.gestureCbs) {
      try {
        cb();
      } catch (e) {
        console.error('[input] gesture callback failed', e);
      }
    }
    this.gestureCbs.length = 0;
  }

  private keyDown(e: KeyboardEvent): void {
    this.gesture();
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!e.repeat) {
      const bit = KEY_BUTTONS[e.code];
      if (bit) this.latch |= bit;
    }
    this.keys.add(e.code);
  }

  private keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }

  private releaseAll(): void {
    this.keys.clear();
    this.mouseButtons = 0;
    this.stick = null;
    this.touchLook = null;
    this.touchBtn = 0;
    this.updateTouchUi();
  }

  // ------------------------------------------------------------------ pointer

  private pointerDown(e: PointerEvent): void {
    this.gesture();
    if (e.pointerType === 'touch') return this.touchDown(e);
    this.mouseButtons = e.buttons;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.latch |= e.button === 0 && this.pointerLocked ? Btn.USE_TOOL : 0;
    if (this.pointerLockEnabled && this.lookEnabled && !this.pointerLocked && e.button === 0) {
      try {
        const p: any = this.target.requestPointerLock?.();
        p?.catch?.(() => undefined);
      } catch {
        /* pointer lock refused: drag-look still works */
      }
    }
  }

  private pointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') return this.touchMove(e);
    const locked = this.pointerLocked;
    const dx = locked ? e.movementX : this.lastPointer ? e.clientX - this.lastPointer.x : 0;
    const dy = locked ? e.movementY : this.lastPointer ? e.clientY - this.lastPointer.y : 0;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.mouseButtons = e.buttons;
    if (locked || e.buttons !== 0) {
      const handled = !locked && this.onDrag ? this.onDrag(dx, dy, e.buttons, e) : false;
      if (!handled && this.lookEnabled) {
        this.lookDx += dx;
        this.lookDy += dy;
      }
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') return this.touchUp(e);
    this.mouseButtons = e.buttons;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.onWheel && this.onWheel(e.deltaY, e)) return;
    this.zoom = clamp(this.zoom + e.deltaY * 0.0006, 0, 1);
  }

  // ------------------------------------------------------------------ touch (placeholder UI)

  private ensureTouchUi(): void {
    if (this.touchUi) return;
    this.touchActive = true;
    const host = document.getElementById('ui') ?? document.body;
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:20';
    const ring = document.createElement('div');
    ring.style.cssText = `position:absolute;width:${STICK_RADIUS * 2}px;height:${STICK_RADIUS * 2}px;margin:-${STICK_RADIUS}px 0 0 -${STICK_RADIUS}px;border-radius:50%;background:rgba(255,247,232,.12);border:2px solid rgba(255,247,232,.35);display:none`;
    const knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(255,247,232,.55);display:none';
    root.append(ring, knob);
    const mkBtn = (label: string, right: number, bottom: number, bit: number) => {
      const b = document.createElement('div');
      b.textContent = label;
      b.style.cssText = `position:absolute;right:${right}px;bottom:${bottom}px;width:68px;height:68px;border-radius:50%;background:rgba(255,247,232,.22);border:2px solid rgba(255,247,232,.5);color:#fff7e8;font:700 14px 'Nunito Variable',sans-serif;display:grid;place-items:center;pointer-events:auto;touch-action:none`;
      b.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        this.touchBtn |= bit;
        this.latch |= bit;
      });
      const up = () => (this.touchBtn &= ~bit);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      root.append(b);
    };
    mkBtn('Jump', 28, 36, Btn.JUMP);
    mkBtn('Use', 112, 92, Btn.INTERACT);
    host.append(root);
    this.touchUi = { ring, knob, root };
  }

  private updateTouchUi(): void {
    if (!this.touchUi) return;
    const { ring, knob } = this.touchUi;
    if (this.stick) {
      ring.style.display = knob.style.display = 'block';
      ring.style.left = `${this.stick.ox}px`;
      ring.style.top = `${this.stick.oy}px`;
      const dx = clamp(this.stick.x - this.stick.ox, -STICK_RADIUS, STICK_RADIUS);
      const dy = clamp(this.stick.y - this.stick.oy, -STICK_RADIUS, STICK_RADIUS);
      knob.style.left = `${this.stick.ox + dx}px`;
      knob.style.top = `${this.stick.oy + dy}px`;
    } else ring.style.display = knob.style.display = 'none';
  }

  private touchDown(e: PointerEvent): void {
    this.ensureTouchUi();
    const left = e.clientX < window.innerWidth * 0.5;
    if (left && !this.stick) this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    else if (!left && !this.touchLook) this.touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.updateTouchUi();
  }

  private touchMove(e: PointerEvent): void {
    if (this.stick && this.stick.id === e.pointerId) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
      this.updateTouchUi();
    } else if (this.touchLook && this.touchLook.id === e.pointerId) {
      this.lookDx += (e.clientX - this.touchLook.x) * 1.6;
      this.lookDy += (e.clientY - this.touchLook.y) * 1.6;
      this.touchLook.x = e.clientX;
      this.touchLook.y = e.clientY;
    }
  }

  private touchUp(e: PointerEvent): void {
    if (this.stick && this.stick.id === e.pointerId) this.stick = null;
    if (this.touchLook && this.touchLook.id === e.pointerId) this.touchLook = null;
    this.updateTouchUi();
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function radialDeadzone(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
  return [x * k, y * k];
}
