import type { VercelRequest, VercelResponse } from '@vercel/node';
import { healthCheck } from '../lib/db';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dbHealthy = await healthCheck();

  const status = {
    status: dbHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy ? 'connected' : 'disconnected',
    },
  };

  const statusCode = dbHealthy ? 200 : 503;
  return res.status(statusCode).json(status);
}
