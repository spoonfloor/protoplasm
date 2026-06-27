const screens = [
  '01_list.PNG',
  '02_hawk.PNG',
  '03_towhee.PNG',
  '04_junco.PNG',
  '05_sparrow.PNG',
  '06_finch.PNG',
];

const img = document.getElementById('screen');
let index = 0;
let hotspotData = {};

function viewportWidth() {
  return window.visualViewport?.width ?? window.innerWidth;
}

function fullDeviceHeight() {
  const vw = viewportWidth();
  return Math.round(window.screen.height * (vw / window.screen.width));
}

function decodeSvgId(id) {
  return id.replace(/_x([0-9a-fA-F]+)_/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function isPortraitViewport() {
  return window.innerHeight > window.innerWidth;
}

function applyLayout() {
  const portrait = isPortraitViewport();
  document.documentElement.classList.toggle('portrait-fit', portrait);

  if (portrait) {
    const fullH = fullDeviceHeight();
    document.documentElement.style.height = fullH + 'px';
    document.body.style.height = fullH + 'px';
  } else {
    document.documentElement.style.height = '';
    document.body.style.height = '';
  }
}

function preloadNext(i) {
  if (screens[i + 1]) {
    const n = new Image();
    n.src = 'screens/' + screens[i + 1];
  }
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

async function loadHotspots() {
  for (let s of screens) {
    const base = s.replace(/\.(png|jpg|jpeg)$/i, '');
    const svgPath = 'hotspots/' + base + '.svg';

    try {
      const txt = await fetch(svgPath).then((r) => r.text());
      const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      const rects = [...doc.querySelectorAll('rect')].filter(
        (r) => r.id && r.id !== 'bounds'
      );
      const dims = svg ? parseSvgDimensions(svg) : null;

      hotspotData[s] = {
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
    } catch {
      hotspotData[s] = { rects: [], refW: null, refH: null };
    }
  }
}

function getFrame(data) {
  const refW = img.naturalWidth || data?.refW || viewportWidth();
  const refH = img.naturalHeight || data?.refH || fullDeviceHeight();
  const vw = viewportWidth();
  const vh = window.innerHeight;

  if (isPortraitViewport()) {
    const scale = vw / refW;
    return {
      refW,
      refH,
      left: 0,
      top: 0,
      width: vw,
      height: refH * scale,
      scale,
    };
  }

  const scale = vh / refH;
  const width = refW * scale;
  return {
    refW,
    refH,
    left: (vw - width) / 2,
    top: 0,
    width,
    height: vh,
    scale,
  };
}

function show(i) {
  index = i;
  window.scrollTo(0, 0);
  img.src = 'screens/' + screens[i];
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
  const screen = screens[index];
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
        const targetIndex = screens.findIndex((scr) => scr.startsWith(h.id));
        if (targetIndex !== -1) show(targetIndex);
        return;
      }
    }
  }

  if (index < screens.length - 1) show(index + 1);
}

window.addEventListener('resize', applyLayout);
window.visualViewport?.addEventListener('resize', applyLayout);
img.addEventListener('load', applyLayout);
document.body.addEventListener('click', handleTap);

(async function init() {
  applyLayout();
  await loadHotspots();
  show(0);
})();
