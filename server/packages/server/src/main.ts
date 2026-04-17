import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_SHARED_PLACEHOLDER } from '@pipeline/shared';
import { registerRoutes } from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['PIPELINE_SERVER_PORT'] || '18000', 10);
const WEB_PORT = parseInt(process.env['PIPELINE_WEB_PORT'] || '18001', 10);
const isProd = process.env['NODE_ENV'] === 'production';

/** 仓库根目录：packages/server/src -> ../../.. */
function repoRoot(): string {
  return join(__dirname, '..', '..', '..');
}

function webDistDir(): string {
  return join(repoRoot(), 'web', 'dist');
}

async function buildServer() {
  const app = Fastify({
    logger: { level: 'info' },
  });

  const corsOrigins = process.env['PIPELINE_CORS_ORIGINS']
    ? process.env['PIPELINE_CORS_ORIGINS'].split(',').map((s) => s.trim())
    : [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`];

  await app.register(cors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await registerRoutes(app);

  if (isProd) {
    const root = webDistDir();
    if (!existsSync(root)) {
      app.log.warn({ root }, '生产模式未找到 web/dist，跳过静态托管');
    } else {
      await app.register(fastifyStatic, { root, prefix: '/' });
      app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
        const url = request.url.split('?')[0] ?? '';
        if (url.startsWith('/api')) {
          return reply.code(404).send({ error: 'not_found' });
        }
        const indexHtml = join(root, 'index.html');
        return reply.type('text/html').send(readFileSync(indexHtml, 'utf8'));
      });
    }
  }

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  app.log.info(
    { 共享包: PIPELINE_SHARED_PLACEHOLDER, 端口: PORT, 生产静态: isProd },
    '管理台后端启动中',
  );

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info({ 地址: `http://127.0.0.1:${PORT}` }, '服务已监听，等待请求');

  const shutdown = async (signal: string) => {
    app.log.info({ 信号: signal }, '收到退出信号，正在优雅关闭…');
    try {
      await app.close();
      app.log.info('服务已安全退出');
    } catch (err) {
      app.log.error({ err }, '关闭服务时出错');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exitCode = 1;
});
