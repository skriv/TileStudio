import * as THREE from 'three';
import { bboxOfRing, ringCentroid, pointInRing, type Vec2 } from '../../core/geometry/polygon';
import { mmToM, wallFrames } from '../../core/geometry/room';
import type { Room } from '../../core/project/types';
import type { CameraPose } from './cameraBus';

/** World bounds (metres) of all confirmed rooms, floor to ceiling. */
export function roomsBounds(project: { rooms: Room[] }): THREE.Box3 {
  const b = new THREE.Box3();
  for (const room of project.rooms) {
    if (!room.confirmed || room.polygonMm.length < 3) continue;
    const bb = bboxOfRing(room.polygonMm);
    b.expandByPoint(new THREE.Vector3(mmToM(bb.minX), 0, mmToM(bb.minY)));
    b.expandByPoint(new THREE.Vector3(mmToM(bb.maxX), mmToM(room.heightMm), mmToM(bb.maxY)));
  }
  return b;
}

export function overviewPose(bounds: THREE.Box3): CameraPose {
  const c = bounds.isEmpty() ? new THREE.Vector3(0, 1.2, 0) : bounds.getCenter(new THREE.Vector3());
  const size = bounds.isEmpty() ? 5 : bounds.getSize(new THREE.Vector3()).length();
  return { position: [c.x + size * 0.55, c.y + size * 0.9, c.z + size * 0.75], target: [c.x, 0.4, c.z], fov: 45 };
}

export function topPose(bounds: THREE.Box3): CameraPose {
  const c = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  const size = bounds.isEmpty() ? 5 : bounds.getSize(new THREE.Vector3()).length();
  // tiny z offset keeps "north" (plan top) at the top of the screen
  return { position: [c.x, size * 2.2 + 3, c.z + 0.001], target: [c.x, 0, c.z], fov: 30 };
}

/** Eye height 1600 mm, standing near the wall opposite the longest wall, looking at it. */
export function eyeLevelPose(room: Room, preferWallId?: string | null): CameraPose | null {
  if (room.polygonMm.length < 3) return null;
  const frames = wallFrames(room);
  if (!frames.length) return null;
  const longest = frames.find((f) => f.wallId === preferWallId) ?? frames.reduce((a, b) => (b.lengthMm > a.lengthMm ? b : a));
  const mid: Vec2 = [(longest.start[0] + longest.end[0]) / 2, (longest.start[1] + longest.end[1]) / 2];
  const bb = bboxOfRing(room.polygonMm);
  const depth = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
  let eye: Vec2 = ringCentroid(room.polygonMm);
  for (let d = depth; d > 200; d *= 0.85) {
    const cand: Vec2 = [mid[0] + longest.inward[0] * d, mid[1] + longest.inward[1] * d];
    if (pointInRing(cand, room.polygonMm)) {
      eye = [mid[0] + longest.inward[0] * (d - 250), mid[1] + longest.inward[1] * (d - 250)];
      break;
    }
  }
  return {
    position: [mmToM(eye[0]), 1.6, mmToM(eye[1])],
    target: [mmToM(mid[0]), 1.1, mmToM(mid[1])],
    fov: 62,
  };
}
