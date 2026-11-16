import { createDiscoveryCooldown } from './services/discovery-cooldown.js';
import express from 'express';
import { reportMcpRouter } from './routes/report-mcp.js';
import { managerAuthRouter } from './routes/manager.js';
import { userUsageRouter } from './routes/user-usage.js';
import { adminRouter } from './routes/admin.js';
import { proxyHandler } from './routes/proxy.js';
import { errorHandler } from './errors.js';
export function createApp(db, config, dependencies) {
  dependencies = { discoveryCooldown: createDiscoveryCooldown(dependencies?.log), ...dependencies };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res) => { await db.query('SELECT 1'); res.json({ status: 'ready' }); });
  app.use('/user', userUsageRouter(db));
  app.use('/manager', managerAuthRouter(db), adminRouter(db, config, dependencies, { manager: true }));
  app.use('/report', reportMcpRouter(db, config));
  app.use('/admin', adminRouter(db, config, dependencies));
  app.use('/v1', proxyHandler(db, config, dependencies));
  app.use((req, res) => res.status(404).json({ error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found', param: null } }));
  app.use(errorHandler);
  return app;
}
