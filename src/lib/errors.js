export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (m, extra) => new HttpError(400, m, extra);
export const forbidden = (m = 'You do not have permission to do this') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
