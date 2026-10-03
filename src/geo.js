// 緯度経度 ⇔ ローカル座標（メートル）、タイル座標、太陽の位置。
// シーンの座標系: x = 東, y = 上, z = 南（北は -z）。

const R = 6378137;
const DEG = Math.PI / 180;

/** 中心点まわりの正距円筒図法。散歩〜自転車ぐらいの範囲なら誤差は無視できる。 */
export function makeProjection(lat0, lon0) {
  const kx = R * DEG * Math.cos(lat0 * DEG);
  const kz = R * DEG;
  return {
    lat0,
    lon0,
    toX: (lon) => (lon - lon0) * kx,
    toZ: (lat) => -(lat - lat0) * kz,
    toLat: (z) => lat0 - z / kz,
    toLon: (x) => lon0 + x / kx,
  };
}

export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat, z) {
  const r = lat * DEG;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/**
 * 太陽の高度と方位（ラジアン）。方位は北から時計回り。
 * 精度は 1° 未満で、空の色と光の向きを決めるには十分。
 */
export function sunPosition(ms, lat, lon) {
  const d = (ms - 946728000000) / 86400000; // J2000.0 からの日数
  const g = DEG * (357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const L = DEG * (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = DEG * (23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const H = DEG * (gmst * 15 + lon) - ra;
  const phi = lat * DEG;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  // 南から西回りの方位を北基準に直す
  const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { altitude: alt, azimuth: azS + Math.PI };
}

/** 高度・方位 → シーン座標の単位ベクトル */
export function directionFromAltAz(alt, az, out) {
  const c = Math.cos(alt);
  out.set(Math.sin(az) * c, Math.sin(alt), -Math.cos(az) * c);
  return out;
}
