import { handler, readJson } from '@/lib/http';
import { answerPresence } from '@/lib/attendance';

// The signed-in person's answer to "Still in office?": { answer: 'IN_OFFICE' | 'LEFT', lat, lng, accuracy }
export const POST = handler(async (ctx) => answerPresence(ctx, await readJson(ctx.req)));
