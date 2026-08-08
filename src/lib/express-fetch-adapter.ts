/**
 * express-fetch-adapter.ts
 *
 * Bridges a Fetch API Request/Response (CF Workers) to Express's Node.js-style
 * (req: IncomingMessage, res: ServerResponse) interface.
 *
 * Express calls Object.setPrototypeOf(res, this.response) which replaces the
 * prototype of whatever object we pass in.  Therefore ALL methods that we want
 * to keep must be defined as OWN PROPERTIES (direct assignments), not as
 * prototype methods (via class), so they survive the prototype swap.
 */

import { Readable } from "node:stream";

// ── Fake IncomingMessage ───────────────────────────────────────────────────────

function createFakeReq(
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body: Buffer,
): any {
  // Use a Readable stream as the base so body-parser can read from it.
  // instance properties on Readable (_readableState, etc.) survive setPrototypeOf.
  //
  // IMPORTANT: pre-push body data immediately (before listeners are added) so the
  // data sits in the Readable's internal buffer.  When body-parser later adds a
  // 'data' listener, the buffered chunks are flushed in the next tick.
  //
  // DO NOT use a lazy _read() here — miniflare's workerd schedules _read() calls
  // differently from plain Node.js, causing body-parser to see an empty stream and
  // skip JSON parsing (leaving req.body = undefined).
  const readable = new Readable({ read() {} }); // no-op _read — data is pre-buffered
  if (body.length > 0) readable.push(body);
  readable.push(null); // signal end-of-stream immediately

  // Add all http.IncomingMessage-like properties as OWN properties.
  Object.assign(readable, {
    method,
    url: urlPath,
    headers,
    rawHeaders: Object.entries(headers).flatMap(([k, v]) => [k, v]),
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    httpVersion: "1.1",
    socket: {
      remoteAddress: "127.0.0.1",
      remotePort: 0,
      encrypted: false,
      destroy() {},
    },
    aborted: false,
    complete: body.length === 0,
    trailers: {},
    rawTrailers: [],
    setTimeout: () => readable,
    destroy: () => readable,
  });

  (readable as any).connection = (readable as any).socket;
  return readable;
}

// ── Fake ServerResponse ────────────────────────────────────────────────────────

function createFakeRes(resolve: (r: Response) => void): any {
  let statusCode = 200;
  const _headers: Record<string, string | string[]> = {};
  const chunks: Buffer[] = [];
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  let resolved = false;

  // --- EventEmitter shim (own-property functions survive setPrototypeOf) ---
  const on = (event: string, fn: (...args: any[]) => void): any => {
    (listeners[event] ??= []).push(fn);
    return res;
  };
  const once = (event: string, fn: (...args: any[]) => void): any => {
    const wrapper = (...args: any[]) => { fn(...args); off(event, wrapper); };
    return on(event, wrapper);
  };
  const off = (event: string, fn: (...args: any[]) => void): any => {
    if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn);
    return res;
  };
  const emit = (event: string, ...args: any[]): boolean => {
    const fns = listeners[event] ?? [];
    for (const fn of fns) fn(...args);
    return fns.length > 0;
  };

  // --- Core response capture ---
  const end = (chunk?: string | Buffer | null, _enc?: any, callback?: () => void): any => {
    if (resolved) return res;
    resolved = true;
    if (chunk != null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    res.writableEnded = true;
    res.writableFinished = true;
    res.finished = true;
    emit("finish");
    const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : null;
    const responseHeaders = new Headers();
    for (const [key, val] of Object.entries(_headers)) {
      if (Array.isArray(val)) {
        for (const v of val) responseHeaders.append(key, v);
      } else {
        responseHeaders.set(key, val);
      }
    }
    callback?.();
    resolve(new Response(bodyBuf, { status: statusCode, headers: responseHeaders }));
    return res;
  };

  // Use Object.defineProperty so that statusCode getter/setter is an OWN
  // accessor property that survives Object.setPrototypeOf.
  const res: any = {};
  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (code: number) => { statusCode = code; },
    enumerable: true,
    configurable: true,
  });

  // All remaining properties as plain own data properties.
  Object.assign(res, {
    statusMessage: "OK",
    headersSent: false,
    writable: true,
    writableEnded: false,
    writableFinished: false,
    finished: false,
    closed: false,
    destroyed: false,
    locals: {},

    // Header management
    setHeader(name: string, value: string | string[] | number): any {
      _headers[name.toLowerCase()] = typeof value === "number" ? String(value) : value;
      return res;
    },
    getHeader(name: string): string | string[] | undefined {
      return _headers[name.toLowerCase()];
    },
    getHeaders(): Record<string, string | string[]> {
      return { ..._headers };
    },
    hasHeader(name: string): boolean {
      return name.toLowerCase() in _headers;
    },
    removeHeader(name: string): void {
      delete _headers[name.toLowerCase()];
    },
    appendHeader(name: string, value: string | string[]): any {
      const existing = _headers[name.toLowerCase()];
      if (existing == null) {
        _headers[name.toLowerCase()] = value;
      } else {
        const arr = Array.isArray(existing) ? existing : [existing];
        const vals = Array.isArray(value) ? value : [value];
        _headers[name.toLowerCase()] = [...arr, ...vals];
      }
      return res;
    },
    writeHead(code: number, reasonOrHeaders?: string | Record<string, any>, hdrs?: Record<string, any>): any {
      statusCode = code;
      const headerMap = typeof reasonOrHeaders === "object" ? (reasonOrHeaders ?? {}) : (hdrs ?? {});
      for (const [k, v] of Object.entries(headerMap)) {
        _headers[k.toLowerCase()] = v as string | string[];
      }
      return res;
    },
    flushHeaders(): void {},

    // Body write/end
    write(chunk: string | Buffer, _enc?: any, callback?: () => void): boolean {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback?.();
      return true;
    },
    end,

    // EventEmitter (own-property assignments survive setPrototypeOf)
    on,
    once,
    off,
    addListener: on,
    removeListener: off,
    removeAllListeners(event?: string): any {
      if (event) delete listeners[event];
      else for (const k in listeners) delete listeners[k];
      return res;
    },
    emit,
    listenerCount(event: string): number { return (listeners[event] ?? []).length; },
    eventNames(): string[] { return Object.keys(listeners); },

    // Misc stream/socket compat
    pipe<T>(dest: T): T { return dest; },
    destroy(): any { return res; },
    socket: null,
  });

  return res;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Adapts an Express application (Node.js-style handler) to the Fetch API used
 * by Cloudflare Workers.  Creates fake IncomingMessage / ServerResponse objects,
 * runs the Express app, and collects the response.
 *
 * @param waitUntil  Optional CF ExecutionContext.waitUntil — when provided it is
 *                   attached to fakeReq as `req.waitUntil` so fire-and-forget
 *                   async tasks (e.g. transactional email) can survive after the
 *                   HTTP response is resolved.  In non-Worker contexts (plain
 *                   Node.js) this is omitted and the property is a no-op.
 */
export async function expressToFetch(
  app: any,
  request: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const url = new URL(request.url);

  // Buffer the body so we can push it into the fake Readable.
  const bodyBuffer =
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.body != null
      ? Buffer.from(await request.arrayBuffer())
      : Buffer.alloc(0);

  // Flatten headers — Fetch API can have multiple values per name; join them.
  const headersObj: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headersObj[k] = v;
  });

  // Prefer CF-provided client IP.
  const clientIp =
    headersObj["cf-connecting-ip"] ??
    headersObj["x-forwarded-for"]?.split(",")[0]?.trim() ??
    "127.0.0.1";

  const fakeReq = createFakeReq(request.method, url.pathname + url.search, headersObj, bodyBuffer);
  fakeReq.socket.remoteAddress = clientIp;

  // Attach CF ExecutionContext.waitUntil so route handlers can keep fire-and-
  // forget Promises (e.g. transactional email) alive after the response resolves.
  // Falls back to a no-op so callers can always write `(req as any).waitUntil?.()`.
  fakeReq.waitUntil = waitUntil ?? ((_p: Promise<unknown>) => { /* no-op outside CF */ });

  // Pre-parse the body and set req.body + req._body before Express runs.
  //
  // body-parser (used by express.json / express.urlencoded) reads from the
  // IncomingMessage stream asynchronously.  In miniflare/workerd the Readable
  // event machinery doesn't deliver 'data' events in time, so body-parser
  // sees an empty stream and leaves req.body = undefined.
  //
  // body-parser has an explicit escape hatch:
  //   if (req._body) { debug('body already parsed'); return next(); }
  // Setting _body = true makes it skip re-parsing and preserves our value.
  // In plain Node.js (pnpm start), _body is never set here so body-parser
  // runs normally from the stream.
  if (bodyBuffer.length > 0) {
    const ct = headersObj["content-type"] ?? "";
    if (ct.includes("application/json")) {
      try {
        fakeReq.body  = JSON.parse(bodyBuffer.toString("utf-8"));
        fakeReq._body = true;
      } catch {
        // Malformed JSON — let body-parser return 400 via stream
      }
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      fakeReq.body  = Object.fromEntries(new URLSearchParams(bodyBuffer.toString("utf-8")));
      fakeReq._body = true;
    } else {
      // Binary / multipart / octet-stream / image/* etc.
      // express.raw() and other body-parsers honour req._body = true just like
      // express.json() does — they skip re-reading and leave req.body as-is.
      fakeReq.body  = bodyBuffer;
      fakeReq._body = true;
    }
  }

  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Worker request timed out after 30 s"));
    }, 30_000);

    const done = (r: Response) => {
      clearTimeout(timer);
      resolve(r);
    };

    const fakeRes = createFakeRes(done);

    try {
      app(fakeReq, fakeRes, (err: unknown) => {
        clearTimeout(timer);
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          // No handler matched — return 404.
          resolve(new Response("Not Found", { status: 404 }));
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
