// 光るチューブの軌跡と、その下に垂れる半透明の「カーテン」。
// 再生位置（uHead, 距離）より先はうっすら表示、または隠す。
import * as THREE from 'three';

const RADIAL = 10;

const tubeVS = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec3 aNormal;
attribute float aDist;
attribute vec3 aColor;
uniform float uRadius;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying float vDist;
varying vec3 vColor;
void main() {
  vec3 p = position + aNormal * uRadius + vec3(0.0, uRadius, 0.0);
  vec4 worldPos = modelMatrix * vec4(p, 1.0);
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  vNormalW = aNormal;
  vec3 v = cameraPosition - worldPos.xyz;
  vViewDir = v / max(length(v), 1e-4);
  vDist = aDist;
  vColor = aColor;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const tubeFS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uHead;
uniform float uGhost;
uniform float uTime;
uniform vec3 uLightDir;
uniform float uGlow;
uniform float uHeadLen;
uniform float uFlowLen;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying float vDist;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  float revealed = step(vDist, uHead);
  if (revealed < 0.5 && uGhost < 0.001) discard;
  vec3 n = vNormalW / max(length(vNormalW), 1e-4);
  float diff = max(dot(n, uLightDir), 0.0) * 0.55 + 0.45;
  float rim = pow(max(1.0 - max(dot(n, vViewDir), 0.0), 0.0), 2.5);
  vec3 col = vColor * diff * uGlow + vColor * rim * 0.9;

  // 先頭の光
  float behind = max(uHead - vDist, 0.0);
  float head = exp(-behind / max(uHeadLen, 1e-3)) * revealed;
  col += (vColor * 1.3 + vec3(0.2)) * head;

  // 先頭へ向かって流れる光の粒
  float phase = (vDist - uTime * uFlowLen * 0.35) / max(uFlowLen, 1e-3);
  float flow = pow(max(0.5 + 0.5 * sin(phase * 6.2831853), 0.0), 12.0);
  col += vColor * flow * 0.55 * revealed;

  float alpha = 1.0;
  if (revealed < 0.5) {
    float l = dot(vColor, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), vColor, 0.6) * 0.6 + vColor * rim * 0.3;
    alpha = uGhost;
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const curtainVS = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aT;
attribute float aDist;
attribute vec3 aColor;
varying float vT;
varying float vDist;
varying vec3 vColor;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vT = aT;
  vDist = aDist;
  vColor = aColor;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const curtainFS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uHead;
uniform float uGhost;
uniform float uCurtain;
uniform float uStripe;
varying float vT;
varying float vDist;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  float revealed = step(vDist, uHead);
  float a = pow(clamp(vT, 0.0, 1.0), 1.6) * uCurtain;
  a *= mix(uGhost * 0.35, 1.0, revealed);
  float stripe = 0.8 + 0.2 * step(0.5, fract(vDist / max(uStripe, 1e-3)));
  // 上端は線のように明るく
  a += smoothstep(0.97, 1.0, vT) * 0.25 * uCurtain * mix(uGhost, 1.0, revealed);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * stripe, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Trail {
  constructor() {
    this.group = new THREE.Group();
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uRadius: { value: 1 },
        uHead: { value: 0 },
        uGhost: { value: 0.22 },
        uTime: { value: 0 },
        uLightDir: { value: new THREE.Vector3(0.3, 1, 0.2).normalize() },
        uGlow: { value: 1 },
        uHeadLen: { value: 40 },
        uFlowLen: { value: 120 },
        uCurtain: { value: 0.32 },
        uStripe: { value: 10 },
      },
    ]);
    this.tubeMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: tubeVS,
      fragmentShader: tubeFS,
      fog: true,
      transparent: true,
    });
    this.curtainMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: curtainVS,
      fragmentShader: curtainFS,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
    this.tube = null;
    this.curtain = null;
    this.line = null;
  }

  dispose() {
    for (const o of [this.tube, this.curtain, this.line]) {
      if (!o) continue;
      o.geometry.dispose();
      this.group.remove(o);
    }
    this.tube = this.curtain = this.line = null;
  }

  /**
   * heights: 各サンプルの道の高さ、floors: カーテンの下端（null ならカーテンなし）
   * colors: 各サンプルの色（リニア RGB）
   */
  build(track, heights, floors, colors) {
    this.dispose();
    const S = track.samples;
    const n = S.n;

    // ---- チューブ ----
    const pos = new Float32Array(n * RADIAL * 3);
    const nor = new Float32Array(n * RADIAL * 3);
    const dist = new Float32Array(n * RADIAL);
    const col = new Float32Array(n * RADIAL * 3);
    const T = new THREE.Vector3();
    const side = new THREE.Vector3(1, 0, 0);
    const up = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      T.set(S.x[b] - S.x[a], heights[b] - heights[a], S.z[b] - S.z[a]);
      if (T.lengthSq() > 1e-10) {
        T.normalize();
        tmp.crossVectors(T, Y);
        if (tmp.lengthSq() > 1e-8) side.copy(tmp.normalize());
      }
      up.crossVectors(side, T).normalize();
      for (let j = 0; j < RADIAL; j++) {
        const ang = (j / RADIAL) * Math.PI * 2;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const k = i * RADIAL + j;
        pos[k * 3] = S.x[i];
        pos[k * 3 + 1] = heights[i];
        pos[k * 3 + 2] = S.z[i];
        nor[k * 3] = up.x * c + side.x * s;
        nor[k * 3 + 1] = up.y * c + side.y * s;
        nor[k * 3 + 2] = up.z * c + side.z * s;
        dist[k] = i * S.step;
        col[k * 3] = colors[i * 3];
        col[k * 3 + 1] = colors[i * 3 + 1];
        col[k * 3 + 2] = colors[i * 3 + 2];
      }
    }
    const idx = new Uint32Array((n - 1) * RADIAL * 6);
    let w = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * RADIAL + j;
        const b = i * RADIAL + ((j + 1) % RADIAL);
        const c = (i + 1) * RADIAL + j;
        const d = (i + 1) * RADIAL + ((j + 1) % RADIAL);
        idx[w++] = a;
        idx[w++] = b;
        idx[w++] = c;
        idx[w++] = b;
        idx[w++] = d;
        idx[w++] = c;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aNormal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.boundingSphere.radius += track.extent * 0.05;
    this.tube = new THREE.Mesh(g, this.tubeMaterial);
    this.tube.renderOrder = 2;
    this.group.add(this.tube);

    // ---- カーテン ----
    if (floors) {
      const cp = new Float32Array(n * 2 * 3);
      const ct = new Float32Array(n * 2);
      const cd = new Float32Array(n * 2);
      const cc = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        for (let e = 0; e < 2; e++) {
          const k = i * 2 + e;
          cp[k * 3] = S.x[i];
          cp[k * 3 + 1] = e ? heights[i] : floors[i];
          cp[k * 3 + 2] = S.z[i];
          ct[k] = e;
          cd[k] = i * S.step;
          cc[k * 3] = colors[i * 3];
          cc[k * 3 + 1] = colors[i * 3 + 1];
          cc[k * 3 + 2] = colors[i * 3 + 2];
        }
      }
      const ci = new Uint32Array((n - 1) * 6);
      let q = 0;
      for (let i = 0; i < n - 1; i++) {
        const a = i * 2;
        ci[q++] = a;
        ci[q++] = a + 2;
        ci[q++] = a + 1;
        ci[q++] = a + 1;
        ci[q++] = a + 2;
        ci[q++] = a + 3;
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(cp, 3));
      cg.setAttribute('aT', new THREE.BufferAttribute(ct, 1));
      cg.setAttribute('aDist', new THREE.BufferAttribute(cd, 1));
      cg.setAttribute('aColor', new THREE.BufferAttribute(cc, 3));
      cg.setIndex(new THREE.BufferAttribute(ci, 1));
      cg.computeBoundingSphere();
      this.curtain = new THREE.Mesh(cg, this.curtainMaterial);
      this.curtain.renderOrder = 1;
      this.group.add(this.curtain);

      // 地面に落ちる細い線
      const lp = new Float32Array(n * 3);
      const lc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        lp[i * 3] = S.x[i];
        lp[i * 3 + 1] = floors[i] + 0.05;
        lp[i * 3 + 2] = S.z[i];
        lc.set([colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]], i * 3);
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
      this.line = new THREE.Line(lg, this.lineMaterial);
      this.group.add(this.line);
    }

    this.uniforms.uStripe.value = Math.max(2, track.extent / 300);
    this.uniforms.uFlowLen.value = Math.max(40, track.total / 30);
  }

  /** 色だけ差し替える（色分けの切り替え） */
  recolor(colors) {
    const set = (geom, per) => {
      if (!geom) return;
      const attr = geom.getAttribute(per === 0 ? 'color' : 'aColor');
      const arr = attr.array;
      const rep = per || 1;
      const n = arr.length / 3 / rep;
      for (let i = 0; i < n; i++) {
        for (let r = 0; r < rep; r++) {
          const k = (i * rep + r) * 3;
          arr[k] = colors[i * 3];
          arr[k + 1] = colors[i * 3 + 1];
          arr[k + 2] = colors[i * 3 + 2];
        }
      }
      attr.needsUpdate = true;
    };
    set(this.tube?.geometry, RADIAL);
    set(this.curtain?.geometry, 2);
    set(this.line?.geometry, 0);
  }
}
