import mongoose from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns';
import { after } from 'next/server.js'; // .js: also resolvable from plain-Node scripts (seed-admin)
import '../models/User.js';
import '../models/Department.js';
import '../models/Location.js';
import '../models/Attendance.js';
import '../models/ChangeRequest.js';
import '../models/AuditLog.js';
import '../models/ProfileVersion.js';
import '../models/Session.js';
import '../models/Setting.js';
import '../models/Counter.js';
import '../models/Task.js';

const g = globalThis;
g.__mongo ||= { conn: null, promise: null };

/*
 * Cloudflare Workers can't reuse a socket opened by another request, so there each request
 * (plus its after() tasks) gets its own connection, tracked with AsyncLocalStorage.
 * Everywhere else (next dev, next start, scripts) the single cached global connection is used.
 */
const onWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
const scope = (g.__mongoScope ||= new AsyncLocalStorage());

// mongodb+srv needs SRV/TXT lookups on every connect; resolve once per isolate into a plain URI.
async function resolvedUri(uri) {
  if (!uri.startsWith('mongodb+srv://')) return uri;
  if (g.__mongoUri?.src === uri) return g.__mongoUri.out;
  const u = new URL(uri.replace('mongodb+srv://', 'http://'));
  const [srv, txt] = await Promise.all([
    dns.promises.resolveSrv(`_mongodb._tcp.${u.hostname}`),
    dns.promises.resolveTxt(u.hostname).catch(() => []),
  ]);
  const params = new URLSearchParams(txt.map((r) => r.join('')).join('&'));
  for (const [k, v] of u.searchParams) params.set(k, v);
  if (!params.has('tls') && !params.has('ssl')) params.set('tls', 'true');
  const auth = u.username ? `${u.username}:${u.password}@` : '';
  const hosts = srv.map((r) => `${r.name}:${r.port}`).join(',');
  const out = `mongodb://${auth}${hosts}${u.pathname}?${params}`;
  g.__mongoUri = { src: uri, out };
  return out;
}

async function requestConnection(store) {
  store.conn ||= (async () => {
    const conn = mongoose.createConnection(await resolvedUri(process.env.MONGODB_URI), {
      serverSelectionTimeoutMS: 8000, maxPoolSize: 2, minPoolSize: 0, serverMonitoringMode: 'poll',
    });
    // createConnection registers itself globally; drop it so finished requests don't pile up.
    mongoose.connections.splice(mongoose.connections.indexOf(conn), 1);
    for (const name of mongoose.modelNames()) conn.model(name, mongoose.model(name).schema);
    await conn.asPromise();
    store.ready = conn;
    return conn;
  })();
  return store.conn;
}

/** Runs one API request with its own DB scope on Workers; closes the connection when all work is done. */
export async function withDb(fn) {
  if (!onWorkers) return fn();
  const store = { conn: null, ready: null, later: [] };
  return scope.run(store, async () => {
    const finish = async () => {
      await Promise.allSettled(store.later.map((t) => t()));
      await store.ready?.close().catch(() => {});
    };
    try {
      return await fn();
    } finally {
      if (store.later.length) after(finish); else await finish();
    }
  });
}

/** Run a best-effort task after the response is sent (emails, Sheets sync). */
export function defer(task) {
  const store = scope.getStore();
  if (store) { store.later.push(task); return; }
  try { after(task); } catch { task(); }
}

export async function connect() {
  const store = scope.getStore();
  if (store) return requestConnection(store);
  if (g.__mongo.conn) return g.__mongo.conn;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured');
  g.__mongo.promise ||= mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    g.__mongo.conn = await g.__mongo.promise;
  } catch (e) {
    g.__mongo.promise = null;
    throw e;
  }
  return g.__mongo.conn;
}

/** The model bound to the current request's connection (Workers) or the global one. */
export function model(name) {
  const conn = scope.getStore()?.ready;
  return conn ? conn.models[name] : mongoose.models[name];
}

export const M = {
  get User() { return model('User'); },
  get Department() { return model('Department'); },
  get Location() { return model('Location'); },
  get Attendance() { return model('Attendance'); },
  get ChangeRequest() { return model('ChangeRequest'); },
  get AuditLog() { return model('AuditLog'); },
  get ProfileVersion() { return model('ProfileVersion'); },
  get Session() { return model('Session'); },
  get Setting() { return model('Setting'); },
  get Counter() { return model('Counter'); },
  get Task() { return model('Task'); },
};

export async function getSettings() {
  return (await M.Setting.findOneAndUpdate({ key: 'system' }, { $setOnInsert: { key: 'system' } },
    { upsert: true, new: true })).toObject();
}
