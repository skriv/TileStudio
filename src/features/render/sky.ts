import * as THREE from 'three';

/** Simple analytic sky (zenith → horizon → ground) as an equirectangular HDR environment, generated locally. */
export function createSkyTexture(): THREE.DataTexture {
  const w = 256;
  const h = 128;
  const data = new Float32Array(w * h * 4);
  const zenith = new THREE.Color(0.32, 0.5, 0.9);
  const horizon = new THREE.Color(1.0, 0.97, 0.92);
  const ground = new THREE.Color(0.36, 0.34, 0.31);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    // DataTexture row 0 is the bottom (v = 0 → elevation −90°).
    const elev = ((y + 0.5) / h - 0.5) * Math.PI;
    if (elev >= 0) c.copy(horizon).lerp(zenith, Math.pow(Math.sin(elev), 0.6));
    else c.copy(horizon).lerp(ground, Math.min(1, -elev * 4));
    const k = elev >= 0 ? 1.6 : 0.6;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = c.r * k;
      data[i + 1] = c.g * k;
      data[i + 2] = c.b * k;
      data[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
