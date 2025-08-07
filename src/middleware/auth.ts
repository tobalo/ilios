import { Context, Next } from 'hono';

export async function authMiddleware(c: Context, next: Next) {
  const env = c.env as any;
  
  if (!env.API_KEY) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.substring(7);
  
  if (token !== env.API_KEY) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  c.set('apiKey', token);
  
  await next();
}