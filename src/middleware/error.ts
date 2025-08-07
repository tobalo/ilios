import { Context, Next } from 'hono';

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    console.error('Request error:', error);
    
    if (error instanceof Error) {
      return c.json({
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString(),
      }, 500);
    }
    
    return c.json({
      error: 'Internal server error',
      message: 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
    }, 500);
  }
}