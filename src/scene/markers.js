// スタート・ゴール・距離の目印・休憩・ウェイポイント。文字は CSS2D のラベルで出す。
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { makeBeam, makeRing } from './effects.js';
import { fmtHM, fmtDurationJa } from '../format.js';

function label(cls, html) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.innerHTML = `<div class="lbl-pill">${html}</div>`;
  const o = new CSS2DObject(el);
  o.center.set(0.5, 1);
  return o;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const gemGeometry = new THREE.OctahedronGeometry(1, 0);
const pinGeometry = new THREE.CylinderGeometry(0.06, 0.06, 1, 8).translate(0, 0.5, 0);

export class Markers {
  constructor() {
    this.group = new THREE.Group();
    this.items = [];
    this.gemMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#bfefff', emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.1, flatShading: true });
    this.stopMaterial = new THREE.MeshStandardMaterial({ color: '#ffc35c', emissive: '#ffb340', emissiveIntensity: 0.9, roughness: 0.4, flatShading: true });
    this.wptMaterial = new THREE.MeshStandardMaterial({ color: '#5ee7ff', emissive: '#5ee7ff', emissiveIntensity: 0.8, roughness: 0.4, flatShading: true });
    this.pinMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45 });
  }

  clear() {
    for (const it of this.items) {
      it.obj.traverse((o) => {
        if (o.isCSS2DObject) o.element.remove();
      });
      this.group.remove(it.obj);
    }
    this.items = [];
  }

  /** heightAt(sampleIndex) → y、heightAtXZ(x, z, ele) → y（ウェイポイント用） */
  build(track, heightAt, heightAtXZ) {
    this.clear();
    const S = track.samples;
    const add = (obj, kind, opts = {}) => {
      this.items.push({ obj, kind, ...opts });
      this.group.add(obj);
    };

    // スタートとゴール
    const beacon = (i, color, cls, title) => {
      const g = new THREE.Group();
      g.position.set(S.x[i], heightAt(i), S.z[i]);
      const beam = makeBeam(color, 0.75);
      const ring = makeRing(color, 0.85);
      g.add(beam, ring);
      const time = track.hasTime ? `<span>${fmtHM(S.t[i])}</span>` : '';
      const l = label(cls, `<b>${title}</b>${time}`);
      g.add(l);
      add(g, 'beacon', { beam, ring, label: l });
    };
    if (track.loop) {
      beacon(0, '#4dffa6', 'lbl-start', 'START / GOAL');
    } else {
      beacon(0, '#4dffa6', 'lbl-start', 'START');
      beacon(S.n - 1, '#ff5ca8', 'lbl-goal', 'GOAL');
    }

    // 距離の目印
    for (const mk of track.marks) {
      const i = Math.min(S.n - 1, Math.round(mk.d / S.step));
      const g = new THREE.Group();
      g.position.set(S.x[i], heightAt(i), S.z[i]);
      const gem = new THREE.Mesh(gemGeometry, this.gemMaterial);
      const pin = new THREE.Mesh(pinGeometry, this.pinMaterial);
      g.add(pin, gem);
      const l = label('lbl-km', esc(mk.label));
      g.add(l);
      add(g, 'km', { gem, pin, label: l });
    }

    // 休憩
    for (const st of track.stops) {
      if (st.dur < 120000) continue;
      const i = Math.min(S.n - 1, Math.round(st.d / S.step));
      const g = new THREE.Group();
      g.position.set(S.x[i], heightAt(i), S.z[i]);
      const gem = new THREE.Mesh(gemGeometry, this.stopMaterial);
      const pin = new THREE.Mesh(pinGeometry, this.pinMaterial);
      g.add(pin, gem);
      const l = label('lbl-stop', `<b>休憩</b> ${fmtDurationJa(st.dur)}`);
      g.add(l);
      add(g, 'stop', { gem, pin, label: l });
    }

    // ウェイポイント
    for (const w of track.waypoints) {
      if (!w.name) continue;
      const g = new THREE.Group();
      g.position.set(w.x, heightAtXZ(w.x, w.z, w.ele, w.sample), w.z);
      const gem = new THREE.Mesh(gemGeometry, this.wptMaterial);
      const pin = new THREE.Mesh(pinGeometry, this.pinMaterial);
      g.add(pin, gem);
      const l = label('lbl-wpt', esc(w.name));
      g.add(l);
      add(g, 'wpt', { gem, pin, label: l });
    }
  }

  /** 見た目の大きさを視点の距離に合わせる */
  update(scale, time) {
    for (const it of this.items) {
      if (it.kind === 'beacon') {
        const h = 9 * scale;
        it.beam.scale.set(0.9 * scale, h, 0.9 * scale);
        it.ring.scale.setScalar(2.2 * scale * (1 + 0.08 * Math.sin(time * 2.5)));
        it.ring.position.y = 0.05 * scale;
        it.label.position.y = h * 0.55;
      } else {
        const h = (it.kind === 'km' ? 2.2 : 3) * scale;
        const s = (it.kind === 'km' ? 0.4 : 0.55) * scale;
        it.pin.scale.set(scale, h, scale);
        it.gem.scale.set(s, s * 1.3, s);
        it.gem.position.y = h + s * 1.3;
        it.gem.rotation.y = time * 0.8;
        it.label.position.y = h + s * 2.8;
      }
    }
  }
}
