import type * as THREE from 'three';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

/** Last pose of the preview camera, shared with Photo Render so both use the identical view. */
let pose: CameraPose | null = null;
let applyFn: ((p: CameraPose) => void) | null = null;
let liveRefs: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera } | null = null;

export const cameraBus = {
  get: () => pose,
  set: (p: CameraPose) => {
    pose = p;
  },
  apply: (p: CameraPose) => {
    pose = p;
    applyFn?.(p);
  },
  registerApply: (fn: ((p: CameraPose) => void) | null) => {
    applyFn = fn;
  },
  setLive: (r: typeof liveRefs) => {
    liveRefs = r;
  },
  live: () => liveRefs,
};
