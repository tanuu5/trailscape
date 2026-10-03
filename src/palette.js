import * as THREE from 'three';

export const METRICS = {
  speed: { label: '速度', unit: 'km/h', digits: 1, stops: ['#3d45ff', '#1fb2ff', '#2af5b0', '#f2f45c', '#ff9a3d', '#ff3d6e'] },
  ele: { label: '標高', unit: 'm', digits: 0, stops: ['#2a6fdb', '#22b8b0', '#7fdc6a', '#ffd25e', '#ff7a45'] },
  time: { label: '時間', unit: '', digits: 0, stops: ['#6a5cff', '#c45cff', '#ff5ca8', '#ffb35c'] },
  grade: { label: '勾配', unit: '%', digits: 1, stops: ['#2f8bff', '#86ccff', '#e9eef8', '#ffa06b', '#ff3d4d'] },
  hr: { label: '心拍', unit: 'bpm', digits: 0, stops: ['#38d3ff', '#6dff9a', '#ffe14d', '#ff7a3d', '#ff2d55'] },
};

/** 0..1 → 色（リニア）。キャンバス用には getStyle() で sRGB 文字列にする。 */
export function makeRamp(stops) {
  const cols = stops.map((s) => new THREE.Color(s));
  const last = cols.length - 1;
  return (t, out = new THREE.Color()) => {
    const v = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
    const f = v * last;
    const i = Math.min(Math.floor(f), last - 1);
    return out.copy(cols[i]).lerp(cols[i + 1], f - i);
  };
}

export function cssGradient(stops) {
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
