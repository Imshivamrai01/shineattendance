import { getSettings } from '@/lib/db';
import { handler, bad, HttpError } from '@/lib/http';
import { pingScript, sheetsConfigured } from '@/lib/sheets';

// "Test connection": calls the deployed Apps Script; it also creates the tab when missing.
export const POST = handler(async () => {
  const s = await getSettings();
  if (!sheetsConfigured(s)) throw bad('Generate the script and save its Web app URL first');
  try {
    const r = await pingScript(s);
    return { ok: true, title: r.title, tab: r.tab };
  } catch (e) { throw new HttpError(502, e.message); }
}, { roles: ['ADMIN'] });
