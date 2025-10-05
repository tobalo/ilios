import { Context, Next } from 'hono';

const PUBLIC_PATHS = ['/health', '/docs', '/openapi.json', '/'];
const PUBLIC_PATH_PREFIXES = ['/images/', '/benchmarks/'];

function parseApiKeys(apiKeyEnv: string | undefined): string[] {
  if (!apiKeyEnv) return [];
  return apiKeyEnv.split(',').map(key => key.trim()).filter(Boolean);
}

export async function authMiddleware(c: Context, next: Next) {
  const env = c.env as any;
  const validApiKeys = parseApiKeys(env.API_KEY);
  
  if (validApiKeys.length === 0) {
    await next();
    return;
  }

  const path = c.req.path;
  if (PUBLIC_PATHS.includes(path) || PUBLIC_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.substring(7);
  
  if (!validApiKeys.includes(token)) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  c.set('apiKey', token);
  
  await next();
}