// 光の柱（スタート・ゴール・現在地）と、足もとのきらめき。
import * as THREE from 'three';

const beamVS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying float vY;
varying float vEdge;
void main() {
  vY = position.y;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 v = cameraPosition - worldPos.xyz;
  v /= max(length(v), 1e-4);
  vEdge = 1.0 - abs(dot(n, v));
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  #include <logdepthbuf_vertex>
}
`;

const beamFS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying float vY;
varying float vEdge;
void main() {
  #include <logdepthbuf_fragment>
  float y = clamp(vY, 0.0, 1.0);
  float a = pow(1.0 - y, 1.8) * uOpacity * (0.35 + 0.65 * (1.0 - pow(clamp(vEdge, 0.0, 1.0), 2.0)));
  gl_FragColor = vec4(uColor * 1.6, a);
}
`;

const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);

export function makeBeam(color, opacity = 0.8) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: beamVS,
    fragmentShader: beamFS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(beamGeometry, mat);
  m.renderOrder = 5;
  return m;
}

const ringGeometry = new THREE.RingGeometry(0.75, 1, 64).rotateX(-Math.PI / 2);

export function makeRing(color, opacity = 0.9) {
  const m = new THREE.Mesh(
    ringGeometry,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(1.6),
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  m.renderOrder = 4;
  return m;
}

// ---- きらめき ----
const sparkVS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aBirth;
attribute vec3 aVel;
uniform float uTime;
uniform float uLife;
uniform float uSize;
uniform float uPx;
varying float vA;
void main() {
  float age = uTime - aBirth;
  float k = clamp(age / uLife, 0.0, 1.0);
  vec3 p = position + aVel * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float alive = step(0.0, age) * step(age, uLife);
  vA = (1.0 - k) * alive;
  gl_PointSize = alive * uSize * (1.0 - k * 0.6) * uPx / max(-mv.z, 1e-3);
  #include <logdepthbuf_vertex>
}
`;

const sparkFS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * 2.0, a);
}
`;

export class Sparkles {
  constructor(count = 320) {
    this.count = count;
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.birth = new Float32Array(count).fill(-1e6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = {
      uTime: { value: 0 },
      uLife: { value: 1.8 },
      uSize: { value: 0.3 },
      uPx: { value: 800 },
      uColor: { value: new THREE.Color('#9ff3ff') },
    };
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: sparkVS,
        fragmentShader: sparkFS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.acc = 0;
  }

  /** rate: 1 秒あたりの数、scale: 見た目の大きさの倍率 */
  emit(dt, time, at, rate, scale) {
    this.acc += dt * rate;
    const g = this.points.geometry;
    let any = false;
    while (this.acc >= 1) {
      this.acc -= 1;
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
      const r = 0.6 * scale * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      this.pos[i * 3] = at.x + Math.cos(a) * r;
      this.pos[i * 3 + 1] = at.y + 0.1 * scale;
      this.pos[i * 3 + 2] = at.z + Math.sin(a) * r;
      this.vel[i * 3] = (Math.random() - 0.5) * 0.25 * scale;
      this.vel[i * 3 + 1] = (0.5 + Math.random() * 0.9) * scale;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.25 * scale;
      this.birth[i] = time + Math.random() * 0.05;
      any = true;
    }
    if (any) {
      g.attributes.position.needsUpdate = true;
      g.attributes.aVel.needsUpdate = true;
      g.attributes.aBirth.needsUpdate = true;
    }
    this.uniforms.uTime.value = time;
    this.uniforms.uSize.value = 0.32 * scale;
  }
}
