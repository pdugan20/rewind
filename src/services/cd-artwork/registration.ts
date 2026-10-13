import {
  readPixels,
  png,
  checkGeometry,
  repairHub,
  applyTemplateHub,
} from '../../../scripts/cd-artwork/pixels.mjs';
import template from './assets/cover-template.png';
import type { JobInput } from './types.js';

import {
  inspectRegistration,
  RegistrationError,
  bilinear,
} from './geometry-inspection.js';
export {
  inspectRegistration,
  RegistrationError,
} from './geometry-inspection.js';

export function register(raw: Uint8Array) {
  const inspection = inspectRegistration(raw);
  if (!inspection.pass) throw new RegistrationError(inspection);
  const { inner, outer, scale, centerError, holeRadiusError, printedHub } =
    inspection;
  const p = readPixels(raw);
  const premultiplied = { ...p, data: new Uint8Array(p.data) };
  for (let i = 0; i < p.data.length; i += 4)
    for (let c = 0; c < 3; c++)
      premultiplied.data[i + c] = Math.round(
        (p.data[i + c] * p.data[i + 3]) / 255
      );
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const dx = x + 0.5 - 512,
        dy = y + 0.5 - 512,
        r = Math.hypot(dx, dy),
        i = (y * 1024 + x) * 4;
      if (r < 59 || r > 481) continue;
      const sx = outer.x + dx / scale,
        sy = outer.y + dy / scale;
      const sourceAlpha = bilinear(p, sx, sy, 3);
      if (!sourceAlpha) continue;
      for (let c = 0; c < 3; c++)
        data[i + c] = Math.round(
          (bilinear(premultiplied, sx, sy, c) * 255) / sourceAlpha
        );
      let coverage = 0;
      for (let py = 0; py < 4; py++)
        for (let px = 0; px < 4; px++) {
          const sub = Math.hypot(
            x + (px + 0.5) / 4 - 512,
            y + (py + 0.5) / 4 - 512
          );
          if (sub >= 60 && sub <= 480) coverage++;
        }
      data[i + 3] = Math.round((coverage * sourceAlpha) / 16);
    }
  const image = { width: 1024, height: 1024, data };
  if (!checkGeometry(image).pass) throw Error('registration_geometry_failed');
  return {
    image,
    verification: {
      method: 'whole-face uniform scale and translation; bilinear sampling',
      inner,
      outer,
      centerError,
      holeRadiusError,
      printedHub,
      sourcePixelsUnchanged: false,
      inspection,
    },
  };
}
export function prepareCandidate(raw: Uint8Array, input: JobInput) {
  const registered = register(raw);
  let result;
  if (input.source_kind === 'cover')
    result = applyTemplateHub(
      registered.image,
      readPixels(new Uint8Array(template))
    );
  else {
    if (!input.material) throw Error('material_review_required');
    const { inner, outer, opacity } = input.material;
    if (opacity === 1) {
      return {
        bytes: png(registered.image),
        verification: {
          registration: registered.verification,
          material: {
            mode: 'preserved-opaque',
            protectedChanges: 0,
            partialHubPixels: 0,
            region: { inner, outer },
          },
          geometry: checkGeometry(registered.image),
        },
      };
    }
    const patch = {
      ...registered.image,
      data: new Uint8Array(registered.image.data),
    };
    for (let i = 3; i < patch.data.length; i += 4)
      patch.data[i] = Math.round(patch.data[i] * opacity);
    result = repairHub(registered.image, patch, { inner, outer });
  }
  return {
    bytes: png(result.image),
    verification: {
      registration: registered.verification,
      material: result.verification,
      geometry: checkGeometry(result.image),
    },
  };
}
export const validateCandidate = (bytes: Uint8Array) => {
  if (
    bytes.length < 24 ||
    bytes[0] !== 137 ||
    bytes[1] !== 80 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      16
    ) !== 1024 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      20
    ) !== 1024
  )
    return { pass: false };
  return checkGeometry(readPixels(bytes));
};
