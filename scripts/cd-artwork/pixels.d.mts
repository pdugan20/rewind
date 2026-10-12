export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}
export const VERSION: string;
export const GEOMETRY: {
  canvas: number;
  center: number;
  outerRadius: number;
  holeRadius: number;
};
export function readPixels(bytes: Uint8Array): Pixels;
export function png(p: Pixels): Uint8Array;
export function checkGeometry(p: Pixels): {
  pass: boolean;
  reason?: string;
  [key: string]: unknown;
};
export function repairHub(
  master: Pixels,
  patch: Pixels,
  region: { inner: number; outer: number }
): {
  image: Pixels;
  verification: {
    protectedChanges: number;
    partialHubPixels: number;
    region: { inner: number; outer: number };
  };
};
export function applyTemplateHub(
  master: Pixels,
  template: Pixels
): {
  image: Pixels;
  verification: {
    protectedChanges: number;
    partialHubPixels: number;
    region: { inner: number; outer: number };
    layout: string;
  };
};
