export const pad2 = (n) => String(n).padStart(2, '0');

/** 1:02:03 / 12:34 */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** 1時間02分 / 12分 / 45秒 */
export function fmtDurationJa(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (!h) return `${m}分`;
  return `${h}時間${pad2(m === 60 ? 59 : m)}分`;
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtHM(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）`;
}

export function fmtDist(m) {
  if (m >= 10000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

export function fmtPace(mps) {
  if (!(mps > 0.3)) return `--'--"`;
  let sec = Math.round(1000 / mps);
  if (sec >= 6000) return `--'--"`;
  const m = Math.floor(sec / 60);
  sec -= m * 60;
  return `${m}'${pad2(sec)}"`;
}

export function fmtInt(n) {
  return Math.round(n).toLocaleString('ja-JP');
}
