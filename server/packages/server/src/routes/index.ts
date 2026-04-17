import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { registerSessionRoutes } from './sessions.js';
import { analyticsPlugin } from './analytics.js';
import { knowledgePlugin } from './knowledge.js';
import { registerSearchRoutes } from './search.js';
import { registerEventsRoutes } from './events.js';
import { registerWsRoutes } from './ws.js';

const apiTree: FastifyPluginAsync = async (api) => {
  await registerSessionRoutes(api);
  await api.register(analyticsPlugin);
  await api.register(knowledgePlugin);
  await api.register(async (instance) => {
    await registerSearchRoutes(instance);
  });
  await api.register(async (instance) => {
    await registerEventsRoutes(instance);
  });
};

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: '@pipeline/server' }));
  await registerWsRoutes(app);
  await app.register(apiTree, { prefix: '/api' });
}
