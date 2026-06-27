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
        type: blob.type,
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
      record.files.map((f) => [f.name, new Blob([f.data], { type: f.type })])
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
      map.set(fileName(entry.name), entry.blob);
    }

    return map;
  }

  async function fromFileMap(fileMap) {
    const imageNames = [...fileMap.keys()].filter(isImage).sort(naturalSort);
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

    for (const name of imageNames) {
      const blob = fileMap.get(name);
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);

      const svgName = svgByBase.get(baseName(name).toLowerCase());
      if (svgName) {
        try {
          const txt = await fileMap.get(svgName).text();
          hotspotData[name] = parseHotspotSvg(txt);
        } catch {
          hotspotData[name] = { rects: [], refW: null, refH: null };
        }
      } else {
        hotspotData[name] = { rects: [], refW: null, refH: null };
      }

      screens.push({ name, url });
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
  const img = document.getElementById('screen');

  const TAP_MAX_MS = 350;
  const DOUBLE_TAP_WINDOW_MS = 450;

  let screens = [];
  let index = 0;
  let hotspotData = {};
  let blobUrls = [];
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
    show(0);
  }

  function preloadNext(i) {
    if (screens[i + 1]) {
      const n = new Image();
      n.src = screens[i + 1].url;
    }
  }

  function getFrame(data) {
    const box = img.getBoundingClientRect();
    return {
      refW: img.naturalWidth || data?.refW || 1,
      refH: img.naturalHeight || data?.refH || 1,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    };
  }

  function show(i) {
    index = i;
    window.scrollTo(0, 0);
    img.src = screens[i].url;
    preloadNext(i);
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

  function handleTap(evt) {
    if (Date.now() < ignoreClickUntil) return;

    const screen = screens[index]?.name;
    if (!screen) return;

    const data = hotspotData[screen];
    const rects = data?.rects ?? [];
    const frame = getFrame(data);
    const { x, y } = pointerCoords(evt);

    if (rects.length > 0) {
      for (let h of rects) {
        const left = frame.left + (h.x / frame.refW) * frame.width;
        const top = frame.top + (h.y / frame.refH) * frame.height;
        const w = (h.w / frame.refW) * frame.width;
        const hgt = (h.h / frame.refH) * frame.height;

        if (x >= left && x <= left + w && y >= top && y <= top + hgt) {
          const targetIndex = screens.findIndex((scr) => scr.name.startsWith(h.id));
          if (targetIndex !== -1) show(targetIndex);
          return;
        }
      }
      return;
    }

    if (index < screens.length - 1) show(index + 1);
  }

  img.addEventListener('click', handleTap);
  img.addEventListener('touchstart', handleTouchStart, { passive: true });
  img.addEventListener('touchend', handleTouchEnd, { passive: false });
  img.addEventListener('touchcancel', resetTwoFingerGesture, { passive: true });

  function setOnExit(fn) {
    onExit = fn;
  }

  return { mount, img, setOnExit };
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
  }

  function enterLanding() {
    landing.hidden = false;
    Viewer.img.hidden = true;

    if (savedBundleMeta) {
      landingMeta.textContent = savedBundleMeta.label;
      landingMeta.hidden = false;
      btnContinue.hidden = false;
    } else {
      landingMeta.hidden = true;
      btnContinue.hidden = true;
    }
  }

  function enterViewer() {
    landing.hidden = true;
    Viewer.img.hidden = false;
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
