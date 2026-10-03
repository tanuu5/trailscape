// 道を歩く小さな人。歩いた距離に合わせて手足を振る。
import * as THREE from 'three';
import { makeBeam, makeRing } from './effects.js';

const ACCENT = '#5ee7ff';

function limb(radius, length, material) {
  const pivot = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 12), material);
  m.position.y = -(length / 2 + radius);
  m.castShadow = true;
  pivot.add(m);
  return pivot;
}

export class Walker {
  constructor() {
    this.group = new THREE.Group();
    this.figure = new THREE.Group();
    this.group.add(this.figure);

    const jacket = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.35, roughness: 0.45 });
    const skin = new THREE.MeshStandardMaterial({ color: '#f4efe8', roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: '#2b3247', roughness: 0.7 });
    const cap = new THREE.MeshStandardMaterial({ color: '#ff5ca8', emissive: '#ff5ca8', emissiveIntensity: 0.3, roughness: 0.5 });
    this.materials = [jacket, skin, pants, cap];

    this.body = new THREE.Group();
    this.body.position.y = 0.9;
    this.figure.add(this.body);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.4, 6, 14), jacket);
    torso.position.y = 0.3;
    torso.castShadow = true;
    this.body.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), skin);
    head.position.y = 0.76;
    head.castShadow = true;
    this.body.add(head);
    const capTop = new THREE.Mesh(new THREE.SphereGeometry(0.145, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    capTop.position.y = 0.79;
    this.body.add(capTop);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 20, 1, false, -Math.PI / 2, Math.PI), cap);
    brim.position.set(0, 0.79, 0.1);
    brim.scale.set(1, 1, 0.9);
    this.body.add(brim);

    this.legL = limb(0.07, 0.74, pants);
    this.legR = limb(0.07, 0.74, pants);
    this.legL.position.set(-0.09, 0.9, 0);
    this.legR.position.set(0.09, 0.9, 0);
    this.figure.add(this.legL, this.legR);

    this.armL = limb(0.05, 0.42, jacket);
    this.armR = limb(0.05, 0.42, jacket);
    this.armL.position.set(-0.25, 0.56, 0);
    this.armR.position.set(0.25, 0.56, 0);
    this.body.add(this.armL, this.armR);

    // 足もとのリングと光の柱（遠くからでも位置がわかるように）
    this.ring = makeRing(ACCENT, 0.9);
    this.ring2 = makeRing(ACCENT, 0.6);
    this.group.add(this.ring, this.ring2);
    this.beam = makeBeam(ACCENT, 0.9);
    this.group.add(this.beam);

    this.light = new THREE.PointLight(ACCENT, 0, 0, 2);
    this.light.position.y = 2.2;
    this.group.add(this.light);

    this.heading = 0;
    this.swing = 0;
    this.pos = new THREE.Vector3();
  }

  setCastShadow(on) {
    if (this.casting === on) return;
    this.casting = on;
    this.figure.traverse((o) => {
      if (o.isMesh) o.castShadow = on;
    });
  }

  setFigureVisible(v) {
    this.figure.visible = v;
    this.ring.visible = v;
    this.ring2.visible = v;
  }

  /**
   * pos: 足もとの位置、dir: 進行方向（xz）、speed: m/s、dist: 歩いた距離
   * scale: 遠くから見たときの拡大率、night: 0〜1
   */
  update({ pos, dirX, dirZ, speed, dist, scale, night, time, dt }) {
    this.pos.copy(pos);
    this.group.position.copy(pos);
    this.figure.scale.setScalar(scale);

    if (dirX * dirX + dirZ * dirZ > 1e-8) {
      const target = Math.atan2(dirX, dirZ);
      let diff = target - this.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.heading += diff * Math.min(1, dt * 8);
    }
    this.figure.rotation.y = this.heading;

    const moving = Math.min(1, Math.max(0, speed / 1.3));
    this.swing += (moving - this.swing) * Math.min(1, dt * 6);
    const run = speed > 2.6;
    const stride = run ? 1.1 : 0.72;
    const phase = (dist / stride) * Math.PI;
    const amp = this.swing * (run ? 0.85 : 0.5);
    const s = Math.sin(phase);
    this.legL.rotation.x = s * amp;
    this.legR.rotation.x = -s * amp;
    this.armL.rotation.x = -s * amp * 0.9;
    this.armR.rotation.x = s * amp * 0.9;
    const breathe = Math.sin(time * 2.2) * 0.012 * (1 - this.swing);
    this.body.position.y = 0.9 + Math.abs(Math.cos(phase)) * 0.045 * this.swing + breathe;
    this.body.rotation.x = 0.07 * this.swing + (run ? 0.12 : 0);

    // リングの波紋
    const k = (time * 0.7) % 1;
    const rs = scale * (0.6 + 0.2 * Math.sin(time * 3));
    this.ring.scale.setScalar(rs);
    this.ring.position.y = 0.03 * scale;
    this.ring2.scale.setScalar(scale * (0.6 + k * 2.4));
    this.ring2.material.opacity = (1 - k) * 0.6;
    this.ring2.position.y = 0.02 * scale;

    // 光の柱は引いた視点のときだけ
    const beamA = THREE.MathUtils.smoothstep(scale, 2, 7);
    this.beam.visible = beamA > 0.01;
    this.beam.material.uniforms.uOpacity.value = beamA * 0.85;
    this.beam.scale.set(scale * 0.35, scale * 10, scale * 0.35);

    this.light.intensity = night * 6 * Math.max(1, scale * scale * 0.3);
    this.light.distance = 25 * scale;
    this.light.position.y = 2.2 * scale;
  }
}
