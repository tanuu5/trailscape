// 地理院タイルから地形のジオラマを作る（ユーザーがオンにしたときだけ通信する）。
//  - 標高: DEM5A（5m メッシュ, z15）→ 足りないところは DEM10（z14）で補う
//  - 表面: 航空写真 / 標準地図 / 淡色地図 / 色別標高図
import * as THREE from 'three';
import { lonToTileX, latToTileY } from '../geo.js';

const BASE = 'https://cyberjapandata.gsi.go.jp/xyz';

export const LAYERS = {
  seamlessphoto: { ext: 'jpg', maxZoom: 18, label: '航空写真' },
  std: { ext: 'png', maxZoom: 18, label: '標準地図' },
  pale: { ext: 'png', maxZoom: 18, label: '淡色地図' },
  relief: { ext: 'png', maxZoom: 15, label: '色別標高図' },
};

const MAX_TILES_PER_AXIS = 12;

async function fetchBitmap(url, signal) {
  try {
    const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

async function pool(jobs, limit, onDone) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
      onDone();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

function decodeDEM(bitmap) {
  const c = new OffscreenCanvas(256, 256);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const d = g.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) {
    const v = d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2];
    out[i] = v === 8388608 ? NaN : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
  }
  return out;
}

class DEMSource {
  constructor(zoom) {
    this.zoom = zoom;
    this.tiles = new Map();
  }
  pixel(gx, gy) {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    const t = this.tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
  }
  sample(lat, lon) {
    const px = lonToTileX(lon, this.zoom) * 256 - 0.5;
    const py = latToTileY(lat, this.zoom) * 256 - 0.5;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const a = this.pixel(x0, y0);
    const b = this.pixel(x0 + 1, y0);
    const c = this.pixel(x0, y0 + 1);
    const d = this.pixel(x0 + 1, y0 + 1);
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    // どれかが欠けていたら、最も近い有効な値
    const cand = [
      [a, fx + fy],
      [b, 1 - fx + fy],
      [c, fx + 1 - fy],
      [d, 2 - fx - fy],
    ].filter(([v]) => Number.isFinite(v));
    if (!cand.length) return NaN;
    cand.sort((p, q) => p[1] - q[1]);
    return cand[0][0];
  }
}

function tileRange(bounds, z) {
  const x0 = Math.floor(lonToTileX(bounds.lonMin, z));
  const x1 = Math.floor(lonToTileX(bounds.lonMax, z));
  const y0 = Math.floor(latToTileY(bounds.latMax, z));
  const y1 = Math.floor(latToTileY(bounds.latMin, z));
  return { x0, x1, y0, y1, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
}

/**
 * 地形データを取ってくる。返り値は高さのグリッド（メートル）と表面の画像。
 * onProgress(done, total)
 */
export async function fetchTerrain(track, layerId, { signal, onProgress } = {}) {
  const layer = LAYERS[layerId] ?? LAYERS.seamlessphoto;
  const { proj, bbox } = track;

  // 少し広めに切り出し、極端に細長くならないようにする
  const w0 = bbox.xMax - bbox.xMin;
  const h0 = bbox.zMax - bbox.zMin;
  const pad = Math.max(220, Math.max(w0, h0) * 0.18);
  let w = w0 + pad * 2;
  let h = h0 + pad * 2;
  w = Math.max(w, h * 0.6);
  h = Math.max(h, w * 0.6);
  const cx = (bbox.xMin + bbox.xMax) / 2;
  const cz = (bbox.zMin + bbox.zMax) / 2;
  const area = { xMin: cx - w / 2, xMax: cx + w / 2, zMin: cz - h / 2, zMax: cz + h / 2 };
  const bounds = {
    lonMin: proj.toLon(area.xMin),
    lonMax: proj.toLon(area.xMax),
    latMin: proj.toLat(area.zMax),
    latMax: proj.toLat(area.zMin),
  };

  let iz = layer.maxZoom;
  while (iz > 8) {
    const r = tileRange(bounds, iz);
    if (r.nx <= MAX_TILES_PER_AXIS && r.ny <= MAX_TILES_PER_AXIS) break;
    iz--;
  }
  const ir = tileRange(bounds, iz);

  const dem5 = new DEMSource(15);
  const dem10 = new DEMSource(14);
  const d5r = tileRange(bounds, 15);
  const d10r = tileRange(bounds, 14);
  const useDem5 = d5r.nx * d5r.ny <= 64;

  const canvas = new OffscreenCanvas(ir.nx * 256, ir.ny * 256);
  const g = canvas.getContext('2d');
  g.fillStyle = '#4a4f55';
  g.fillRect(0, 0, canvas.width, canvas.height);

  const jobs = [];
  let imageOk = 0;
  for (let ty = ir.y0; ty <= ir.y1; ty++) {
    for (let tx = ir.x0; tx <= ir.x1; tx++) {
      jobs.push(async () => {
        const bmp = await fetchBitmap(`${BASE}/${layerId}/${iz}/${tx}/${ty}.${layer.ext}`, signal);
        if (bmp) {
          g.drawImage(bmp, (tx - ir.x0) * 256, (ty - ir.y0) * 256);
          bmp.close();
          imageOk++;
        }
      });
    }
  }
  const demJobs = (src, r, name) => {
    for (let ty = r.y0; ty <= r.y1; ty++) {
      for (let tx = r.x0; tx <= r.x1; tx++) {
        jobs.push(async () => {
          const bmp = await fetchBitmap(`${BASE}/${name}/${src.zoom}/${tx}/${ty}.png`, signal);
          if (bmp) {
            src.tiles.set(`${tx}/${ty}`, decodeDEM(bmp));
            bmp.close();
          }
        });
      }
    }
  };
  if (useDem5) demJobs(dem5, d5r, 'dem5a_png');
  demJobs(dem10, d10r, 'dem_png');

  let done = 0;
  onProgress?.(0, jobs.length);
  await pool(jobs, 6, () => onProgress?.(++done, jobs.length));

  if (!imageOk && !dem10.tiles.size) {
    throw new Error('この範囲の地理院タイルを取得できませんでした（日本国外か、通信できない状態かもしれません）。');
  }

  // 高さのグリッド
  const spacing = Math.max(3, Math.max(w, h) / 360);
  const nx = Math.min(420, Math.max(32, Math.round(w / spacing) + 1));
  const nz = Math.min(420, Math.max(32, Math.round(h / spacing) + 1));
  const heights = new Float32Array(nx * nz);
  const uvs = new Float32Array(nx * nz * 2);
  let missing = 0;
  const pxScale = 256 * 2 ** iz;
  for (let j = 0; j < nz; j++) {
    const z = area.zMin + ((area.zMax - area.zMin) * j) / (nz - 1);
    const lat = proj.toLat(z);
    const py = latToTileY(lat, iz) * 256;
    for (let i = 0; i < nx; i++) {
      const x = area.xMin + ((area.xMax - area.xMin) * i) / (nx - 1);
      const lon = proj.toLon(x);
      let v = useDem5 ? dem5.sample(lat, lon) : NaN;
      if (!Number.isFinite(v)) v = dem10.sample(lat, lon);
      if (!Number.isFinite(v)) missing++;
      heights[j * nx + i] = v;
      const px = ((lon + 180) / 360) * pxScale;
      uvs[(j * nx + i) * 2] = (px - ir.x0 * 256) / (ir.nx * 256);
      uvs[(j * nx + i) * 2 + 1] = 1 - (py - ir.y0 * 256) / (ir.ny * 256);
    }
  }
  // 欠けた所（海など）は 0 m、全部欠けていれば平らにする
  let minH = Infinity;
  let maxH = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    if (!Number.isFinite(heights[k])) heights[k] = 0;
    minH = Math.min(minH, heights[k]);
    maxH = Math.max(maxH, heights[k]);
  }

  const bitmap = canvas.transferToImageBitmap();
  return { area, nx, nz, heights, uvs, minH, maxH, bitmap, missing, layerId, zoom: iz };
}

/** 取ってきたデータからメッシュを作る */
export class TerrainMesh {
  constructor(data) {
    this.data = data;
    const { nx, nz, area, uvs } = data;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = area.xMin + ((area.xMax - area.xMin) * i) / (nx - 1);
        pos[k * 3 + 2] = area.zMin + ((area.zMax - area.zMin) * j) / (nz - 1);
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let w = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx[w++] = a;
        idx[w++] = c;
        idx[w++] = b;
        idx[w++] = b;
        idx[w++] = c;
        idx[w++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));

    const tex = new THREE.Texture(data.bitmap);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    // ImageBitmap は flipY が効かないので、v を反転して使う
    const uv = g.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k));
    this.texture = tex;

    this.material = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.95,
      metalness: 0,
      emissiveMap: tex,
      emissive: '#ffffff',
      emissiveIntensity: 0,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.receiveShadow = true;

    // 側面（ジオラマの土台）
    const perim = [];
    for (let i = 0; i < nx; i++) perim.push(i);
    for (let j = 1; j < nz; j++) perim.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) perim.push((nz - 1) * nx + i);
    for (let j = nz - 2; j >= 0; j--) perim.push(j * nx);
    this.perim = perim;
    const sp = new Float32Array(perim.length * 2 * 3);
    const sc = new Float32Array(perim.length * 2 * 3);
    const top = new THREE.Color('#6b5a45');
    const bottom = new THREE.Color('#1e1a16');
    perim.forEach((k, p) => {
      for (let e = 0; e < 2; e++) {
        const o = (p * 2 + e) * 3;
        sp[o] = pos[k * 3];
        sp[o + 2] = pos[k * 3 + 2];
        const c = e ? top : bottom;
        sc[o] = c.r;
        sc[o + 1] = c.g;
        sc[o + 2] = c.b;
      }
    });
    const si = [];
    for (let p = 0; p < perim.length - 1; p++) {
      const a = p * 2;
      si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    sg.setIndex(si);
    this.skirt = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    this.skirt.receiveShadow = true;

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.skirt);
    this.base = data.minH;
    this.exag = 1;
    this.floor = 0;
  }

  /** 高さの強調を変えたら頂点を作り直す。floor は土台の底の高さ。 */
  setExaggeration(exag) {
    this.exag = exag;
    const { heights, nx, nz, area } = this.data;
    const pos = this.mesh.geometry.getAttribute('position');
    for (let k = 0; k < heights.length; k++) pos.setY(k, (heights[k] - this.base) * exag);
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();

    const depth = Math.max(8, Math.max(area.xMax - area.xMin, area.zMax - area.zMin) * 0.035);
    this.floor = -depth;
    const sp = this.skirt.geometry.getAttribute('position');
    this.perim.forEach((k, p) => {
      sp.setY(p * 2, this.floor);
      sp.setY(p * 2 + 1, pos.getY(k));
    });
    sp.needsUpdate = true;
    this.skirt.geometry.computeVertexNormals();
    this.skirt.geometry.computeBoundingSphere();
    void nx;
    void nz;
  }

  /** ワールド座標 (x, z) の地表の高さ */
  heightAt(x, z) {
    const { heights, nx, nz, area } = this.data;
    const fx = ((x - area.xMin) / (area.xMax - area.xMin)) * (nx - 1);
    const fz = ((z - area.zMin) / (area.zMax - area.zMin)) * (nz - 1);
    const i = Math.min(nx - 2, Math.max(0, Math.floor(fx)));
    const j = Math.min(nz - 2, Math.max(0, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));
    const a = heights[j * nx + i];
    const b = heights[j * nx + i + 1];
    const c = heights[(j + 1) * nx + i];
    const d = heights[(j + 1) * nx + i + 1];
    // メッシュの三角形分割（a,c,b / b,c,d）に合わせて補間する
    let h;
    if (u + v <= 1) h = a + (b - a) * u + (c - a) * v;
    else h = d + (c - d) * (1 - u) + (b - d) * (1 - v);
    return (h - this.base) * this.exag;
  }

  setNight(night) {
    this.material.emissiveIntensity = 0.1 * night;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.skirt.geometry.dispose();
    this.material.dispose();
    this.skirt.material.dispose();
    this.texture.dispose();
  }
}
