// What server.mjs adds to a request: its gate sets `identity` before every
// route except /healthz (which never reads it), or answers 401 itself.
declare global {
  namespace Express {
    interface Request {
      /** The verified Access email, or 'local' on a loopback cockpit. */
      identity: string;
    }
  }
}
export {};
