// 太陽の高度で色が変わる空。夜は星が出る。
import * as THREE from 'three';

// 太陽高度（度）ごとの色。リニア空間で補間する。
const KEYS = [
  { alt: -18, top: '#03050d', hor: '#0a1128', gnd: '#04060c', sun: '#000000' },
  { alt: -8, top: '#0a1534', hor: '#24345f', gnd: '#070a14', sun: '#3a2a50' },
  { alt: -3, top: '#1a2a5a', hor: '#c9636a', gnd: '#0e0f18', sun: '#ff6a4a' },
  { alt: 2, top: '#2e4f92', hor: '#ff9a5a', gnd: '#1c1a1e', sun: '#ff8a3a' },
  { alt: 8, top: '#3f73bd', hor: '#ffd2a0', gnd: '#2a2b2e', sun: '#ffc070' },
  { alt: 20, top: '#3a7bd2', hor: '#bcd6f0', gnd: '#30343a', sun: '#fff0d6' },
  { alt: 60, top: '#2d6fcf', hor: '#cfe2f6', gnd: '#34383e', sun: '#fff8ec' },
].map((k) => ({
  alt: k.alt,
  top: new THREE.Color(k.top),
  hor: new THREE.Color(k.hor),
  gnd: new THREE.Color(k.gnd),
  sun: new THREE.Color(k.sun),
}));

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // 常に最奥
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uTime;
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  float len = max(length(vDir), 1e-4);
  vec3 dir = vDir / len;
  float h = dir.y;
  vec3 col;
  if (h >= 0.0) {
    col = mix(uHorizon, uTop, pow(max(h, 0.0), 0.45));
  } else {
    col = mix(uHorizon, uGround, pow(min(-h * 6.0, 1.0), 0.6));
  }
  // 太陽のまわりのにじみと円盤
  float s = max(dot(dir, normalize(uSunDir + vec3(0.0, 1e-4, 0.0))), 0.0);
  float horizonBand = 1.0 - min(abs(h) * 3.0, 1.0);
  col += uSunColor * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.6) * (0.5 + 0.5 * horizonBand);
  col += uSunColor * smoothstep(0.9994, 0.99975, s) * 6.0 * step(-0.02, h);

  // 星
  if (uNight > 0.01 && h > 0.0) {
    vec3 p = dir * 220.0;
    vec3 cell = floor(p);
    float r = hash(cell);
    if (r > 0.985) {
      vec3 center = cell + 0.5 + (vec3(hash(cell + 1.7), hash(cell + 3.1), hash(cell + 5.3)) - 0.5) * 0.6;
      float dd = length(p - center);
      float tw = 0.65 + 0.35 * sin(uTime * (1.0 + r * 3.0) + r * 40.0);
      float star = smoothstep(0.16, 0.0, dd) * tw * (r - 0.985) * 66.0;
      col += vec3(0.85, 0.9, 1.0) * star * uNight * smoothstep(0.0, 0.25, h);
    }
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Sky {
  constructor() {
    this.uniforms = {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uTime: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.horizon = new THREE.Color();
    this.ambientTop = new THREE.Color();
    this.ambientGround = new THREE.Color();
  }

  /** 太陽高度（ラジアン）から色を決める。daylight（0〜1）を返す。 */
  update(sunDir, altitude, time) {
    const deg = THREE.MathUtils.radToDeg(altitude);
    let i = 0;
    while (i < KEYS.length - 2 && deg > KEYS[i + 1].alt) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const f = THREE.MathUtils.clamp((deg - a.alt) / (b.alt - a.alt), 0, 1);
    const u = this.uniforms;
    u.uTop.value.copy(a.top).lerp(b.top, f);
    u.uHorizon.value.copy(a.hor).lerp(b.hor, f);
    u.uGround.value.copy(a.gnd).lerp(b.gnd, f);
    u.uSunColor.value.copy(a.sun).lerp(b.sun, f);
    u.uSunDir.value.copy(sunDir);
    u.uNight.value = THREE.MathUtils.smoothstep(-deg, 2, 12);
    u.uTime.value = time;
    this.horizon.copy(u.uHorizon.value);
    this.ambientTop.copy(u.uTop.value);
    this.ambientGround.copy(u.uGround.value);
    return THREE.MathUtils.smoothstep(deg, -6, 12);
  }

  follow(camera) {
    this.mesh.position.copy(camera.position);
    const r = camera.far * 0.5;
    this.mesh.scale.setScalar(r);
  }
}
