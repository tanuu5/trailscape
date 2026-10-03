import { parseGPX } from './gpx.js';
import { buildTrack } from './track.js';
import { makeDemoGPX } from './demo.js';
import { Viewer } from './scene/viewer.js';
import { fetchTerrain } from './scene/terrain.js';
import { Timeline } from './ui/timeline.js';
import { METRICS, cssGradient } from './palette.js';
import { fmtDuration, fmtDurationJa, fmtClock, fmtHM, fmtDate, fmtDist, fmtPace, fmtInt } from './format.js';

const $ = (id) => document.getElementById(id);

// ---- 端末内の保存（設定と前回のファイル）。使えない環境では黙って諦める ----
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`trailscape:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`trailscape:${key}`, JSON.stringify(value));
    } catch {
      /* 容量超過やプライベートモード */
    }
  },
};

const DEFAULTS = {
  metric: 'speed',
  width: 1,
  sky: 'auto',
  ghost: true,
  skip: true,
  labels: true,
  bloom: true,
  tiles: false,
  layer: 'seamlessphoto',
  heightMode: 'terrain',
  statsOpen: true,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

// ---- 部品 ----
const viewer = new Viewer($('viewport'), $('labels'));
const timeline = new Timeline($('chart'), {
  onSeek: (t) => seek(t),
  onHover: (t, x) => chartHover(t, x),
});

const RATES = [1, 5, 10, 30, 60, 120, 300, 600, 1200, 3000];
const player = { t: 0, playing: false, rate: 60 };
let track = null;
let metric = settings.metric;
let isDemo = false;
let introOpen = true;
const terrainCache = new Map();
let terrainAbort = null;

// ---- 小物 ----
let toastTimer = 0;
/** msg は文字列か行の配列。action = { label, run } でボタンを 1 つ付けられる */
function toast(msg, kind = '', action = null) {
  const el = $('toast');
  el.replaceChildren();
  const lines = Array.isArray(msg) ? msg : [msg];
  lines.forEach((line, i) => {
    const div = document.createElement('div');
    div.textContent = line;
    if (i > 0) div.className = 'toast-sub';
    el.appendChild(div);
  });
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.classList.remove('show');
      action.run();
    });
    el.appendChild(b);
  }
  el.className = `toast show ${kind}${action ? ' has-action' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 8000 : kind === 'error' ? 6000 : 3200);
}

/** 道を開いたときの案内。地図がオフなら、オンにできることを添える */
function announceTrack(first) {
  if (settings.tiles) {
    toast(first);
    return;
  }
  toast(
    [first, '地図と地形は、右上の設定ボタンからオンにできます（国土地理院のタイルを取得します。GPX は送りません）。'],
    '',
    { label: '地図をオンにする', run: enableTiles },
  );
}

function enableTiles() {
  settings.tiles = true;
  saveSettings();
  syncSettingsUI();
  loadTerrain();
}

function setPlaying(on) {
  if (!track) return;
  if (on && player.t >= track.t1 - 1) player.t = track.t0;
  player.playing = on;
  document.body.classList.toggle('playing', on);
  $('btn-play').setAttribute('aria-label', on ? '一時停止' : '再生');
}

function seek(t) {
  if (!track) return;
  player.t = Math.min(track.t1, Math.max(track.t0, t));
}

function autoRate(t) {
  const want = (t.t1 - t.t0) / 75000;
  return RATES.find((r) => r >= want * 0.8) ?? RATES[RATES.length - 1];
}

function setRate(r) {
  player.rate = r;
  $('rate').value = String(r);
}

// ---- 読み込み ----
function loadText(text, fileName, { demo = false, remember = true } = {}) {
  const parsed = parseGPX(text, fileName);
  const t = buildTrack(parsed);
  track = t;
  isDemo = demo;

  // 使えない色分けは外す
  const available = {
    speed: t.hasTime,
    ele: t.hasEle,
    time: true,
    grade: t.hasEle,
    hr: t.hasHR,
  };
  for (const opt of $('set-metric').options) opt.disabled = !available[opt.value];
  // 好みの色分けが使えない GPX では代わりを使う（好み自体は変えない）
  metric = available[settings.metric] ? settings.metric : ['speed', 'ele', 'time'].find((k) => available[k]);

  viewer.settings.metric = metric;
  viewer.setTrack(t);
  timeline.setMetric(metric);
  timeline.setTrack(t);
  player.t = t.t0;
  setRate(autoRate(t));
  showTrackInfo();
  showStats();
  showLegend();
  syncSettingsUI();
  if (settings.tiles) loadTerrain();

  if (remember && !demo && text.length < 4_000_000) store.set('last', { name: fileName, text });
  return t;
}

async function openFile(file) {
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) {
    toast('ファイルが大きすぎます（200 MB まで）。', 'error');
    return;
  }
  $('loading').hidden = false;
  try {
    const text = await file.text();
    await new Promise((r) => setTimeout(r, 30));
    loadText(text, file.name);
    closeIntro();
    viewer.setCameraMode('overview');
    setPlaying(true);
    announceTrack(`${file.name} を読み込みました（${fmtDist(track.total)}）`);
  } catch (e) {
    console.error(e);
    toast(e.message || '読み込めませんでした。', 'error');
  } finally {
    $('loading').hidden = true;
  }
}

function closeIntro() {
  if (!introOpen) return;
  introOpen = false;
  $('intro').classList.add('gone');
  viewer.controls.autoRotate = viewer.mode === 'drone';
}

// ---- 地形 ----
function setTileProgress(done, total) {
  const box = $('tile-progress');
  box.hidden = false;
  box.querySelector('.bar').style.width = `${(done / Math.max(1, total)) * 100}%`;
  box.querySelector('span').textContent = `地理院タイルを取得中… ${done} / ${total}`;
}

async function loadTerrain() {
  if (!track) return;
  terrainAbort?.abort();
  const ac = new AbortController();
  terrainAbort = ac;
  const key = `${track.id}|${settings.layer}`;
  let data = terrainCache.get(key);
  if (!data) {
    setTileProgress(0, 1);
    try {
      data = await fetchTerrain(track, settings.layer, { signal: ac.signal, onProgress: setTileProgress });
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error(e);
      toast(e.message || '地形を作れませんでした。', 'error');
      settings.tiles = false;
      saveSettings();
      syncSettingsUI();
      $('tile-progress').hidden = true;
      return;
    }
    terrainCache.set(key, data);
    while (terrainCache.size > 3) {
      const oldKey = terrainCache.keys().next().value;
      terrainCache.get(oldKey)?.bitmap?.close?.();
      terrainCache.delete(oldKey);
    }
  }
  $('tile-progress').hidden = true;
  if (ac.signal.aborted || !settings.tiles || !track || !key.startsWith(track.id)) return;
  viewer.setTerrain(data);
  syncExag();
  if (viewer.mode === 'overview') viewer.setCameraMode('overview');
  if (data.missing > data.heights.length * 0.3) toast('標高データがない場所は 0 m として描いています。');
}

function unloadTerrain() {
  terrainAbort?.abort();
  terrainAbort = null;
  $('tile-progress').hidden = true;
  viewer.setTerrain(null);
  syncExag();
  if (viewer.mode === 'overview') viewer.setCameraMode('overview');
}

// ---- 表示の更新 ----
function showTrackInfo() {
  $('track-name').textContent = track.name;
  let sub;
  if (track.hasTime) sub = `${fmtDate(track.t0)} ${fmtHM(track.t0)}–${fmtHM(track.t1)}`;
  else sub = `時刻の記録なし · ${fmtDist(track.total)}`;
  if (isDemo) sub += ' · デモ';
  $('track-date').textContent = sub;
  document.title = `${track.name} — Trailscape`;
  $('hud-hr-wrap').hidden = !track.hasHR;
}

function showStats() {
  const s = track.stats;
  const rows = [];
  const row = (k, v, unit = '') => rows.push(`<dt>${k}</dt><dd>${v}${unit ? `<small>${unit}</small>` : ''}</dd>`);
  const hr = () => rows.push('<div class="hr"></div>');
  row('距離', (s.distance / 1000).toFixed(2), 'km');
  if (track.hasTime) {
    row('かかった時間', fmtDuration(s.duration));
    row('動いていた時間', fmtDuration(s.movingTime));
    row('平均の速さ', (s.avgSpeed * 3.6).toFixed(1), 'km/h');
    row('平均ペース', fmtPace(s.avgSpeed), '/km');
    row('いちばん速いとき', (s.maxSpeed * 3.6).toFixed(1), 'km/h');
  }
  if (track.hasEle) {
    hr();
    row('のぼり', `+${Math.round(s.gain)}`, 'm');
    row('くだり', `−${Math.round(s.loss)}`, 'm');
    row('標高', `${Math.round(s.eleMin)}〜${Math.round(s.eleMax)}`, 'm');
  }
  if (track.hasTime) {
    hr();
    row('休憩（1分以上）', s.stops ? `${s.stops}回 · ${fmtDurationJa(s.stopTime)}` : 'なし');
    if (Number.isFinite(s.steps)) row('歩数の目安', fmtInt(s.steps), '歩');
  }
  if (track.hasHR) row('心拍（平均 / 最高）', `${Math.round(s.hrAvg)} / ${Math.round(s.hrMax)}`, 'bpm');
  hr();
  row('記録された点', fmtInt(s.points));
  $('stats-list').innerHTML = rows.join('');
  $('stats').classList.toggle('collapsed', !settings.statsOpen);
  $('stats-toggle').setAttribute('aria-expanded', String(settings.statsOpen));
}

function showLegend() {
  const m = METRICS[metric];
  const [lo, hi] = track.ranges[metric];
  $('legend-title').textContent = `${m.label}で色分け`;
  $('legend-bar').style.background = cssGradient(m.stops);
  let a;
  let b;
  switch (metric) {
    case 'time':
      a = track.hasTime ? fmtHM(track.t0) : 'スタート';
      b = track.hasTime ? fmtHM(track.t1) : 'ゴール';
      break;
    case 'grade':
      a = `${lo.toFixed(0)}%`;
      b = `+${hi.toFixed(0)}%`;
      break;
    default:
      a = lo.toFixed(m.digits);
      b = `${hi.toFixed(m.digits)} ${m.unit}`;
  }
  $('legend-min').textContent = a;
  $('legend-max').textContent = b;
}

function syncExag() {
  const v = viewer.settings.exag;
  $('set-exag').value = String(v);
  $('set-exag-out').textContent = `×${v}`;
}

function syncSettingsUI() {
  $('set-metric').value = metric;
  $('set-width').value = String(settings.width);
  $('set-width-out').textContent = `×${Number(settings.width).toFixed(1)}`;
  $('set-sky').value = settings.sky;
  $('set-ghost').checked = settings.ghost;
  $('set-skip').checked = settings.skip;
  $('set-labels').checked = settings.labels;
  $('set-bloom').checked = settings.bloom;
  $('set-tiles').checked = settings.tiles;
  $('set-layer').value = settings.layer;
  $('set-height').value = settings.heightMode;
  $('set-layer').closest('.row').classList.toggle('disabled', !settings.tiles);
  $('set-height').closest('.row').classList.toggle('disabled', !settings.tiles);
  $('attrib').hidden = !settings.tiles;
  const badge = $('privacy-badge');
  badge.classList.toggle('net', settings.tiles);
  badge.querySelector('span').textContent = settings.tiles ? '地図タイルだけ取得中（GPX は送信しません）' : '端末内で処理・外部送信なし';
  syncExag();
}

let hudAcc = 1;
const hudState = {};
function updateHUD(dt) {
  hudAcc += dt;
  if (hudAcc < 1 / 15 || !track) return;
  hudAcc = 0;
  const st = track.at(player.t, hudState);
  const S = track.samples;
  $('hud-clock').textContent = track.hasTime ? fmtClock(st.t) : '--:--:--';
  $('hud-elapsed').textContent = `経過 ${fmtDuration(st.t - track.t0)}${st.stop ? ' · 休憩中' : ''}`;
  $('hud-dist').textContent = (st.d / 1000).toFixed(2);
  $('hud-speed').textContent = track.hasTime ? (st.speed * 3.6).toFixed(1) : '--';
  $('hud-pace').textContent = track.hasTime ? fmtPace(st.speed) : `--'--"`;
  $('hud-ele').textContent = track.hasEle ? String(Math.round(track.sampleValue(S.ele, st.s))) : '--';
  if (track.hasHR) $('hud-hr').textContent = String(Math.round(st.hr));
  $('tl-cur').textContent = fmtDuration(st.t - track.t0);
  $('tl-total').textContent = `/ ${fmtDuration(track.t1 - track.t0)}`;
}

function infoHTML(s) {
  const S = track.samples;
  const t = track.timeAtSample(s);
  const st = track.at(t);
  const parts = [];
  if (track.hasTime) parts.push(`<b>${fmtClock(t)}</b>`);
  parts.push(`<span class="muted">${fmtDist(s * S.step)}</span>`);
  const second = [];
  if (track.hasTime) second.push(st.stop ? '休憩中' : `${(st.speed * 3.6).toFixed(1)} km/h`);
  if (track.hasEle) second.push(`標高 ${Math.round(track.sampleValue(S.ele, s))} m`);
  if (track.hasEle) second.push(`勾配 ${track.sampleValue(S.grade, s).toFixed(1)}%`);
  if (track.hasHR) second.push(`${Math.round(st.hr)} bpm`);
  return `${parts.join(' ')}<br>${second.join(' · ')}`;
}

function chartHover(t, x) {
  const tip = $('chart-tip');
  if (t == null || !track) {
    tip.hidden = true;
    viewer.setHover(-1);
    return;
  }
  const s = track.at(t).s;
  tip.innerHTML = infoHTML(s);
  tip.hidden = false;
  const w = $('chart-wrap').clientWidth;
  tip.style.left = `${Math.min(w - tip.offsetWidth / 2 - 4, Math.max(tip.offsetWidth / 2 + 4, x))}px`;
  viewer.setHover(s);
}

// ---- 3D 上のホバーとクリック ----
{
  const canvas = viewer.renderer.domElement;
  const tip = $('pick-tip');
  let pending = null;
  let down = null;
  let hovered = -1;
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons || e.pointerType === 'touch') {
      tip.hidden = true;
      return;
    }
    pending = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerleave', () => {
    pending = null;
    hovered = -1;
    tip.hidden = true;
    viewer.setHover(-1);
  });
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, at: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || !track) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.at < 400;
    down = null;
    if (moved > 5 || !quick) return;
    const s = viewer.pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 28 : 16);
    if (s >= 0) seek(track.timeAtSample(s));
  });
  window.pickTick = () => {
    if (!pending || !track) return;
    const { x, y } = pending;
    pending = null;
    const s = viewer.pick(x, y);
    hovered = s;
    if (s < 0) {
      tip.hidden = true;
      viewer.setHover(-1);
      canvas.style.cursor = '';
      return;
    }
    tip.innerHTML = infoHTML(s);
    tip.hidden = false;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    viewer.setHover(s);
    canvas.style.cursor = 'pointer';
  };
  void hovered;
}

// ---- 操作 ----
$('btn-play').addEventListener('click', () => setPlaying(!player.playing));
$('btn-restart').addEventListener('click', () => {
  seek(track?.t0 ?? 0);
});
for (const r of RATES) {
  const o = document.createElement('option');
  o.value = String(r);
  o.textContent = `×${r}`;
  $('rate').appendChild(o);
}
$('rate').addEventListener('change', (e) => (player.rate = Number(e.target.value)));

function setCam(mode) {
  closeSettings();
  viewer.setCameraMode(mode);
  for (const b of $('cam-seg').querySelectorAll('button')) {
    const on = b.dataset.cam === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}
for (const b of $('cam-seg').querySelectorAll('button')) {
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => setCam(b.dataset.cam));
}

const fileInput = $('file-input');
fileInput.addEventListener('change', () => {
  openFile(fileInput.files[0]);
  fileInput.value = '';
});
$('btn-open').addEventListener('click', () => fileInput.click());
$('intro-open').addEventListener('click', () => fileInput.click());
$('intro-demo').addEventListener('click', () => {
  closeIntro();
  setCam('overview');
  seek(track.t0);
  setPlaying(true);
  announceTrack(`デモ：${track.name.replace(/^デモ：/, '')}（${fmtDist(track.total)}）`);
});
{
  const last = store.get('last', null);
  if (last?.text) {
    const b = $('intro-last');
    b.hidden = false;
    b.textContent = `前回のファイル：${last.name}`;
    b.addEventListener('click', () => {
      try {
        loadText(last.text, last.name, { remember: false });
        closeIntro();
        setCam('overview');
        setPlaying(true);
        announceTrack(`${last.name} を開きました（${fmtDist(track.total)}）`);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}

// 設定パネル
function closeSettings() {
  $('settings').hidden = true;
  $('btn-settings').setAttribute('aria-expanded', 'false');
}
$('btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('btn-settings').setAttribute('aria-expanded', String(open));
});
document.addEventListener('pointerdown', (e) => {
  if ($('settings').hidden) return;
  if ($('settings').contains(e.target) || $('btn-settings').contains(e.target)) return;
  closeSettings();
});

$('set-metric').addEventListener('change', (e) => {
  settings.metric = metric = e.target.value;
  saveSettings();
  viewer.apply({ metric });
  timeline.setMetric(metric);
  showLegend();
});
$('set-exag').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('set-exag-out').textContent = `×${v}`;
  viewer.apply({ exag: v });
});
$('set-width').addEventListener('input', (e) => {
  settings.width = Number(e.target.value);
  $('set-width-out').textContent = `×${settings.width.toFixed(1)}`;
  viewer.apply({ width: settings.width });
  saveSettings();
});
$('set-sky').addEventListener('change', (e) => {
  settings.sky = e.target.value;
  viewer.apply({ sky: settings.sky });
  saveSettings();
});
const bindCheck = (id, key, after) => {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings();
    after?.(settings[key]);
  });
};
bindCheck('set-ghost', 'ghost', (v) => viewer.apply({ ghost: v }));
bindCheck('set-skip', 'skip');
bindCheck('set-labels', 'labels', (v) => viewer.apply({ labels: v }));
bindCheck('set-bloom', 'bloom', (v) => viewer.apply({ bloom: v }));
bindCheck('set-tiles', 'tiles', (v) => {
  syncSettingsUI();
  if (v) loadTerrain();
  else unloadTerrain();
});
$('set-layer').addEventListener('change', (e) => {
  settings.layer = e.target.value;
  saveSettings();
  if (settings.tiles) loadTerrain();
});
$('set-height').addEventListener('change', (e) => {
  settings.heightMode = e.target.value;
  saveSettings();
  viewer.apply({ heightMode: settings.heightMode });
});

$('stats-toggle').addEventListener('click', () => {
  settings.statsOpen = !settings.statsOpen;
  saveSettings();
  $('stats').classList.toggle('collapsed', !settings.statsOpen);
  $('stats-toggle').setAttribute('aria-expanded', String(settings.statsOpen));
});

function toggleUI() {
  const hidden = document.body.classList.toggle('ui-hidden');
  if (hidden) toast('H キーで UI を戻せます');
}
$('btn-hide').addEventListener('click', toggleUI);

async function screenshot() {
  const blob = await viewer.screenshot(0, player.t);
  if (!blob) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `trailscape-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('画像を保存しました');
}
$('btn-shot').addEventListener('click', screenshot);

// キーボード
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (introOpen && e.key !== 'Escape') return;
  const span = track ? track.t1 - track.t0 : 0;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      setPlaying(!player.playing);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seek(player.t + span * (e.shiftKey ? 0.05 : 0.01));
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seek(player.t - span * (e.shiftKey ? 0.05 : 0.01));
      break;
    case '[':
    case ']': {
      const i = RATES.indexOf(player.rate);
      const j = Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 4 : i) + (e.key === ']' ? 1 : -1)));
      setRate(RATES[j]);
      toast(`再生速度 ×${RATES[j]}`);
      break;
    }
    case '1':
    case '2':
    case '3':
    case '4':
      setCam(['overview', 'follow', 'first', 'drone'][Number(e.key) - 1]);
      break;
    case 'h':
    case 'H':
      toggleUI();
      break;
    case 'p':
    case 'P':
      screenshot();
      break;
    case 'o':
    case 'O':
      fileInput.click();
      break;
    case 'l':
    case 'L':
      settings.labels = !settings.labels;
      saveSettings();
      syncSettingsUI();
      viewer.apply({ labels: settings.labels });
      break;
    case 'Home':
      seek(track?.t0 ?? 0);
      break;
    case 'Escape':
      closeSettings();
      break;
  }
});

// ドラッグ & ドロップ
{
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
    $('dropzone').classList.add('over');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) {
      document.body.classList.remove('dragging');
      $('dropzone').classList.remove('over');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    $('dropzone').classList.remove('over');
    const files = Array.from(e.dataTransfer?.files ?? []);
    const gpx = files.find((f) => /\.gpx$/i.test(f.name)) ?? files[0];
    if (files.length > 1) toast('複数のファイルがドロップされたので、最初の GPX だけを開きます。');
    openFile(gpx);
  });
}

// ---- ループ ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (track && player.playing) {
    let rate = player.rate;
    const stop = settings.skip ? track.stopAt(player.t) : null;
    if (stop) rate = Math.max(rate, stop.dur / 1500);
    player.t += dt * 1000 * rate;
    if (player.t >= track.t1) {
      if (introOpen) player.t = track.t0;
      else {
        player.t = track.t1;
        setPlaying(false);
      }
    }
  }
  viewer.render(dt, player.t, player.playing);
  timeline.draw(player.t);
  updateHUD(dt);
  window.pickTick?.();
  requestAnimationFrame(frame);
}

// ---- 起動：裏でデモを流しておく ----
syncSettingsUI();
viewer.apply({
  width: settings.width,
  sky: settings.sky,
  ghost: settings.ghost,
  labels: settings.labels,
  bloom: settings.bloom,
  heightMode: settings.heightMode,
});
try {
  loadText(makeDemoGPX(), 'demo.gpx', { demo: true, remember: false });
  viewer.setCameraMode('overview', true);
  viewer.controls.autoRotate = true;
  player.t = track.t0 + (track.t1 - track.t0) * 0.35;
  setPlaying(true);
  setRate(Math.max(60, player.rate));
} catch (e) {
  console.error(e);
}
requestAnimationFrame(frame);

// 開発中だけ、コンソールから中身を見られるようにする
if (import.meta.env.DEV) {
  window.trailscape = { viewer, player, settings, loadText, get track() { return track; } };
}
