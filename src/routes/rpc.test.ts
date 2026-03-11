import { describe, it, expect } from 'vitest';
import { hc } from 'hono/client';
import type { AppType } from '../index.js';

describe('Hono RPC type export', () => {
  it('creates a typed client from AppType', () => {
    // This test verifies that AppType is properly exported and works with hc.
    // The hc<AppType> call will fail at compile time if AppType is not a valid
    // Hono app type.
    const client = hc<AppType>('http://localhost');
    expect(client).toBeTruthy();
  });

  it('AppType is exported and usable', () => {
    // Verify the type exists and can be used with hc
    // This is primarily a compile-time check
    type ClientType = ReturnType<typeof hc<AppType>>;
    const isType: boolean = true as unknown as ClientType extends object
      ? true
      : false;
    expect(isType).toBe(true);
  });
});
