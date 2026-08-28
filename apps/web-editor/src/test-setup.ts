/**
 * Vitest setup: stub the HTMLMediaElement playback methods jsdom does not
 * implement (`play`, `pause`, `load`). The preview player drives a real
 * `<video>` element's transport; in jsdom those calls otherwise throw
 * "Not implemented" and flood the test output. The DOM playback paths are
 * `v8 ignore`d (verified manually / in e2e), so stubbing them to no-ops keeps
 * the unit suite focused on the deterministic store/selector logic.
 */
import { beforeAll, beforeEach } from 'vitest';

/**
 * `PointerEvent` polyfill — jsdom does not implement it.
 *
 * This matters more than it looks. When `window.PointerEvent` is missing,
 * `fireEvent.pointerDown(el, { clientX: 600, button: 0, pointerId: 1 })` falls
 * back to a plain `Event`, and **every one of those init properties arrives at
 * the handler as `undefined`** — so a pointer-gesture test can pass while
 * asserting nothing, or fail for a reason that has nothing to do with the
 * component. Two test files had each grown their own local
 * `PointerEvent = MouseEvent` alias to work around it ("mirrors Editor.test.tsx's
 * splitter tests"), which fixed `clientX` but left `pointerId` undefined — so
 * multi-pointer guards were satisfied only by `undefined !== undefined`.
 *
 * Subclassing `MouseEvent` (which jsdom *does* implement) gets the whole
 * coordinate/modifier surface for free and adds the pointer-specific fields on
 * top, so a gesture test can express what it means.
 */
class JsdomPointerEvent extends MouseEvent implements PointerEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
    this.width = init.width ?? 1;
    this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0;
    this.tangentialPressure = init.tangentialPressure ?? 0;
    this.tiltX = init.tiltX ?? 0;
    this.tiltY = init.tiltY ?? 0;
    this.twist = init.twist ?? 0;
    this.altitudeAngle = init.altitudeAngle ?? 0;
    this.azimuthAngle = init.azimuthAngle ?? 0;
  }

  getCoalescedEvents(): PointerEvent[] {
    return [];
  }

  getPredictedEvents(): PointerEvent[] {
    return [];
  }
}

beforeAll(() => {
  // Installed unconditionally rather than behind a `typeof` guard: if a future
  // jsdom ships its own PointerEvent, this one is still the shape the suite is
  // written against, and a silent switch between the two would be worse than a
  // deliberate override.
  (globalThis as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    JsdomPointerEvent as unknown as typeof PointerEvent;
  (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    JsdomPointerEvent as unknown as typeof PointerEvent;
  // Pointer capture is unimplemented in jsdom. No-ops rather than throwing, so a
  // component does not need a try/catch purely to survive the test environment.
  Element.prototype.setPointerCapture = function setPointerCapture(): void {};
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false;
  };

  // `Blob.arrayBuffer` is unimplemented in jsdom, but the chunked desktop import
  // reads each `file.slice(...)` through it — that is the whole point of the
  // streaming path (never materialise the whole File). Backed by FileReader,
  // which jsdom does implement.
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }

  // jsdom implements neither object-URL method. Import code creates a blob URL
  // for preview and revokes it once the host owns the bytes on disk; without
  // these a test cannot even spy on the revoke.
  const objectUrls = new Map<string, Blob>();
  let objectUrlSequence = 0;
  URL.createObjectURL = (object: Blob | MediaSource): string => {
    const url = `blob:framepilot/${(objectUrlSequence += 1)}`;
    if (object instanceof Blob) objectUrls.set(url, object);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    objectUrls.delete(url);
  };

  const proto = window.HTMLMediaElement.prototype;
  proto.play = (): Promise<void> => Promise.resolve();
  proto.pause = (): void => {};
  proto.load = (): void => {};

  // Default no-op `fetch`: `EngineStatusChip` (plan P5.3) probes the analysis-engine
  // sidecar on mount, and any test that renders `AiSidebar` mounts it too. Without
  // this, an un-stubbed test would fire a real `http://127.0.0.1:8765/health` request.
  // Assigned directly (not via `vi.stubGlobal`) so it survives every test file's own
  // `vi.unstubAllGlobals()` — a test that needs a different response stubs `fetch`
  // itself, which reverts back to this default afterward.
  globalThis.fetch = (async () => ({ ok: false }) as Response) as typeof fetch;
});

/**
 * A fresh `localStorage` for every test.
 *
 * jsdom gives the whole file one storage object, so a preference written by one test is
 * still there for the next — and the editor persists a growing number of them (rail tabs,
 * thumbnail size, rail widths, dock height, track lanes, edit mode). That coupling makes
 * suites order-dependent in the least obvious way: `Editor.test.tsx`'s Source-monitor tests
 * began failing not because the monitor changed but because an EARLIER test had switched
 * the left rail off Media, so the asset the later test clicks was no longer rendered.
 *
 * Cleared per test rather than per file, because the leak is between tests. A test that
 * wants a preference pre-set writes it in its own body, which is also where a reader will
 * look for it.
 */
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* storage unavailable in this environment — nothing to isolate */
  }
});
