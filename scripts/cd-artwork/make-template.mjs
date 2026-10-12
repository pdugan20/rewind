import fs from 'node:fs/promises';
import { loadPixels, makeTemplate, png, checkGeometry } from './pixels.mjs';
import { hash } from './registry.mjs';
const [rimPath, hubPath, outputPath] = process.argv.slice(2);
if (!outputPath)
  throw Error(
    'Usage: make-template.mjs <registered-rim.png> <clear-hub.png> <template.png>'
  );
const image = makeTemplate(
  await loadPixels(rimPath),
  await loadPixels(hubPath)
);
const geometry = checkGeometry(image);
if (!geometry.pass) throw Error(JSON.stringify(geometry));
const bytes = png(image);
await fs.writeFile(outputPath, bytes);
await fs.writeFile(
  outputPath + '.json',
  JSON.stringify(
    {
      version: 'cover-print-22mm-v1',
      outerDiameterMm: 120,
      holeDiameterMm: 15,
      printInnerDiameterMm: 22,
      printOuterDiameterMm: 117.5,
      geometry,
      rimSourceHash: hash(await fs.readFile(rimPath)),
      hubSourceHash: hash(await fs.readFile(hubPath)),
      outputHash: hash(bytes),
      method:
        'Existing photographic rim and repaired clear hub; neutral opaque print base; no new generation',
      review:
        'candidate; clear-plastic appearance and cover placement require visual review',
    },
    null,
    2
  ) + '\n'
);
console.log(outputPath);
