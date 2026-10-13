export interface Ellipse {
  x: number;
  y: number;
  a: number;
  b: number;
  angle: number;
  p90: number;
}

/** Fit a conic in normalized coordinates, then report radial residuals in pixels.
 * This describes scan perspective; it does not require a scan to be circular.
 */
export function fitEllipse(points: Array<[number, number]>): Ellipse {
  const fit = (input: Array<[number, number]>) => {
    if (input.length < 32) throw Error('ellipse_insufficient');
    const matrix = Array.from({ length: 5 }, () =>
      new Array<number>(6).fill(0)
    );
    for (const [px, py] of input) {
      const x = (px - 512) / 480,
        y = (py - 512) / 480;
      const row = [x * x, x * y, y * y, x, y];
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) matrix[i][j] += row[i] * row[j];
        matrix[i][5] += row[i];
      }
    }
    for (let c = 0; c < 5; c++) {
      let pivot = c;
      for (let r = c + 1; r < 5; r++)
        if (Math.abs(matrix[r][c]) > Math.abs(matrix[pivot][c])) pivot = r;
      [matrix[c], matrix[pivot]] = [matrix[pivot], matrix[c]];
      const d = matrix[c][c];
      if (Math.abs(d) < 1e-12) throw Error('ellipse_singular');
      for (let k = c; k < 6; k++) matrix[c][k] /= d;
      for (let r = 0; r < 5; r++)
        if (r !== c) {
          const m = matrix[r][c];
          for (let k = c; k < 6; k++) matrix[r][k] -= m * matrix[c][k];
        }
    }
    const [A, B, C, D, E] = matrix.map((row) => row[5]);
    const determinant = 4 * A * C - B * B;
    if (!(A > 0 && C > 0 && determinant > 0)) throw Error('ellipse_invalid');
    const cx = (B * E - 2 * C * D) / determinant;
    const cy = (B * D - 2 * A * E) / determinant;
    const k = 1 - (A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy);
    const gap = Math.hypot(A - C, B);
    const a = 480 * Math.sqrt(k / ((A + C + gap) / 2));
    const b = 480 * Math.sqrt(k / ((A + C - gap) / 2));
    if (![a, b, cx, cy].every(Number.isFinite) || a <= 0 || b <= 0)
      throw Error('ellipse_invalid');
    return {
      x: 512 + cx * 480,
      y: 512 + cy * 480,
      a,
      b,
      angle: Math.atan2(B, A - C) / 2,
    };
  };
  const residual = (e: Omit<Ellipse, 'p90'>, [x, y]: [number, number]) => {
    const dx = x - e.x,
      dy = y - e.y;
    const u = dx * Math.cos(e.angle) + dy * Math.sin(e.angle);
    const v = -dx * Math.sin(e.angle) + dy * Math.cos(e.angle);
    const t = Math.hypot(u / e.a, v / e.b);
    return t ? Math.abs(Math.hypot(u, v) * (1 - 1 / t)) : Infinity;
  };
  let fitted = fit(points);
  for (let i = 0; i < 2; i++) {
    const kept = points.filter((p) => residual(fitted, p) < 8);
    if (kept.length < points.length * 0.8) break;
    fitted = fit(kept);
  }
  const errors = points.map((p) => residual(fitted, p)).sort((a, b) => a - b);
  return { ...fitted, p90: errors[Math.floor(errors.length * 0.9)] };
}
