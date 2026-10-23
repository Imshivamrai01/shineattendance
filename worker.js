// Cloudflare entry: OpenNext handles HTTP; cron triggers call the existing /api/cron routes.
import handler from './.open-next/worker.js';

const CRON_PATHS = {
  // phones that stopped reporting location (only acts during office hours) + keep the AI call list moving
  // + the morning "no attendance yet" WhatsApp (once a day, when switched on)
  '*/5 * * * *': ['/api/cron/silent-check', '/api/cron/ai-dialer', '/api/cron/wa-absent'],
  '*/15 12-15 * * *': '/api/cron/end-of-day', // 17:30-21:15 IST: auto check-out once office hours are over
  '30 14 * * *': '/api/cron/daily-report', // 20:00 IST: finalize tasks + report email
};

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    for (const path of [].concat(CRON_PATHS[event.cron] || [])) {
      const req = new Request(new URL(path, env.APP_URL), {
        headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      });
      const res = await handler.fetch(req, env, ctx);
      console.log(`cron ${event.cron} ${path} -> ${res.status} ${await res.text()}`);
    }
  },
};

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
