// Attendance days are bucketed in company local time (IST) so "today" is stable.
const TZ_OFFSET_MIN = 330;
export function dateKey(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
