// デモ用の GPX を合成する。皇居のまわりを夕方に一周する、という想定の架空のログ。
// 実在の誰かの記録ではなく、座標・時刻・心拍はすべてここで作っている。

const ROUTE = [
  // [lat, lon, 標高 m]
  [35.6772, 139.7527, 4], // 桜田門
  [35.6784, 139.7556, 3], // 祝田橋
  [35.6794, 139.7578, 3],
  [35.6812, 139.7598, 3], // 二重橋前
  [35.6840, 139.7610, 3], // 和田倉門
  [35.6862, 139.7612, 4],
  [35.6872, 139.7605, 5], // 大手門
  [35.6898, 139.7578, 6], // 平川門
  [35.6910, 139.7566, 8], // 竹橋
  [35.6915, 139.7548, 13],
  [35.6909, 139.7527, 20],
  [35.6904, 139.7500, 26],
  [35.6896, 139.7472, 30], // 千鳥ヶ淵
  [35.6870, 139.7452, 33],
  [35.6839, 139.7443, 34], // 半蔵門
  [35.6806, 139.7448, 28], // 三宅坂
  [35.6786, 139.7477, 16],
  [35.6777, 139.7503, 8],
  [35.6772, 139.7527, 4],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return p1.map((_, k) =>
    0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3),
  );
}

export function makeDemoGPX() {
  const rand = mulberry32(20261003);
  const gauss = () => {
    const u = Math.max(1e-9, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  // 経路を細かくする（メートル座標で）
  const lat0 = 35.684;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const P = ROUTE.map(([la, lo, e]) => [(lo - 139.75) * kx, (la - lat0) * ky, e]);
  const dense = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    for (let s = 0; s < 20; s++) dense.push(catmull(p0, P[i], P[i + 1], p3, s / 20));
  }
  dense.push(P[P.length - 1]);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const total = cum[cum.length - 1];
  const pointAt = (dist) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dist) i++;
    const f = Math.min(1, Math.max(0, (dist - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
    return dense[i - 1].map((v, k) => v + (dense[i][k] - v) * f);
  };

  // 休憩：竹橋で信号待ち、千鳥ヶ淵でひと休み
  const stops = [
    { at: total * 0.47, dur: 75 },
    { at: total * 0.66, dur: 290 },
  ];

  const start = Date.parse('2026-10-03T16:46:00+09:00');
  const pts = [];
  let dist = 0;
  let tm = start;
  let nx = 0;
  let ny = 0;
  let hr = 88;
  let pace = 1.35;
  let stopIdx = 0;
  let resting = 0;
  let prevEle = P[0][2];
  while (dist < total) {
    const [x, y, e] = pointAt(dist);
    nx = nx * 0.85 + gauss() * 0.9;
    ny = ny * 0.85 + gauss() * 0.9;
    const grade = (e - prevEle) / Math.max(0.5, pace * 2);
    prevEle = e;
    const targetHr = resting > 0 ? 84 : 96 + pace * 12 + Math.max(-6, Math.min(22, grade * 260));
    hr += (targetHr - hr) * 0.08 + gauss() * 0.8;
    pts.push({
      lat: lat0 + (y + ny) / ky,
      lon: 139.75 + (x + nx) / kx,
      ele: e + gauss() * 0.6,
      time: tm,
      hr: Math.round(hr),
    });
    tm += 2000;
    if (resting > 0) {
      resting -= 2;
      continue;
    }
    if (stopIdx < stops.length && dist >= stops[stopIdx].at) {
      resting = stops[stopIdx].dur;
      stopIdx++;
      continue;
    }
    pace += (1.32 + 0.12 * Math.sin(dist / 420) - pace) * 0.05 + gauss() * 0.02;
    pace = Math.min(1.7, Math.max(0.95, pace - Math.max(0, grade) * 2.5));
    dist += pace * 2;
  }

  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = pts
    .map(
      (p) =>
        `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele.toFixed(1)}</ele><time>${iso(p.time)}</time>` +
        `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trailscape demo" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<wpt lat="35.6898" lon="139.7474"><name>千鳥ヶ淵</name></wpt>
<wpt lat="35.6839" lon="139.7443"><name>半蔵門</name></wpt>
<trk><name>デモ：夕方の皇居ひとまわり</name><trkseg>
${body}
</trkseg></trk>
</gpx>`;
}
