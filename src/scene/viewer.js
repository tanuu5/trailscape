// 3D ビューの本体。シーン・カメラ・ポストエフェクト・各パーツをまとめる。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Sky } from './sky.js';
import { Ground } from './ground.js';
import { Trail } from './trail.js';
import { Walker } from './walker.js';
import { Markers } from './markers.js';
import { Sparkles } from './effects.js';
import { TerrainMesh } from './terrain.js';
import { sunPosition, directionFromAltAz } from '../geo.js';
import { METRICS, makeRamp } from '../palette.js';

const DEG = Math.PI / 180;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Viewer {
  constructor(container, labelContainer) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    this.renderer = renderer;

    this.labelRenderer = new CSS2DRenderer({ element: labelContainer });

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#0a1128', 1000, 10000);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    this.camera.position.set(0, 800, 1200);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI * 0.488;
    controls.minDistance = 1.5;
    controls.autoRotateSpeed = 0.55;
    this.controls = controls;

    // ---- パーツ ----
    this.sky = new Sky();
    this.scene.add(this.sky.mesh);
    this.ground = new Ground();
    this.scene.add(this.ground.mesh);
    this.trail = new Trail();
    this.scene.add(this.trail.group);
    this.walker = new Walker();
    this.scene.add(this.walker.group);
    this.markers = new Markers();
    this.scene.add(this.markers.group);
    this.sparkles = new Sparkles();
    this.scene.add(this.sparkles.points);
    this.terrainMesh = null;

    this.hoverDot = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(2), transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.hoverDot.renderOrder = 10;
    this.hoverDot.visible = false;
    this.scene.add(this.hoverDot);

    // ---- 光 ----
    this.hemi = new THREE.HemisphereLight('#88aaff', '#202020', 1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffffff', 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    this.moon = new THREE.DirectionalLight('#9fb4ff', 0);
    this.scene.add(this.moon, this.moon.target);

    // ---- ポストエフェクト ----
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.8, 0.6, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // ---- 状態 ----
    this.track = null;
    this.settings = {
      metric: 'speed',
      exag: 1,
      width: 1,
      sky: 'auto',
      ghost: true,
      labels: true,
      bloom: true,
      heightMode: 'terrain',
    };
    this.heights = null;
    this.mode = 'overview';
    this.trans = null;
    this.state = {};
    this.walkerPos = new THREE.Vector3();
    this.prevWalkerPos = new THREE.Vector3();
    this.lookAhead = new THREE.Vector3();
    this.fpYaw = 0;
    this.fpPitch = 0;
    this.fpIdle = 0;
    this.daylight = 1;
    this.time = 0;
    this.uiScale = 1;
    this.fitPose = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this.followOffset = new THREE.Vector3();
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = directionFromAltAz(48 * DEG, 200 * DEG, new THREE.Vector3());

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    this.installFirstPersonLook();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  // ------------------------------------------------------------------
  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.sparkles.uniforms.uPx.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * DEG) / 2));
    this.width = w;
    this.height = h;
  }

  installFirstPersonLook() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'first') return;
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || this.mode !== 'first') return;
      this.fpYaw -= (e.clientX - drag.x) * 0.004;
      this.fpPitch = THREE.MathUtils.clamp(this.fpPitch - (e.clientY - drag.y) * 0.003, -1.2, 1.0);
      drag = { x: e.clientX, y: e.clientY };
      this.fpIdle = 0;
    });
    const end = () => {
      drag = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------
  /** 高さの強調のおすすめ値 */
  autoExaggeration() {
    const t = this.track;
    if (!t) return 1;
    if (this.terrainMesh) {
      const d = this.terrainMesh.data;
      const range = Math.max(1, d.maxH - d.minH);
      return Math.round(THREE.MathUtils.clamp((0.045 * t.extent) / range, 1, 3) * 2) / 2;
    }
    if (!t.hasEle) return 1;
    const range = t.stats.eleMax - t.stats.eleMin;
    if (!(range > 0.5)) return 1;
    return Math.round(THREE.MathUtils.clamp((0.07 * t.extent) / range, 1, 20) * 2) / 2;
  }

  setTrack(track) {
    this.track = track;
    this.ground.fit(track);
    this.camera.far = track.extent * 60;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = track.extent * 6;
    this.setTerrain(null, { rebuild: false });
    this.settings.exag = this.autoExaggeration();
    this.rebuild();
    this.computeFitPose();
    this.state = track.at(track.t0, this.state);
    this.updateWalkerPosition(0);
    this.prevWalkerPos.copy(this.walkerPos);
  }

  setTerrain(data, { rebuild = true } = {}) {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh.group);
      this.terrainMesh.dispose();
      this.terrainMesh = null;
    }
    if (data) {
      this.terrainMesh = new TerrainMesh(data);
      this.scene.add(this.terrainMesh.group);
    }
    if (rebuild && this.track) {
      this.settings.exag = this.autoExaggeration();
      this.rebuild();
      this.computeFitPose();
    }
  }

  /** 設定の変更を反映 */
  apply(partial) {
    const prev = { ...this.settings };
    Object.assign(this.settings, partial);
    const s = this.settings;
    this.trail.uniforms.uGhost.value = s.ghost ? 0.22 : 0;
    document.body.classList.toggle('no-labels', !s.labels);
    this.bloom.enabled = s.bloom;
    if (!this.track) return;
    if (s.exag !== prev.exag || s.heightMode !== prev.heightMode) {
      this.rebuild();
    } else if (s.metric !== prev.metric) {
      this.trail.recolor(this.colors());
    }
  }

  colors() {
    const t = this.track;
    const S = t.samples;
    const metric = this.settings.metric;
    const ramp = makeRamp(METRICS[metric].stops);
    const [lo, hi] = t.ranges[metric];
    const out = new Float32Array(S.n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < S.n; i++) {
      let v;
      switch (metric) {
        case 'speed':
          v = S.speed[i] * 3.6;
          break;
        case 'ele':
          v = S.ele[i];
          break;
        case 'time':
          v = S.timeFrac[i];
          break;
        case 'grade':
          v = S.grade[i];
          break;
        case 'hr':
          v = S.hr[i];
          break;
        default:
          v = 0;
      }
      ramp((v - lo) / (hi - lo || 1), c);
      out[i * 3] = c.r;
      out[i * 3 + 1] = c.g;
      out[i * 3 + 2] = c.b;
    }
    return out;
  }

  rebuild() {
    const t = this.track;
    const S = t.samples;
    const n = S.n;
    const exag = this.settings.exag;
    const ys = new Float32Array(n);
    let floors = new Float32Array(n);
    const tm = this.terrainMesh;
    if (tm) {
      tm.setExaggeration(exag);
      const useGps = this.settings.heightMode === 'gps' && t.hasEle;
      for (let i = 0; i < n; i++) {
        const g = tm.heightAt(S.x[i], S.z[i]);
        floors[i] = g;
        ys[i] = useGps ? Math.max(g, (S.ele[i] - tm.base) * exag) : g;
      }
      if (!useGps) floors = null;
      this.ground.setLevel(tm.floor - 0.5);
    } else {
      const base = t.stats.eleMin;
      let maxY = 0;
      for (let i = 0; i < n; i++) {
        ys[i] = t.hasEle ? (S.ele[i] - base) * exag : 0;
        maxY = Math.max(maxY, ys[i]);
      }
      if (maxY < 0.5) floors = null;
      this.ground.setLevel(0);
    }
    this.heights = ys;
    this.trail.build(t, ys, floors, this.colors());
    this.markers.build(
      t,
      (i) => ys[i],
      (x, z, ele, sample) => {
        if (tm) return tm.heightAt(x, z);
        return ys[sample];
      },
    );
    this.updateWalkerPosition(0);
  }

  computeFitPose() {
    const t = this.track;
    const S = t.samples;
    const box = new THREE.Box3();
    const v = this._v;
    for (let i = 0; i < S.n; i += Math.max(1, Math.floor(S.n / 500))) box.expandByPoint(v.set(S.x[i], this.heights[i], S.z[i]));
    box.expandByPoint(v.set(S.x[S.n - 1], this.heights[S.n - 1], S.z[S.n - 1]));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(50, box.getSize(new THREE.Vector3()).length() / 2);
    const vfov = this.camera.fov * DEG;
    let dist = (radius / Math.tan(vfov / 2)) * 1.05;
    if (this.camera.aspect < 1) dist /= Math.max(0.5, this.camera.aspect);
    const el = 36 * DEG;
    const az = -0.32;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.fitPose.target.copy(center);
    this.fitPose.pos.copy(center).addScaledVector(dir, dist);
  }

  // ------------------------------------------------------------------
  setCameraMode(mode, immediate = false) {
    this.mode = mode;
    const c = this.controls;
    c.autoRotate = mode === 'drone';
    c.enabled = mode !== 'first';
    c.zoomToCursor = mode === 'overview';
    this.walker.setFigureVisible(mode !== 'first');
    if (mode === 'follow' || mode === 'drone') {
      const back = this._v.set(-Math.sin(this.walker.heading), 0, -Math.cos(this.walker.heading));
      const far = mode === 'drone' ? 170 : 75;
      const up = mode === 'drone' ? 120 : 42;
      this.followOffset.copy(back).multiplyScalar(far).add(this._v2.set(0, up, 0));
    }
    if (mode === 'first') {
      this.fpYaw = 0;
      this.fpPitch = 0;
    }
    this.trans = {
      t: 0,
      dur: immediate ? 0 : 1.5,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
    };
  }

  /** 今のモードで理想のカメラ位置 */
  desiredPose(pos, target) {
    const w = this.walkerPos;
    switch (this.mode) {
      case 'overview':
        pos.copy(this.fitPose.pos);
        target.copy(this.fitPose.target);
        break;
      case 'follow':
      case 'drone':
        target.copy(w);
        pos.copy(w).add(this.followOffset);
        break;
      case 'first': {
        this.firstPersonPose(pos, target);
        break;
      }
    }
  }

  firstPersonPose(pos, target) {
    const t = this.track;
    const S = t.samples;
    const eye = pos.copy(this.walkerPos);
    eye.y += 1.62;
    const ahead = Math.min(S.n - 1, this.state.s + 28 / S.step);
    const p = this.samplePos(ahead, this._v2);
    p.y += 1.3;
    if (p.distanceToSquared(eye) < 4) {
      // 終点近く：向きだけ保つ
      p.set(eye.x + Math.sin(this.walker.heading) * 10, eye.y, eye.z + Math.cos(this.walker.heading) * 10);
    }
    this.lookAhead.lerp(p, this.lookAhead.lengthSq() === 0 ? 1 : 0.08);
    const dir = this._v.copy(this.lookAhead).sub(eye);
    const len = Math.max(dir.length(), 1e-3);
    dir.divideScalar(len);
    dir.applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.fpYaw);
    const horiz = Math.hypot(dir.x, dir.z);
    const pitch = Math.atan2(dir.y, horiz) + this.fpPitch;
    const yaw = Math.atan2(dir.x, dir.z);
    target.set(eye.x + Math.sin(yaw) * Math.cos(pitch) * 20, eye.y + Math.sin(pitch) * 20, eye.z + Math.cos(yaw) * Math.cos(pitch) * 20);
  }

  samplePos(s, out) {
    const S = this.track.samples;
    const i = Math.min(S.n - 2, Math.max(0, Math.floor(s)));
    const f = Math.min(1, Math.max(0, s - i));
    const ys = this.heights;
    return out.set(S.x[i] + (S.x[i + 1] - S.x[i]) * f, ys[i] + (ys[i + 1] - ys[i]) * f, S.z[i] + (S.z[i + 1] - S.z[i]) * f);
  }

  updateWalkerPosition() {
    if (!this.track || !this.heights) return;
    this.samplePos(this.state.s ?? 0, this.walkerPos);
    this.walkerPos.y += this.trail.uniforms.uRadius.value * 1.6;
  }

  // ------------------------------------------------------------------
  updateEnvironment(t) {
    const track = this.track;
    let alt;
    let az;
    switch (this.settings.sky) {
      case 'day':
        alt = 52 * DEG;
        az = 150 * DEG;
        break;
      case 'dusk':
        alt = 2.5 * DEG;
        az = 255 * DEG;
        break;
      case 'night':
        alt = -28 * DEG;
        az = 0;
        break;
      default:
        if (track?.hasTime) {
          const sp = sunPosition(t, track.proj.lat0, track.proj.lon0);
          alt = sp.altitude;
          az = sp.azimuth;
        } else {
          alt = 48 * DEG;
          az = 160 * DEG;
        }
    }
    directionFromAltAz(alt, az, this.sunDir);
    const day = this.sky.update(this.sunDir, alt, this.time);
    this.daylight = day;
    const night = 1 - day;
    const altDeg = alt / DEG;

    const sunI = THREE.MathUtils.smoothstep(altDeg, -1.5, 10);
    this.sun.intensity = 3.2 * sunI;
    this.sun.color.setRGB(1, 0.62, 0.38).lerp(this._c1 ??= new THREE.Color(1, 0.97, 0.92), THREE.MathUtils.smoothstep(altDeg, 2, 25));
    this.moon.intensity = 0.5 * night;
    this.hemi.color.copy(this.sky.ambientTop).lerp(this._c2 ??= new THREE.Color('#ffffff'), 0.25);
    this.hemi.groundColor.copy(this.sky.ambientGround);
    this.hemi.intensity = THREE.MathUtils.lerp(0.9, 1.5, day);
    this.scene.fog.color.copy(this.sky.horizon);

    this.ground.setDaylight(day, this.sky.horizon);
    this.terrainMesh?.setNight(night);

    const lightDir = sunI > 0.05 ? this.sunDir : this.moonDir;
    this.trail.uniforms.uLightDir.value.copy(lightDir);
    this.trail.uniforms.uGlow.value = THREE.MathUtils.lerp(1.9, 1.3, day);
    this.trail.uniforms.uCurtain.value = THREE.MathUtils.lerp(0.34, 0.42, day);
    this.bloom.strength = THREE.MathUtils.lerp(1.0, 0.45, day);
    return night;
  }

  // ------------------------------------------------------------------
  /** 1 フレーム進める。t は再生中の時刻（ms） */
  render(dt, t, playing) {
    this.time += dt;
    const track = this.track;
    if (!track) {
      this.composer.render(dt);
      return;
    }
    const S = track.samples;
    this.state = track.at(t, this.state);

    // 見た目の拡大率（視点からの距離に応じて）
    const camDist = this.mode === 'first' ? 2 : this.camera.position.distanceTo(this.controls.target);
    // 霧は視点からの距離で決まるので、引いたときに道が霞まないよう視点の距離を足す
    if (this.mode === 'first') {
      // 目の高さでは遠くの地面が地平線の 1px に詰まるので、近めの霞で空となじませる
      this.scene.fog.near = 40;
      this.scene.fog.far = Math.max(900, track.extent * 0.7);
    } else {
      this.scene.fog.near = camDist + track.extent * 1.2;
      this.scene.fog.far = camDist + track.extent * 9;
    }
    const width = this.settings.width;
    const tubeR = Math.max(0.22, camDist * 0.0026) * width;
    this.trail.uniforms.uRadius.value += (tubeR - this.trail.uniforms.uRadius.value) * Math.min(1, dt * 10 + (this.trans ? 0.3 : 0));
    this.uiScale = Math.max(1, camDist / 90);
    const markerScale = Math.max(0.6, camDist / 110);

    this.prevWalkerPos.copy(this.walkerPos);
    this.updateWalkerPosition();
    const a = this.samplePos(Math.max(0, this.state.s - 3 / S.step), this._v);
    const b = this.samplePos(Math.min(S.n - 1, this.state.s + 3 / S.step), this._v2);
    const night = this.updateEnvironment(t);
    this.walker.update({
      pos: this.walkerPos,
      dirX: b.x - a.x,
      dirZ: b.z - a.z,
      speed: playing ? this.state.speed : 0,
      dist: this.state.d,
      scale: this.uiScale,
      night,
      time: this.time,
      dt,
    });
    this.sparkles.uniforms.uColor.value.set(night > 0.5 ? '#9ff3ff' : '#ffffff');
    this.sparkles.emit(dt, this.time, this.walkerPos, playing && this.state.speed > 0.4 ? 22 : 2, this.uiScale);

    const u = this.trail.uniforms;
    // 近くから見ると道が画面の多くを占め、ブルームで白く飛ぶので光を抑える
    const near = THREE.MathUtils.smoothstep(camDist, 15, 400);
    u.uGlow.value *= THREE.MathUtils.lerp(0.55, 1, near);
    this.bloom.strength *= THREE.MathUtils.lerp(0.6, 1, near);
    // 一人称では足もとのカーテンが目の前の壁に見えるので出さない
    if (this.trail.curtain) this.trail.curtain.visible = this.mode !== 'first';
    u.uHead.value = this.state.d;
    u.uTime.value = this.time;
    u.uHeadLen.value = Math.max(6, camDist * 0.02);
    this.markers.update(markerScale, this.time);

    // 影は歩く人のまわりだけ。引いた視点では人が目印として大きく描かれるので影は落とさない
    this.walker.setCastShadow(this.uiScale < 2.5);
    const sh = this.sun.shadow.camera;
    const r = 4 * this.uiScale;
    sh.left = -r;
    sh.right = r;
    sh.top = r;
    sh.bottom = -r;
    sh.near = 0.5;
    sh.far = 200 * this.uiScale;
    sh.updateProjectionMatrix();
    this.sun.target.position.copy(this.walkerPos);
    this.sun.position.copy(this.walkerPos).addScaledVector(this.sunDir, 80 * this.uiScale);
    this.moon.target.position.copy(this.walkerPos);
    this.moon.position.copy(this.walkerPos).addScaledVector(this.moonDir, 100);

    this.updateCamera(dt);
    this.sky.follow(this.camera);
    this.composer.render(dt);
    this.labelRenderer.render(this.scene, this.camera);
  }

  updateCamera(dt) {
    const cam = this.camera;
    const c = this.controls;
    const pos = this._p ??= new THREE.Vector3();
    const target = this._t ??= new THREE.Vector3();

    if (this.mode === 'first') {
      this.fpIdle += dt;
      if (this.fpIdle > 1.6) {
        this.fpYaw *= 1 - Math.min(1, dt * 1.5);
        this.fpPitch *= 1 - Math.min(1, dt * 1.5);
      }
    }

    if (this.trans) {
      const tr = this.trans;
      tr.t += dt;
      const k = tr.dur > 0 ? ease(Math.min(1, tr.t / tr.dur)) : 1;
      this.desiredPose(pos, target);
      // 注視点からの向きを球面で補間すると、回り込むように動いて地面に潜らない
      const s1 = (this._s1 ??= new THREE.Spherical()).setFromVector3(this._v.subVectors(tr.fromPos, tr.fromTarget));
      const s2 = (this._s2 ??= new THREE.Spherical()).setFromVector3(this._v2.subVectors(pos, target));
      let dTheta = s2.theta - s1.theta;
      dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
      const r = Math.exp(THREE.MathUtils.lerp(Math.log(Math.max(s1.radius, 1e-3)), Math.log(Math.max(s2.radius, 1e-3)), k));
      const sp = (this._s3 ??= new THREE.Spherical()).set(r, THREE.MathUtils.lerp(s1.phi, s2.phi, k), s1.theta + dTheta * k);
      c.target.lerpVectors(tr.fromTarget, target, k);
      cam.position.setFromSpherical(sp).add(c.target);
      cam.lookAt(c.target);
      if (tr.t >= tr.dur) this.trans = null;
      if (this.mode !== 'first') c.update();
      return;
    }

    switch (this.mode) {
      case 'overview':
        c.update(dt);
        break;
      case 'follow':
      case 'drone': {
        const d = this._v.subVectors(this.walkerPos, this.prevWalkerPos);
        cam.position.add(d);
        c.target.copy(this.walkerPos);
        c.update(dt);
        break;
      }
      case 'first':
        this.firstPersonPose(pos, target);
        cam.position.copy(pos);
        c.target.copy(target);
        cam.lookAt(target);
        break;
    }
  }

  // ------------------------------------------------------------------
  /** 画面上の点に近い道のサンプル番号。なければ -1 */
  pick(clientX, clientY, maxPx = 16) {
    if (!this.track || !this.heights) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const S = this.track.samples;
    const v = this._v;
    const lift = this.trail.uniforms.uRadius.value;
    const stride = Math.max(1, Math.floor(S.n / 2500));
    let best = -1;
    let bd = maxPx * maxPx;
    const test = (i) => {
      v.set(S.x[i], this.heights[i] + lift, S.z[i]).project(this.camera);
      if (v.z > 1 || v.z < -1) return;
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      const d2 = (sx - clientX) ** 2 + (sy - clientY) ** 2;
      if (d2 < bd) {
        bd = d2;
        best = i;
      }
    };
    for (let i = 0; i < S.n; i += stride) test(i);
    if (best >= 0 && stride > 1) {
      const c = best;
      for (let i = Math.max(0, c - stride); i <= Math.min(S.n - 1, c + stride); i++) test(i);
    }
    return best;
  }

  setHover(sample) {
    if (sample < 0 || !this.track) {
      this.hoverDot.visible = false;
      return;
    }
    const p = this.samplePos(sample, this._v);
    const r = this.trail.uniforms.uRadius.value;
    this.hoverDot.position.set(p.x, p.y + r, p.z);
    this.hoverDot.scale.setScalar(r * 2.2);
    this.hoverDot.visible = true;
  }

  /** 今の画面を PNG にする */
  screenshot(dt, t) {
    this.render(dt, t, false);
    return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
  }
}
