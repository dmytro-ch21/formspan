// W3C trace-context propagation to the backend (see
// backend/internal/platform/httplog for the server side). Plain
// Math.random()-based hex, not crypto — these are correlation IDs for
// logs, not secrets.
//
// Duplicated from apps/web and apps/mobile rather than shared — a ~15-line
// utility isn't worth a shared package yet.

function randomHex(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes; i++) {
    s += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return s;
}

/** A fresh 32-hex-char trace ID — one per admin page render. */
export function newTraceId(): string {
  return randomHex(16);
}

/** A `traceparent` header value for one request within `traceId`'s trace. */
export function traceparent(traceId: string): string {
  return `00-${traceId}-${randomHex(8)}-01`;
}
