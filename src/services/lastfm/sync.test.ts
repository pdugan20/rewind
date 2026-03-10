import { describe, it, expect } from 'vitest';
import { syncListening } from './sync.js';

describe('syncListening', () => {
  it('exports syncListening function', () => {
    expect(typeof syncListening).toBe('function');
  });
});
