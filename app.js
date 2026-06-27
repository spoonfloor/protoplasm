/* ── MIME helpers (iOS Safari needs typed blobs for blob: URLs) ──────────── */

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

function mimeTypeFor(name, fallback = '') {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? fallback;
}

function blobWithMime(name, blob) {
  const type = mimeTypeFor(name, blob.type);
  if (!type || blob.type === type) return blob;
  return new Blob([blob], { type });
}

/* ── Storage ─────────────────────────────────────────────────────────────── */

const Storage = (() => {
  const DB_NAME = 'protoplasm';
  const DB_VERSION = 1;
  const STORE = 'bundle';
  const BUNDLE_KEY = 'current';

  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => {
          dbPromise = null;
          reject(req.error);
        };
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
      });
    }
    return dbPromise;
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function get(key) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const value = await idbRequest(tx.objectStore(STORE).get(key));
    return value ?? null;
  }

  async function set(key, value) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await idbRequest(tx.objectStore(STORE).put(value, key));
  }

  function describeBundle(bundleName, savedAt) {
    const date = new Date(savedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    return { label: `${bundleName} · ${date}` };
  }

  async function save(fileMap, bundleName) {
    const files = await Promise.all(
      [...fileMap.entries()].map(async ([name, blob]) => ({
        name,
        type: mimeTypeFor(name, blob.type),
        data: await blob.arrayBuffer(),
      }))
    );
    const savedAt = Date.now();
    await set(BUNDLE_KEY, { files, savedAt, bundleName });
    return describeBundle(bundleName, savedAt);
  }

  async function load() {
    const record = await get(BUNDLE_KEY);
    if (!record?.files?.length) return null;

    const fileMap = new Map(
      record.files.map((f) => [
        f.name,
        new Blob([f.data], { type: mimeTypeFor(f.name, f.type) }),
      ])
    );

    return {
      fileMap,
      meta: describeBundle(
        record.bundleName ?? 'Bundle',
        record.savedAt ?? Date.now()
      ),
    };
  }

  return { save, load };
})();

/* ── Bundle (import / parse) ───────────────────────────────────────────── */

const Bundle = (() => {
  function fileName(path) {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  function baseName(path) {
    return fileName(path).replace(/\.[^.]+$/, '');
  }

  function isImage(name) {
    return /\.(png|jpe?g|webp|gif)$/i.test(name);
  }

  function isSvg(name) {
    return /\.svg$/i.test(name);
  }

  function isIgnored(path) {
    const name = fileName(path);
    return (
      !name ||
      name.startsWith('.') ||
      path.includes('__MACOSX') ||
      name.endsWith('.DS_Store')
    );
  }

  function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  const INDEX_BASE = 'index';
  const EXT_PRIORITY = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
  const OVERLAY_ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
  const OVERLAY_KEY_RE = new RegExp(`^(.+)_(${OVERLAY_ANCHORS.join('|')})$`, 'i');
  const GLOBAL_OVERLAY_PREFIX = 'global';

  function parseOverlayKey(name) {
    const match = baseName(name).match(OVERLAY_KEY_RE);
    if (!match) return null;
    return { prefix: match[1].toLowerCase(), anchor: match[2].toLowerCase() };
  }

  function isOverlayImage(name) {
    return parseOverlayKey(name) !== null;
  }

  function isScreenImage(name) {
    return isImage(name) && !isOverlayImage(name);
  }

  function extRank(name) {
    const ext = fileName(name).split('.').pop()?.toLowerCase() ?? '';
    const rank = EXT_PRIORITY.indexOf(ext);
    return rank === -1 ? EXT_PRIORITY.length : rank;
  }

  function isIndexScreen(name) {
    return baseName(name).toLowerCase() === INDEX_BASE;
  }

  function compareIndexCandidates(a, b) {
    const rankDiff = extRank(a) - extRank(b);
    if (rankDiff !== 0) return rankDiff;
    return naturalSort(a, b);
  }

  function sortScreens(names) {
    const indexCandidates = names.filter(isIndexScreen);
    const rest = names.filter((n) => !isIndexScreen(n));

    if (indexCandidates.length === 0) {
      return [...names].sort(naturalSort);
    }

    const indexWinner = [...indexCandidates].sort(compareIndexCandidates)[0];
    const others = names.filter((n) => n !== indexWinner).sort(naturalSort);
    return [indexWinner, ...others];
  }

  function decodeSvgId(id) {
    return id.replace(/_x([0-9a-fA-F]+)_/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }

  function parseSvgDimensions(svg) {
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
        return { refW: parts[2], refH: parts[3] };
      }
    }

    const w = parseFloat(svg.getAttribute('width'));
    const h = parseFloat(svg.getAttribute('height'));
    if (!Number.isNaN(w) && !Number.isNaN(h)) {
      return { refW: w, refH: h };
    }

    return null;
  }

  function parseHotspotSvg(txt) {
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    const rects = [...doc.querySelectorAll('rect')].filter(
      (r) => r.id && r.id !== 'bounds'
    );
    const dims = svg ? parseSvgDimensions(svg) : null;

    return {
      rects: rects.map((r) => ({
        id: decodeSvgId(r.id),
        x: parseFloat(r.getAttribute('x')) || 0,
        y: parseFloat(r.getAttribute('y')) || 0,
        w: parseFloat(r.getAttribute('width')),
        h: parseFloat(r.getAttribute('height')),
      })),
      refW: dims?.refW ?? null,
      refH: dims?.refH ?? null,
    };
  }

  function buildFileMap(entries) {
    const map = new Map();

    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const name = fileName(entry.name);
      map.set(name, blobWithMime(name, entry.blob));
    }

    return map;
  }

  async function loadHotspotData(svgByBase, fileMap, key) {
    const svgName = svgByBase.get(key.toLowerCase());
    if (!svgName) return { rects: [], refW: null, refH: null };

    try {
      const txt = await fileMap.get(svgName).text();
      return parseHotspotSvg(txt);
    } catch {
      return { rects: [], refW: null, refH: null };
    }
  }

  async function buildOverlay(fileMap, svgByBase, name, blobUrls) {
    const key = parseOverlayKey(name);
    if (!key) return null;

    const blob = fileMap.get(name);
    if (!blob) return null;

    const url = URL.createObjectURL(blob);
    blobUrls.push(url);

    return {
      anchor: key.anchor,
      name,
      url,
      hotspotData: await loadHotspotData(svgByBase, fileMap, baseName(name)),
    };
  }

  async function resolveOverlays(screenBase, overlayImages, globalOverlays, fileMap, svgByBase, blobUrls) {
    const overlays = [];

    for (const anchor of OVERLAY_ANCHORS) {
      const screenOverlayName = overlayImages.get(`${screenBase}:${anchor}`);
      if (screenOverlayName) {
        const overlay = await buildOverlay(fileMap, svgByBase, screenOverlayName, blobUrls);
        if (overlay) overlays.push(overlay);
        continue;
      }

      const globalOverlay = globalOverlays.get(anchor);
      if (globalOverlay) overlays.push(globalOverlay);
    }

    return overlays;
  }

  async function fromFileMap(fileMap) {
    const overlayImages = new Map();
    const screenImages = [];

    for (const name of fileMap.keys()) {
      if (!isScreenImage(name)) {
        if (isOverlayImage(name)) {
          const key = parseOverlayKey(name);
          overlayImages.set(`${key.prefix}:${key.anchor}`, name);
        }
        continue;
      }
      screenImages.push(name);
    }

    const imageNames = sortScreens(screenImages);
    if (imageNames.length === 0) {
      throw new Error('No screen images found. Add PNG or JPG files.');
    }

    const svgByBase = new Map();
    for (const name of fileMap.keys()) {
      if (isSvg(name)) svgByBase.set(baseName(name).toLowerCase(), name);
    }

    const screens = [];
    const hotspotData = {};
    const blobUrls = [];
    const globalOverlays = new Map();

    for (const anchor of OVERLAY_ANCHORS) {
      const overlayName = overlayImages.get(`${GLOBAL_OVERLAY_PREFIX}:${anchor}`);
      if (!overlayName) continue;

      const overlay = await buildOverlay(fileMap, svgByBase, overlayName, blobUrls);
      if (overlay) globalOverlays.set(anchor, overlay);
    }

    for (const name of imageNames) {
      const blob = fileMap.get(name);
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);

      hotspotData[name] = await loadHotspotData(svgByBase, fileMap, baseName(name));

      const screenBase = baseName(name).toLowerCase();
      const overlays = await resolveOverlays(
        screenBase,
        overlayImages,
        globalOverlays,
        fileMap,
        svgByBase,
        blobUrls
      );

      screens.push({ name, url, overlays });
    }

    return { screens, hotspotData, blobUrls };
  }

  async function isZipFile(file) {
    if (/\.zip$/i.test(file.name)) return true;
    if (
      file.type === 'application/zip' ||
      file.type === 'application/x-zip-compressed'
    ) {
      return true;
    }
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b;
  }

  async function fromZip(file) {
    if (typeof JSZip === 'undefined') {
      throw new Error('Could not load assets.');
    }

    const zip = await JSZip.loadAsync(file);
    const entries = [];

    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || isIgnored(path)) continue;
      entries.push({ name: path, blob: await entry.async('blob') });
    }

    const fileMap = buildFileMap(entries);
    const bundle = await fromFileMap(fileMap);
    return { bundle, fileMap };
  }

  async function fromZipFile(file) {
    if (!(await isZipFile(file))) {
      throw new Error('Choose a ZIP file.');
    }
    return fromZip(file);
  }

  return { fromZipFile, fromFileMap, baseName };
})();

/* ── Viewer ──────────────────────────────────────────────────────────────── */

const Viewer = (() => {
  const viewer = document.getElementById('viewer');
  const img = document.getElementById('screen');
  const overlaysEl = document.getElementById('overlays');

  const TAP_MAX_MS = 350;
  const DOUBLE_TAP_WINDOW_MS = 450;

  let screens = [];
  let index = 0;
  let hotspotData = {};
  let blobUrls = [];
  let scrollPositions = new Map();
  let onExit = () => {};
  let ignoreClickUntil = 0;

  let twoFingerActive = false;
  let twoFingerStart = 0;
  let twoFingerTapCount = 0;
  let twoFingerLastTap = 0;

  function revokeBlobUrls() {
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls = [];
  }

  function clearOverlays() {
    overlaysEl.replaceChildren();
  }

  function renderOverlays(overlays) {
    clearOverlays();
    for (const overlay of overlays) {
      const el = document.createElement('img');
      el.className = 'viewer-overlay';
      el.dataset.anchor = overlay.anchor;
      el.src = overlay.url;
      el.alt = '';
      overlaysEl.appendChild(el);
    }
  }

  function resetTwoFingerGesture() {
    twoFingerActive = false;
    twoFingerStart = 0;
  }

  function registerTwoFingerTap(evt) {
    const now = Date.now();
    if (twoFingerLastTap && now - twoFingerLastTap > DOUBLE_TAP_WINDOW_MS) {
      twoFingerTapCount = 0;
    }

    twoFingerTapCount += 1;
    twoFingerLastTap = now;

    if (twoFingerTapCount >= 2) {
      twoFingerTapCount = 0;
      twoFingerLastTap = 0;
      ignoreClickUntil = now + 500;
      evt.preventDefault();
      onExit();
    }
  }

  function handleTouchStart(evt) {
    if (evt.touches.length === 2) {
      twoFingerActive = true;
      twoFingerStart = Date.now();
    } else {
      resetTwoFingerGesture();
    }
  }

  function handleTouchEnd(evt) {
    if (evt.touches.length > 0) return;

    if (!twoFingerActive) return;

    const duration = Date.now() - twoFingerStart;
    resetTwoFingerGesture();

    if (duration > TAP_MAX_MS) return;

    registerTwoFingerTap(evt);
  }

  function mount(bundle) {
    revokeBlobUrls();
    screens = bundle.screens;
    hotspotData = bundle.hotspotData;
    blobUrls = bundle.blobUrls;
    scrollPositions = new Map();
    show(0);
  }

  function preloadNext(i) {
    if (screens[i + 1]) {
      const n = new Image();
      n.src = screens[i + 1].url;
    }
  }

  function getFrame(element, data) {
    const box = element.getBoundingClientRect();
    return {
      refW: element.naturalWidth || data?.refW || 1,
      refH: element.naturalHeight || data?.refH || 1,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    };
  }

  function applyScroll(i) {
    window.scrollTo(0, scrollPositions.get(i) ?? 0);
  }

  function show(i) {
    scrollPositions.set(index, window.scrollY);
    index = i;
    const screen = screens[i];
    img.src = screen.url;
    renderOverlays(screen.overlays ?? []);
    preloadNext(i);

    if (img.complete && img.naturalWidth > 0) {
      applyScroll(i);
    } else {
      img.addEventListener('load', () => applyScroll(i), { once: true });
    }
  }

  function pointerCoords(evt) {
    if (evt.changedTouches?.[0]) {
      return {
        x: evt.changedTouches[0].clientX,
        y: evt.changedTouches[0].clientY,
      };
    }
    return { x: evt.clientX, y: evt.clientY };
  }

  function screenIndexForHotspotId(id) {
    const targetId = id.toLowerCase();
    return screens.findIndex(
      (scr) => Bundle.baseName(scr.name).toLowerCase() === targetId
    );
  }

  function hitTestHotspots(rects, frame, x, y) {
    for (const h of rects) {
      const left = frame.left + (h.x / frame.refW) * frame.width;
      const top = frame.top + (h.y / frame.refH) * frame.height;
      const w = (h.w / frame.refW) * frame.width;
      const hgt = (h.h / frame.refH) * frame.height;

      if (x >= left && x <= left + w && y >= top && y <= top + hgt) {
        return h.id;
      }
    }
    return null;
  }

  function handleTap(evt) {
    if (Date.now() < ignoreClickUntil) return;

    const screen = screens[index];
    if (!screen) return;

    const { x, y } = pointerCoords(evt);
    const overlayEls = [...overlaysEl.querySelectorAll('.viewer-overlay')];

    for (let i = overlayEls.length - 1; i >= 0; i -= 1) {
      const overlay = screen.overlays?.[i];
      if (!overlay) continue;

      const rects = overlay.hotspotData?.rects ?? [];
      if (rects.length === 0) continue;

      const frame = getFrame(overlayEls[i], overlay.hotspotData);
      const hitId = hitTestHotspots(rects, frame, x, y);
      if (hitId) {
        const targetIndex = screenIndexForHotspotId(hitId);
        if (targetIndex !== -1) show(targetIndex);
        return;
      }
    }

    const data = hotspotData[screen.name];
    const rects = data?.rects ?? [];
    if (rects.length > 0) {
      const frame = getFrame(img, data);
      const hitId = hitTestHotspots(rects, frame, x, y);
      if (hitId) {
        const targetIndex = screenIndexForHotspotId(hitId);
        if (targetIndex !== -1) show(targetIndex);
      }
      return;
    }

    if (index < screens.length - 1) show(index + 1);
  }

  viewer.addEventListener('click', handleTap);
  viewer.addEventListener('touchstart', handleTouchStart, { passive: true });
  viewer.addEventListener('touchend', handleTouchEnd, { passive: false });
  viewer.addEventListener('touchcancel', resetTwoFingerGesture, { passive: true });

  function setOnExit(fn) {
    onExit = fn;
  }

  return { mount, viewer, setOnExit };
})();

/* ── Landing UI (tall-mode bitmap scale) ─────────────────────────────────── */

const LandingUi = (() => {
  const landing = document.getElementById('landing');
  const ui = document.querySelector('.landing-ui');
  const tallQuery = window.matchMedia('(max-aspect-ratio: 530/980)');
  const refW = 390;

  function layout() {
    if (!ui || landing.hidden) return;

    if (!tallQuery.matches) {
      ui.style.transform = '';
      return;
    }

    ui.style.transform = 'none';
    const refH = ui.offsetHeight;
    if (!refH) return;

    const scale = Math.min(window.innerWidth / refW, window.innerHeight / refH);
    ui.style.transform = `scale(${scale})`;
  }

  tallQuery.addEventListener('change', layout);
  window.addEventListener('resize', layout);
  if (ui) new ResizeObserver(layout).observe(ui);

  return { layout };
})();

/* ── App (landing UI + lifecycle) ────────────────────────────────────────── */

const App = (() => {
  const landing = document.getElementById('landing');
  const landingMeta = document.getElementById('landing-meta');
  const landingError = document.getElementById('landing-error');
  const btnContinue = document.getElementById('btn-continue');
  const btnSelect = document.getElementById('btn-select');
  const fileInput = document.getElementById('file-input');

  let savedBundleMeta = null;

  function clearError() {
    landingError.hidden = true;
    landingError.textContent = '';
  }

  function showError(message) {
    landingError.textContent = message;
    landingError.hidden = false;
    requestAnimationFrame(() => LandingUi.layout());
  }

  function enterLanding() {
    landing.hidden = false;
    Viewer.viewer.hidden = true;

    if (savedBundleMeta) {
      landingMeta.textContent = savedBundleMeta.label;
      landingMeta.hidden = false;
      btnContinue.hidden = false;
    } else {
      landingMeta.hidden = true;
      btnContinue.hidden = true;
    }

    requestAnimationFrame(() => LandingUi.layout());
  }

  function enterViewer() {
    landing.hidden = true;
    Viewer.viewer.hidden = false;
  }

  function setLoading(loading) {
    btnContinue.disabled = loading;
    btnSelect.disabled = loading;
  }

  async function openBundle(fileMap, { persist }) {
    clearError();
    const bundle = await Bundle.fromFileMap(fileMap);
    Viewer.mount(bundle);
    enterViewer();

    if (persist) {
      Storage.save(fileMap)
        .then((meta) => {
          savedBundleMeta = meta;
        })
        .catch(() => {});
    }
  }

  btnSelect.addEventListener('click', () => {
    clearError();
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;

    setLoading(true);
    clearError();
    try {
      const { bundle, fileMap } = await Bundle.fromZipFile(file);
      Viewer.mount(bundle);
      enterViewer();

      Storage.save(fileMap, Bundle.baseName(file.name))
        .then((meta) => {
          savedBundleMeta = meta;
        })
        .catch(() => {});
    } catch (err) {
      showError(err.message || 'Could not load assets.');
      enterLanding();
    } finally {
      setLoading(false);
    }
  });

  btnContinue.addEventListener('click', async () => {
    setLoading(true);
    clearError();
    try {
      const saved = await Storage.load();
      if (!saved) {
        savedBundleMeta = null;
        enterLanding();
        return;
      }

      savedBundleMeta = saved.meta;
      await openBundle(saved.fileMap, { persist: false });
    } catch (err) {
      showError(err.message || 'Could not restore saved assets.');
      enterLanding();
    } finally {
      setLoading(false);
    }
  });

  document.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape' || !landing.hidden) return;
    enterLanding();
  });

  async function init() {
    Viewer.setOnExit(enterLanding);

    try {
      const saved = await Storage.load();
      if (saved) savedBundleMeta = saved.meta;
    } catch {
      savedBundleMeta = null;
    }
    enterLanding();
  }

  return { init };
})();

App.init();
