// GPX の点列を、再生と描画に使える形に整える。
//  - GPS の揺らぎ（止まっているのに少しずつ動く）を「アンカー」でまとめる
//  - 距離・速度・休憩・獲得標高を計算する
//  - 描画用に、距離で等間隔にサンプリングし直した滑らかな経路を作る

import { makeProjection } from './geo.js';

const WALK_SPEED = 1.25; // 時刻のない GPX を再生するときの仮の速さ（m/s）
const MIN_MOVE = 3; // これ未満の移動は揺らぎとみなす（m）
const HOLD_GAP = 8000; // これ以上その場にいたら、止まっていた区間として残す（ms）
const STOP_SPEED = 0.3; // m/s 未満は停止
const STOP_MIN = 60000; // これ以上止まっていたら「休憩」
const SPEED_WINDOW = 15000; // 速度を出すときの前後の時間幅（ms）
const STAY_RADIUS = 14; // この半径の中に STOP_MIN 以上いたら「とどまっていた」とみなす（m）

function fillGaps(arr) {
  const n = arr.length;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(arr[i])) continue;
    if (prev === -1) {
      for (let j = 0; j < i; j++) arr[j] = arr[i];
    } else if (i - prev > 1) {
      for (let j = prev + 1; j < i; j++) arr[j] = arr[prev] + ((arr[i] - arr[prev]) * (j - prev)) / (i - prev);
    }
    prev = i;
  }
  if (prev === -1) return false;
  for (let j = prev + 1; j < n; j++) arr[j] = arr[prev];
  return true;
}

function gaussian(src, sigma) {
  const n = src.length;
  const out = new Float64Array(n);
  if (!(sigma > 0.01)) {
    out.set(src);
    return out;
  }
  const r = Math.ceil(sigma * 3);
  const w = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    let s = 0;
    let ws = 0;
    const a = Math.max(0, i - r);
    const b = Math.min(n - 1, i + r);
    for (let j = a; j <= b; j++) {
      const wk = w[j - i + r];
      s += src[j] * wk;
      ws += wk;
    }
    out[i] = s / ws;
  }
  return out;
}

/** arr[i] <= v となる最大の i（arr は非減少） */
function floorIndex(arr, v, n = arr.length) {
  if (v <= arr[0]) return 0;
  if (v >= arr[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

function percentile(values, p) {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[idx];
}

function niceInterval(total) {
  const list = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  return list.find((v) => total / v <= 16) ?? 200000;
}

export function buildTrack(parsed) {
  const raw = parsed.points;
  const n = raw.length;

  // ---- 時刻・標高・心拍の欠けを埋める ----
  const times = raw.map((p) => p.time);
  const validT = times.filter(Number.isFinite).length;
  let hasTime = validT >= 2 && validT >= n * 0.8;
  if (hasTime) {
    fillGaps(times);
    for (let i = 1; i < n; i++) if (times[i] < times[i - 1]) times[i] = times[i - 1];
    if (times[n - 1] - times[0] < 2000) hasTime = false;
  }

  const eles = raw.map((p) => p.ele);
  const hasEle = eles.filter(Number.isFinite).length >= Math.max(2, n * 0.5);
  if (hasEle) fillGaps(eles);
  else eles.fill(0);

  const hrRaw = raw.map((p) => (p.hr > 20 && p.hr < 250 ? p.hr : NaN));
  const hasHR = hasTime && hrRaw.filter(Number.isFinite).length >= n * 0.3;
  if (hasHR) fillGaps(hrRaw);

  // ---- 投影 ----
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  for (const p of raw) {
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
  }
  const proj = makeProjection((latMin + latMax) / 2, (lonMin + lonMax) / 2);
  const rx = raw.map((p) => proj.toX(p.lon));
  const rz = raw.map((p) => proj.toZ(p.lat));

  // ---- とどまっていた区間：止まっていても GPS は数 m ずつ揺れるので、まとめて 1 点にする ----
  if (hasTime) {
    let i = 0;
    while (i < n - 1) {
      let j = i + 1;
      let sx = rx[i];
      let sz = rz[i];
      while (j < n && !raw[j].segStart && Math.hypot(rx[j] - sx / (j - i), rz[j] - sz / (j - i)) <= STAY_RADIUS) {
        sx += rx[j];
        sz += rz[j];
        j++;
      }
      if (times[j - 1] - times[i] >= STOP_MIN) {
        const cx = sx / (j - i);
        const cz = sz / (j - i);
        for (let k = i; k < j; k++) {
          rx[k] = cx;
          rz[k] = cz;
        }
        i = j;
      } else {
        i++;
      }
    }
  }

  // ---- アンカー：MIN_MOVE 以上動いたときだけ新しい点にする ----
  const ax = [];
  const az = [];
  const atm = [];
  const ae = [];
  const push = (x, z, t, e) => {
    ax.push(x);
    az.push(z);
    atm.push(t);
    ae.push(e);
  };
  push(rx[0], rz[0], times[0], eles[0]);
  let lastIdx = 0;
  for (let i = 1; i < n; i++) {
    const lx = ax[ax.length - 1];
    const lz = az[az.length - 1];
    const dist = Math.hypot(rx[i] - lx, rz[i] - lz);
    if (hasTime) {
      const dt = (times[i] - atm[atm.length - 1]) / 1000;
      if (dt > 0 && dist / dt > 120 && i !== n - 1) continue; // 明らかな飛び
    }
    if (dist >= MIN_MOVE || raw[i].segStart || i === n - 1) {
      // 長くその場にいた後に動き出したら、「ここまで止まっていた」点を残す
      if (hasTime && i - 1 > lastIdx && times[i - 1] - atm[atm.length - 1] > HOLD_GAP) {
        push(lx, lz, times[i - 1], eles[i - 1]);
      }
      push(rx[i], rz[i], times[i], eles[i]);
      lastIdx = i;
    }
  }
  const m = ax.length;

  // ---- 平滑化と累積距離 ----
  const sx = gaussian(ax, 1.3);
  const sz = gaussian(az, 1.3);
  const d = new Float64Array(m);
  for (let k = 1; k < m; k++) d[k] = d[k - 1] + Math.hypot(sx[k] - sx[k - 1], sz[k] - sz[k - 1]);
  const total = d[m - 1];

  const t = new Float64Array(m);
  if (hasTime) for (let k = 0; k < m; k++) t[k] = atm[k];
  else for (let k = 0; k < m; k++) t[k] = (d[k] / WALK_SPEED) * 1000;
  const t0 = t[0];
  const t1 = Math.max(t[m - 1], t0 + 1);

  // ---- アンカーごとの速度（前後 SPEED_WINDOW の平均） ----
  const speed = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    if (!hasTime) {
      speed[i] = WALK_SPEED;
      continue;
    }
    let j0 = i;
    let j1 = i;
    while (j0 > 0 && t[i] - t[j0 - 1] <= SPEED_WINDOW) j0--;
    while (j1 < m - 1 && t[j1 + 1] - t[i] <= SPEED_WINDOW) j1++;
    if (j0 === i && i > 0) j0 = i - 1;
    if (j1 === i && i < m - 1) j1 = i + 1;
    const dt = (t[j1] - t[j0]) / 1000;
    speed[i] = dt > 0 ? (d[j1] - d[j0]) / dt : 0;
  }

  // ---- 休憩と移動時間 ----
  const stops = [];
  let movingTime = 0;
  if (hasTime) {
    let runStart = -1;
    const closeRun = (endK) => {
      if (runStart < 0) return;
      const dur = t[endK] - t[runStart];
      if (dur >= STOP_MIN) stops.push({ tStart: t[runStart], tEnd: t[endK], dur, d: d[runStart] });
      runStart = -1;
    };
    for (let k = 0; k < m - 1; k++) {
      const dt = t[k + 1] - t[k];
      const v = dt > 0 ? (d[k + 1] - d[k]) / (dt / 1000) : Infinity;
      if (v < STOP_SPEED) {
        if (runStart < 0) runStart = k;
      } else {
        closeRun(k);
        movingTime += dt;
      }
    }
    closeRun(m - 1);
  } else {
    movingTime = t1 - t0;
  }

  // ---- 距離で等間隔にサンプリング ----
  const target = Math.max(1, total / 6000);
  const ns = Math.max(2, Math.ceil(total / target) + 1);
  const step = total > 0 ? total / (ns - 1) : 1;
  const S = {
    n: ns,
    step,
    x: new Float32Array(ns),
    z: new Float32Array(ns),
    ele: new Float32Array(ns),
    t: new Float64Array(ns),
    speed: new Float32Array(ns),
    grade: new Float32Array(ns),
    hr: new Float32Array(ns),
    timeFrac: new Float32Array(ns),
  };
  {
    const tx = new Float64Array(ns);
    const tz = new Float64Array(ns);
    const te = new Float64Array(ns);
    let k = 0;
    for (let i = 0; i < ns; i++) {
      const sd = total > 0 ? i * step : 0;
      while (k < m - 2 && d[k + 1] < sd) k++;
      const len = d[k + 1] - d[k];
      const f = len > 1e-9 ? Math.min(1, Math.max(0, (sd - d[k]) / len)) : 0;
      tx[i] = sx[k] + (sx[k + 1] - sx[k]) * f;
      tz[i] = sz[k] + (sz[k + 1] - sz[k]) * f;
      te[i] = ae[k] + (ae[k + 1] - ae[k]) * f;
      S.t[i] = t[k] + (t[k + 1] - t[k]) * f;
      S.speed[i] = speed[k] + (speed[k + 1] - speed[k]) * f;
    }
    const px = gaussian(tx, 2);
    const pz = gaussian(tz, 2);
    const pe = gaussian(te, Math.max(1, 12 / step));
    S.x.set(px);
    S.z.set(pz);
    S.ele.set(pe);
  }
  const gk = Math.max(1, Math.round(15 / step));
  for (let i = 0; i < ns; i++) {
    const a = Math.max(0, i - gk);
    const b = Math.min(ns - 1, i + gk);
    const run = (b - a) * step;
    S.grade[i] = run > 0.5 ? ((S.ele[b] - S.ele[a]) / run) * 100 : 0;
    S.timeFrac[i] = (S.t[i] - t0) / (t1 - t0);
  }

  const hrAt = (tm) => {
    if (!hasHR) return NaN;
    const i = floorIndex(times, tm);
    if (i >= n - 1) return hrRaw[n - 1];
    const dt = times[i + 1] - times[i];
    const f = dt > 0 ? Math.min(1, Math.max(0, (tm - times[i]) / dt)) : 0;
    return hrRaw[i] + (hrRaw[i + 1] - hrRaw[i]) * f;
  };
  if (hasHR) for (let i = 0; i < ns; i++) S.hr[i] = hrAt(S.t[i]);

  // ---- 範囲・統計 ----
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let eleMin = Infinity;
  let eleMax = -Infinity;
  for (let i = 0; i < ns; i++) {
    xMin = Math.min(xMin, S.x[i]);
    xMax = Math.max(xMax, S.x[i]);
    zMin = Math.min(zMin, S.z[i]);
    zMax = Math.max(zMax, S.z[i]);
    eleMin = Math.min(eleMin, S.ele[i]);
    eleMax = Math.max(eleMax, S.ele[i]);
  }
  const extent = Math.max(100, xMax - xMin, zMax - zMin);

  let gain = 0;
  let loss = 0;
  let ref = S.ele[0];
  for (let i = 1; i < ns; i++) {
    const diff = S.ele[i] - ref;
    if (diff >= 1) {
      gain += diff;
      ref = S.ele[i];
    } else if (diff <= -1) {
      loss -= diff;
      ref = S.ele[i];
    }
  }

  const movingSpeeds = Array.from(speed).filter((v) => v > STOP_SPEED);
  const duration = t1 - t0;
  const avgSpeed = movingTime > 0 ? total / (movingTime / 1000) : 0;
  const maxSpeed = hasTime ? percentile(movingSpeeds, 0.99) : WALK_SPEED;

  const stats = {
    distance: total,
    duration: hasTime ? duration : NaN,
    movingTime: hasTime ? movingTime : NaN,
    avgSpeed: hasTime ? avgSpeed : NaN,
    maxSpeed: hasTime ? maxSpeed : NaN,
    eleMin: hasEle ? eleMin : NaN,
    eleMax: hasEle ? eleMax : NaN,
    gain: hasEle ? gain : NaN,
    loss: hasEle ? loss : NaN,
    stops: stops.length,
    stopTime: stops.reduce((a, s) => a + s.dur, 0),
    hrAvg: hasHR ? S.hr.reduce((a, v) => a + v, 0) / ns : NaN,
    hrMax: hasHR ? Math.max(...S.hr) : NaN,
    steps: hasTime && avgSpeed > 0 && avgSpeed < 2.3 ? total / 0.72 : NaN,
    points: n,
  };

  const speedKmh = Array.from(S.speed, (v) => v * 3.6);
  const gAbs = Math.max(3, percentile(Array.from(S.grade, Math.abs), 0.95));
  const ranges = {
    speed: [Math.max(0, percentile(speedKmh, 0.03)), Math.max(1, percentile(speedKmh, 0.97))],
    ele: [eleMin, Math.max(eleMax, eleMin + 1)],
    time: [0, 1],
    grade: [-gAbs, gAbs],
    hr: hasHR ? [percentile(S.hr, 0.03), Math.max(percentile(S.hr, 0.97), percentile(S.hr, 0.03) + 5)] : [60, 180],
  };

  // ---- 目印 ----
  const interval = niceInterval(total);
  const marks = [];
  for (let v = interval; v < total - interval * 0.25; v += interval) {
    marks.push({ d: v, label: interval >= 1000 ? `${v / 1000} km` : `${v} m` });
  }

  const nearestSample = (x, z) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < ns; i++) {
      const dd = (S.x[i] - x) ** 2 + (S.z[i] - z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    return { index: best, dist: Math.sqrt(bd) };
  };
  const waypoints = parsed.waypoints.map((w) => {
    const x = proj.toX(w.lon);
    const z = proj.toZ(w.lat);
    const near = nearestSample(x, z);
    return { name: w.name, x, z, ele: Number.isFinite(w.ele) ? w.ele : S.ele[near.index], sample: near.index, offTrack: near.dist };
  });

  const startSample = 0;
  const endSample = ns - 1;
  const loop = Math.hypot(S.x[0] - S.x[ns - 1], S.z[0] - S.z[ns - 1]) < Math.max(40, total * 0.02);

  // ---- 再生で使う問い合わせ ----
  const stopAt = (tm) => {
    for (const s of stops) if (tm >= s.tStart && tm < s.tEnd) return s;
    return null;
  };

  /** 時刻 → 距離・速度など。out を使い回す。 */
  const at = (tm, out = {}) => {
    const k = Math.min(floorIndex(t, tm, m), m - 2);
    const dt = t[k + 1] - t[k];
    const f = dt > 0 ? Math.min(1, Math.max(0, (tm - t[k]) / dt)) : 1;
    out.t = tm;
    out.d = d[k] + (d[k + 1] - d[k]) * f;
    out.stop = hasTime ? stopAt(tm) : null;
    out.speed = out.stop ? 0 : speed[k] + (speed[k + 1] - speed[k]) * f;
    out.s = Math.min(ns - 1, Math.max(0, out.d / step));
    out.hr = hrAt(tm);
    return out;
  };

  const timeAtSample = (s) => {
    const i = Math.min(ns - 2, Math.max(0, Math.floor(s)));
    const f = Math.min(1, Math.max(0, s - i));
    return S.t[i] + (S.t[i + 1] - S.t[i]) * f;
  };

  const sampleValue = (arr, s) => {
    const i = Math.min(ns - 2, Math.max(0, Math.floor(s)));
    const f = Math.min(1, Math.max(0, s - i));
    return arr[i] + (arr[i + 1] - arr[i]) * f;
  };

  return {
    id: `${parsed.fileName}|${n}|${t0}|${raw[0].lat.toFixed(5)}|${raw[0].lon.toFixed(5)}`,
    name: parsed.name,
    fileName: parsed.fileName,
    hasTime,
    hasEle,
    hasHR,
    proj,
    bbox: { latMin, latMax, lonMin, lonMax, xMin, xMax, zMin, zMax },
    extent,
    center: { x: (xMin + xMax) / 2, z: (zMin + zMax) / 2 },
    t0,
    t1,
    total,
    samples: S,
    stops,
    marks,
    waypoints,
    startSample,
    endSample,
    loop,
    stats,
    ranges,
    at,
    stopAt,
    timeAtSample,
    sampleValue,
  };
}
