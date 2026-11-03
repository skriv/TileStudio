import * as THREE from 'three';

export type ImageFormat = 'png' | 'jpeg';

export function maxRenderSize(gl: THREE.WebGLRenderer): number {
  const ctx = gl.getContext();
  const dims = ctx.getParameter(ctx.MAX_VIEWPORT_DIMS) as Int32Array;
  return Math.min(gl.capabilities.maxTextureSize, dims[0], dims[1]);
}

/**
 * Renders the actual scene with the given renderer at an exact output size and returns the canvas bytes.
 * The view is the same camera (aspect adapted); nothing is painted over or generated.
 */
export function renderToBlob(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  format: ImageFormat,
): Promise<Blob> {
  const max = maxRenderSize(gl);
  if (width > max || height > max) return Promise.reject(new Error(`GPU ограничивает размер кадра ${max}px.`));
  const prevSize = gl.getSize(new THREE.Vector2());
  const prevRatio = gl.getPixelRatio();
  const cam = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  const prevAspect = 'aspect' in cam ? cam.aspect : 0;
  try {
    gl.setPixelRatio(1);
    gl.setSize(width, height, false);
    if (cam instanceof THREE.PerspectiveCamera) {
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
    }
    gl.render(scene, cam);
    const canvas = gl.domElement;
    return new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось получить изображение.'))), format === 'png' ? 'image/png' : 'image/jpeg', 0.95),
    );
  } finally {
    gl.setPixelRatio(prevRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (cam instanceof THREE.PerspectiveCamera) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
  }
}
