import { useEffect, useState } from 'react';
import * as THREE from 'three';
import type { Project } from '../../core/project/types';

const cache = new Map<string, Promise<THREE.Texture>>();

/** Loads the original tile image as-is. UVs are always within one tile (0..1), so no repeat/stretch is applied. */
export function loadTileTexture(url: string): Promise<THREE.Texture> {
  let p = cache.get(url);
  if (!p) {
    p = new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = 16;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      return t;
    });
    cache.set(url, p);
  }
  return p;
}

/** Map assetId → texture for all materials of the project. */
export function useMaterialTextures(project: Project, assetUrls: Record<string, string>): Map<string, THREE.Texture> {
  const [textures, setTextures] = useState(() => new Map<string, THREE.Texture>());
  const key = project.materials.map((m) => `${m.assetId}:${assetUrls[m.assetId] ?? ''}`).join('|');
  useEffect(() => {
    let alive = true;
    const entries = project.materials
      .filter((m) => assetUrls[m.assetId])
      .map(async (m) => [m.assetId, await loadTileTexture(assetUrls[m.assetId])] as const);
    Promise.allSettled(entries).then((res) => {
      if (!alive) return;
      const map = new Map<string, THREE.Texture>();
      res.forEach((r) => r.status === 'fulfilled' && map.set(r.value[0], r.value[1]));
      setTextures(map);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return textures;
}
