import type { Context } from 'hono';

export function notFound(c: Context, message = 'Not found') {
  return c.json({ error: message, status: 404 }, 404);
}

export function badRequest(c: Context, message = 'Bad request') {
  return c.json({ error: message, status: 400 }, 400);
}

export function unauthorized(c: Context, message = 'Unauthorized') {
  return c.json({ error: message, status: 401 }, 401);
}

export function forbidden(c: Context, message = 'Forbidden') {
  return c.json({ error: message, status: 403 }, 403);
}

export function serverError(c: Context, message = 'Internal server error') {
  return c.json({ error: message, status: 500 }, 500);
}
