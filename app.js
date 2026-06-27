const DB_NAME = 'protoplasm';
const DB_VERSION = 1;
const STORE = 'bundle';
const BUNDLE_KEY = 'current';

const landing = document.getElementById('landing');
const landingMeta = document.getElementById('landing-meta');
const landingError = document.getElementById('landing-error');
const btnContinue = document.getElementById('btn-continue');
const btnSelect = document.getElementById('btn-select');
const fileInput = document.getElementById('file-input');
const img = document.getElementById('screen');

let screens = [];
let index = 0;
let hotspotData = {};
let blobUrls = [];
let savedBundleMeta = null;

function decodeSvgId(id) {
  return id.replace(/_x([0-9a-fA-F]+)_/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

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

function isIgnored(name) {
  return (
    !name ||
    name.startsWith('.') ||
    name.startsWith('__MACOSX') ||
    name.endsWith('.DS_Store')
  );
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ?? null);
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(value, key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}

function revokeBlobUrls() {
  for (const url of blobUrls) URL.revokeObjectURL(url);
  blobUrls = [];
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
    const name = fileName(entry.name);
    if (isIgnored(name)) continue;
    map.set(name, entry.blob);
  }

  return map;
}

async function bundleFromFileMap(fileMap) {
  const imageNames = [...fileMap.keys()].filter(isImage).sort(naturalSort);
  if (imageNames.length === 0) {
    throw new Error('No screen images found. Add PNG or JPG files.');
  }

  const svgByBase = new Map();
  for (const name of fileMap.keys()) {
    if (isSvg(name)) svgByBase.set(baseName(name).toLowerCase(), name);
  }

  const nextScreens = [];
  const nextHotspots = {};

  for (const name of imageNames) {
    const blob = fileMap.get(name);
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);

    const svgName = svgByBase.get(baseName(name).toLowerCase());
    if (svgName) {
      try {
        const txt = await fileMap.get(svgName).text();
        nextHotspots[name] = parseHotspotSvg(txt);
      } catch {
        nextHotspots[name] = { rects: [], refW: null, refH: null };
      }
    } else {
      nextHotspots[name] = { rects: [], refW: null, refH: null };
    }

    nextScreens.push({ name, url });
  }

  return { screens: nextScreens, hotspotData: nextHotspots };
}

async function persistBundle(fileMap) {
  const files = await Promise.all(
    [...fileMap.entries()].map(async ([name, blob]) => ({
      name,
      type: blob.type,
      data: await blob.arrayBuffer(),
    }))
  );

  const savedAt = Date.now();
  await idbSet(BUNDLE_KEY, { files, savedAt });
  savedBundleMeta = describeBundle(files, savedAt);
}

function describeBundle(files, savedAt) {
  const count = files.filter((f) => isImage(f.name)).length;
  const date = new Date(savedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return { count, label: `${count} screen${count === 1 ? '' : 's'} · ${date}` };
}

async function loadSavedBundleRecord() {
  const record = await idbGet(BUNDLE_KEY);
  if (!record?.files?.length) return null;

  const fileMap = new Map(
    record.files.map((f) => [f.name, new Blob([f.data], { type: f.type })])
  );

  return {
    fileMap,
    meta: describeBundle(record.files, record.savedAt ?? Date.now()),
  };
}

async function ingestFileMap(fileMap) {
  clearError();
  revokeBlobUrls();

  const bundle = await bundleFromFileMap(fileMap);
  screens = bundle.screens;
  hotspotData = bundle.hotspotData;

  await persistBundle(fileMap);
  enterViewer();
  show(0);
}

async function ingestZip(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = [];

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const name = fileName(path);
    if (isIgnored(name)) continue;
    entries.push({ name, blob: await entry.async('blob') });
  }

  return ingestFileMap(buildFileMap(entries));
}

async function ingestFileList(fileList) {
  const entries = await Promise.all(
    [...fileList].map(async (file) => ({
      name: file.name,
      blob: file,
    }))
  );

  return ingestFileMap(buildFileMap(entries));
}

async function ingestSelection(fileList) {
  if (fileList.length === 1 && /\.zip$/i.test(fileList[0].name)) {
    return ingestZip(fileList[0]);
  }
  return ingestFileList(fileList);
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
  if (landing.hidden === false) return;

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
  img.hidden = true;

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
  img.hidden = false;
}

function setLoading(loading) {
  btnContinue.disabled = loading;
  btnSelect.disabled = loading;
}

btnSelect.addEventListener('click', () => {
  clearError();
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const files = fileInput.files;
  fileInput.value = '';
  if (!files?.length) return;

  setLoading(true);
  try {
    await ingestSelection(files);
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
    const saved = await loadSavedBundleRecord();
    if (!saved) {
      savedBundleMeta = null;
      enterLanding();
      return;
    }

    savedBundleMeta = saved.meta;
    await ingestFileMap(saved.fileMap);
  } catch (err) {
    showError(err.message || 'Could not restore saved assets.');
    enterLanding();
  } finally {
    setLoading(false);
  }
});

document.body.addEventListener('click', handleTap);

(async function init() {
  try {
    const saved = await loadSavedBundleRecord();
    if (saved) savedBundleMeta = saved.meta;
  } catch {
    savedBundleMeta = null;
  }
  enterLanding();
})();
