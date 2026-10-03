// GPX を読む。名前空間の接頭辞（gpxtpx: / ns3: など）に依存しないよう localName で探す。

function childText(el, name) {
  for (const c of el.children) {
    if (c.localName === name) return c.textContent.trim();
  }
  return null;
}

function num(s) {
  if (s == null || s === '') return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function deepNum(el, name) {
  const found = el.getElementsByTagNameNS('*', name)[0];
  return found ? num(found.textContent.trim()) : NaN;
}

function parsePoint(el) {
  const time = childText(el, 'time');
  return {
    lat: num(el.getAttribute('lat')),
    lon: num(el.getAttribute('lon')),
    ele: num(childText(el, 'ele')),
    time: time ? Date.parse(time) : NaN,
    hr: deepNum(el, 'hr'),
    cad: deepNum(el, 'cad'),
  };
}

const valid = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

export function parseGPX(text, fileName = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('GPX（XML）として読み取れませんでした。');
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'gpx') {
    throw new Error('GPX ファイルではないようです。');
  }

  const segments = [];
  let trackName = null;
  for (const trk of root.getElementsByTagNameNS('*', 'trk')) {
    trackName ??= childText(trk, 'name');
    for (const seg of trk.getElementsByTagNameNS('*', 'trkseg')) {
      const pts = Array.from(seg.getElementsByTagNameNS('*', 'trkpt'), parsePoint).filter(valid);
      if (pts.length) segments.push(pts);
    }
  }
  // トラックが無ければルートを使う
  if (!segments.length) {
    for (const rte of root.getElementsByTagNameNS('*', 'rte')) {
      trackName ??= childText(rte, 'name');
      const pts = Array.from(rte.getElementsByTagNameNS('*', 'rtept'), parsePoint).filter(valid);
      if (pts.length) segments.push(pts);
    }
  }

  const waypoints = [];
  for (const w of root.children) {
    if (w.localName !== 'wpt') continue;
    const p = parsePoint(w);
    if (!valid(p)) continue;
    p.name = childText(w, 'name') || childText(w, 'desc') || '';
    waypoints.push(p);
  }

  let metaName = null;
  const meta = Array.from(root.children).find((c) => c.localName === 'metadata');
  if (meta) metaName = childText(meta, 'name');

  const points = [];
  segments.forEach((seg, si) => {
    seg.forEach((p, i) => {
      p.segStart = si > 0 && i === 0;
      points.push(p);
    });
  });

  if (points.length < 2) {
    throw new Error('トラックの点が 2 つ未満のため、表示できません。');
  }

  const base = fileName.replace(/\.[^.]+$/, '');
  return {
    name: trackName || metaName || base || 'GPX',
    fileName,
    points,
    waypoints,
    creator: root.getAttribute('creator') || '',
  };
}
