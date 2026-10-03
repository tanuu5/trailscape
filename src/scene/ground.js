// 方眼の地面。夜はグリッドがほのかに光る。
import * as THREE from 'three';

function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-6)));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

const NIGHT = new THREE.Color('#070b16');
const DAY = new THREE.Color('#56616c');
const LINE_NIGHT = new THREE.Color('#5ee7ff');
const LINE_DAY = new THREE.Color('#b8c8dc');

export class Ground {
  constructor() {
    this.uniforms = {
      uMinor: { value: 10 },
      uMajor: { value: 100 },
      uLineColor: { value: new THREE.Color('#5ee7ff') },
      uLineMix: { value: 0.5 },
      uLineGlow: { value: 0.3 },
      uCenter: { value: new THREE.Vector2() },
      uRadius: { value: 1000 },
    };
    const mat = new THREE.MeshStandardMaterial({ color: '#0a0e1a', roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGridPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGridPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vGridPos;
uniform float uMinor;
uniform float uMajor;
uniform vec3 uLineColor;
uniform float uLineMix;
uniform float uLineGlow;
uniform vec2 uCenter;
uniform float uRadius;
float gridLine(vec2 p, float spacing, float width) {
  vec2 c = p / spacing;
  vec2 fw = max(fwidth(c), vec2(1e-5));
  vec2 g = abs(fract(c - 0.5) - 0.5) / fw;
  float l = min(g.x, g.y);
  return 1.0 - min(l / width, 1.0);
}`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
{
  vec2 gp = vGridPos.xz;
  float fwMinor = max(fwidth(gp.x / uMinor), fwidth(gp.y / uMinor));
  float fwMajor = max(fwidth(gp.x / uMajor), fwidth(gp.y / uMajor));
  float minor = gridLine(gp, uMinor, 1.0) * (1.0 - smoothstep(0.08, 0.3, fwMinor));
  float major = gridLine(gp, uMajor, 1.4) * (1.0 - smoothstep(0.15, 0.5, fwMajor));
  float lines = max(minor * 0.35, major * 0.85);
  float r = length(gp - uCenter) / max(uRadius, 1.0);
  float focus = 1.0 - smoothstep(0.6, 2.4, r);
  diffuseColor.rgb = mix(diffuseColor.rgb, uLineColor, lines * uLineMix * (0.35 + 0.65 * focus));
  totalEmissiveRadiance += uLineColor * lines * uLineGlow * (0.25 + 0.75 * focus);
}`,
        );
    };
    this.material = mat;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1;
  }

  fit(track) {
    const size = track.extent * 60;
    this.mesh.scale.set(size, 1, size);
    this.mesh.position.set(track.center.x, 0, track.center.z);
    const minor = niceStep(track.extent / 30);
    this.uniforms.uMinor.value = minor;
    this.uniforms.uMajor.value = minor * 5;
    this.uniforms.uCenter.value.set(track.center.x, track.center.z);
    this.uniforms.uRadius.value = track.extent * 0.6;
  }

  setLevel(y) {
    this.mesh.position.y = y;
  }

  /** daylight: 0（夜）〜1（昼） */
  setDaylight(day, horizon) {
    this.material.color.copy(NIGHT).lerp(DAY, day);
    // 夕方は地平線の色を少し拾う
    this.material.color.lerp(horizon, 0.12 * (1 - Math.abs(day - 0.5) * 2));
    this.uniforms.uLineColor.value.copy(LINE_DAY).lerp(LINE_NIGHT, 1 - day);
    this.uniforms.uLineMix.value = THREE.MathUtils.lerp(0.42, 0.32, day);
    this.uniforms.uLineGlow.value = THREE.MathUtils.lerp(0.36, 0.04, day);
  }
}
