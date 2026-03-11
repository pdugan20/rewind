/**
 * Color extraction using simplified k-means clustering on pixel data.
 * Works in Cloudflare Workers without native dependencies.
 */

export interface ColorResult {
  dominantColor: string;
  accentColor: string;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Extract dominant and accent colors from raw RGBA pixel data.
 * Uses a simplified k-means approach with 5 clusters.
 */
export function extractColors(
  pixels: Uint8Array,
  width: number,
  height: number
): ColorResult {
  // Sample pixels (every 4th pixel for performance)
  const samples: RGB[] = [];
  const step = Math.max(1, Math.floor((width * height) / 1000));

  for (let i = 0; i < width * height; i += step) {
    const offset = i * 4;
    const a = pixels[offset + 3];
    // Skip fully transparent pixels
    if (a < 128) continue;

    samples.push({
      r: pixels[offset],
      g: pixels[offset + 1],
      b: pixels[offset + 2],
    });
  }

  if (samples.length === 0) {
    return { dominantColor: '#000000', accentColor: '#666666' };
  }

  // Run k-means with k=5
  const clusters = kMeans(samples, 5, 10);

  // Sort clusters by size (number of pixels assigned)
  clusters.sort((a, b) => b.count - a.count);

  // Dominant = largest cluster
  const dominant = clusters[0];

  // Accent = first cluster that is visually distinct from dominant
  let accent = clusters.length > 1 ? clusters[1] : clusters[0];
  for (let i = 1; i < clusters.length; i++) {
    const dist = colorDistance(dominant.center, clusters[i].center);
    if (dist > 50) {
      accent = clusters[i];
      break;
    }
  }

  return {
    dominantColor: rgbToHex(dominant.center),
    accentColor: rgbToHex(accent.center),
  };
}

interface Cluster {
  center: RGB;
  count: number;
}

function kMeans(samples: RGB[], k: number, maxIterations: number): Cluster[] {
  // Initialize centroids by picking evenly-spaced samples
  const centroids: RGB[] = [];
  const step = Math.max(1, Math.floor(samples.length / k));
  for (let i = 0; i < k && i * step < samples.length; i++) {
    centroids.push({ ...samples[i * step] });
  }

  // Pad if we don't have enough centroids
  while (centroids.length < k) {
    centroids.push({ ...samples[0] });
  }

  let assignments = new Array<number>(samples.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each sample to the nearest centroid
    const newAssignments = samples.map((sample) => {
      let minDist = Infinity;
      let minIdx = 0;
      for (let j = 0; j < centroids.length; j++) {
        const dist = colorDistance(sample, centroids[j]);
        if (dist < minDist) {
          minDist = dist;
          minIdx = j;
        }
      }
      return minIdx;
    });

    // Check convergence
    let changed = false;
    for (let i = 0; i < newAssignments.length; i++) {
      if (newAssignments[i] !== assignments[i]) {
        changed = true;
        break;
      }
    }
    assignments = newAssignments;

    if (!changed) break;

    // Update centroids
    const sums: Array<{ r: number; g: number; b: number; count: number }> =
      centroids.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));

    for (let i = 0; i < samples.length; i++) {
      const cluster = assignments[i];
      sums[cluster].r += samples[i].r;
      sums[cluster].g += samples[i].g;
      sums[cluster].b += samples[i].b;
      sums[cluster].count++;
    }

    for (let j = 0; j < centroids.length; j++) {
      if (sums[j].count > 0) {
        centroids[j] = {
          r: Math.round(sums[j].r / sums[j].count),
          g: Math.round(sums[j].g / sums[j].count),
          b: Math.round(sums[j].b / sums[j].count),
        };
      }
    }
  }

  // Build final clusters with counts
  const clusterCounts = new Array<number>(k).fill(0);
  for (const a of assignments) {
    clusterCounts[a]++;
  }

  return centroids.map((center, i) => ({
    center,
    count: clusterCounts[i],
  }));
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function rgbToHex(color: RGB): string {
  const r = Math.max(0, Math.min(255, color.r)).toString(16).padStart(2, '0');
  const g = Math.max(0, Math.min(255, color.g)).toString(16).padStart(2, '0');
  const b = Math.max(0, Math.min(255, color.b)).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}
