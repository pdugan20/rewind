import { describe, it, expect } from 'vitest';

describe('listening routes', () => {
  it('module can be imported', async () => {
    const mod = await import('./listening.js');
    expect(mod.default).toBeDefined();
  });
});
