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

function decodeSvgId(id) {
  return id.replace(/_x([0-9a-fA-F]+)_/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
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

document.body.addEventListener('click', handleTap);

(async function init() {
  await loadHotspots();
  show(0);
})();
