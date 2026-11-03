export interface AspectCheck {
  imageAspect: number;
  physicalAspect: number;
  /** Relative mismatch, 0 = perfect. */
  mismatch: number;
  ok: boolean;
}

/** Image width ↔ widthMm, image height ↔ heightMm. A mismatch means the image would be stretched. */
export function checkTileAspect(imageWidthPx: number, imageHeightPx: number, widthMm: number, heightMm: number, tolerance = 0.01): AspectCheck {
  const imageAspect = imageWidthPx / imageHeightPx;
  const physicalAspect = widthMm / heightMm;
  const mismatch = Math.abs(imageAspect / physicalAspect - 1);
  return { imageAspect, physicalAspect, mismatch, ok: mismatch <= tolerance };
}
