import { cors as honoCors } from 'hono/cors';
import type { Env } from '../types/env.js';

export function cors(env: Env) {
  const origins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['patdugan.me', 'localhost:3000'];

  return honoCors({
    origin: (origin) => {
      if (!origin) return '*';
      const hostname = new URL(origin).hostname;
      return origins.some((o) => hostname === o || hostname.endsWith(`.${o}`))
        ? origin
        : '';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  });
}
