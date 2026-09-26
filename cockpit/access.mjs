// access.mjs - Cloudflare Access enforcement for the cockpit. FORCED, no
// escape hatch: the cockpit binds loopback; any other bind refuses to start
// unless an Access config exists, and once one exists EVERY request (HTTP and
// WS upgrade) must carry a `Cf-Access-Jwt-Assertion` that verifies here.
//
// Why not trust the edge alone: the old cockpit minted its session cookie for
// anyone who loaded `/` from an allowed Host, so passing Access once handed out
// a cookie that was never tied to WHO passed. Now the cookie is derived from
// the verified JWT's `email` claim and re-checked against the JWT on every
// request, so a stolen cookie is useless without that identity's JWT, and a
// JWT for a different identity cannot ride an existing cookie.
//
// Config: <BOTCORP_HOME>/access.json  { team, aud, frame_ancestors?, allowed_emails? }
//   team  -> https://<team>.cloudflareaccess.com (issuer + JWKS host)
//   aud   -> the Access application's AUD tag
//   allowed_emails -> when non-empty, a verified JWT whose email is not listed
//            is refused too (defence in depth against a loose Access policy);
//            empty or absent = any identity Access admits, as before
// Test seam: COCKPIT_ACCESS_JWKS_FILE=<path> reads the JWKS from a file instead
// of fetching it. Verification still runs in full; it only changes where the
// public keys come from, so tests can sign with a throwaway RSA key.

import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';

const JWKS_TTL_MS = 60 * 60 * 1000;

export async function loadAccessConfig(file) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf-8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const cfg = JSON.parse(raw);
  if (typeof cfg?.team !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(cfg.team)) throw new Error(`${file}: "team" must be the Access team slug`);
  if (typeof cfg?.aud !== 'string' || !cfg.aud) throw new Error(`${file}: "aud" must be the application AUD tag`);
  let fa = cfg.frame_ancestors;
  if (Array.isArray(fa)) fa = fa.join(' ');
  if (fa !== undefined && typeof fa !== 'string') throw new Error(`${file}: "frame_ancestors" must be a string or array`);
  const ae = cfg.allowed_emails ?? [];
  if (!Array.isArray(ae) || ae.some((e) => typeof e !== 'string' || !e.includes('@'))) throw new Error(`${file}: "allowed_emails" must be an array of email addresses`);
  return { team: cfg.team, aud: cfg.aud, frameAncestors: (fa || '').trim() || "'none'", allowedEmails: ae.map((e) => e.trim().toLowerCase()) };
}

function b64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

export class AccessVerifier {
  constructor(cfg) {
    this.cfg = cfg;
    this.issuer = `https://${cfg.team}.cloudflareaccess.com`;
    this.jwksUrl = `${this.issuer}/cdn-cgi/access/certs`;
    this.jwksFile = process.env.COCKPIT_ACCESS_JWKS_FILE || null;
    this.keys = null;        // kid -> KeyObject
    this.fetchedAt = 0;
    this.inflight = null;
  }

  async loadKeys(force = false) {
    if (!force && this.keys && Date.now() - this.fetchedAt < JWKS_TTL_MS) return this.keys;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      let jwks;
      if (this.jwksFile) {
        jwks = JSON.parse(await fsp.readFile(this.jwksFile, 'utf-8'));
      } else {
        const res = await fetch(this.jwksUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
        jwks = await res.json();
      }
      const keys = new Map();
      for (const jwk of jwks?.keys || []) {
        if (jwk.kty !== 'RSA' || !jwk.kid) continue;
        try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch {}
      }
      this.keys = keys;
      this.fetchedAt = Date.now();
      return keys;
    })();
    try { return await this.inflight; } finally { this.inflight = null; }
  }

  // Returns { email } on success; throws on any failure (caller answers 401).
  async verify(jwt) {
    if (typeof jwt !== 'string' || jwt.length > 8192) throw new Error('no jwt');
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('malformed jwt');
    let header, payload;
    try {
      header = JSON.parse(b64url(parts[0]).toString('utf-8'));
      payload = JSON.parse(b64url(parts[1]).toString('utf-8'));
    } catch { throw new Error('malformed jwt'); }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('unsupported alg');

    let keys = await this.loadKeys();
    let key = keys.get(header.kid);
    if (!key && Date.now() - this.fetchedAt > 60_000) { keys = await this.loadKeys(true); key = keys.get(header.kid); }
    if (!key) throw new Error('unknown kid');

    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]));
    if (!ok) throw new Error('bad signature');

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== this.issuer) throw new Error('bad iss');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.cfg.aud)) throw new Error('bad aud');
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error('expired');
    if (Number.isFinite(payload.nbf) && payload.nbf > now + 60) throw new Error('not yet valid');
    if (typeof payload.email !== 'string' || !payload.email) throw new Error('no email claim');
    const email = payload.email.toLowerCase();
    if (this.cfg.allowedEmails?.length && !this.cfg.allowedEmails.includes(email)) throw new Error('email not allowed');
    return { email };
  }
}

// Session cookie bound to an identity. Loopback mode binds to the literal
// 'local' identity with a per-boot random secret (the old per-boot token);
// Access mode binds to the JWT email. Either way the cookie carries no secret
// itself: it is HMAC(secret, identity) plus a hash of the identity, checked
// against the identity of the CURRENT request.
export class SessionCookie {
  constructor({ name = 'botcorp_session', secure }) {
    this.name = name;
    this.secure = !!secure;
    this.secret = crypto.randomBytes(32);
  }
  mint(identity) {
    const id = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
    const mac = crypto.createHmac('sha256', this.secret).update(identity).digest('hex');
    return `${id}.${mac}`;
  }
  header(identity) {
    return `${this.name}=${this.mint(identity)}; HttpOnly; SameSite=Strict; Path=/${this.secure ? '; Secure' : ''}`;
  }
  read(req) {
    const m = new RegExp(`(?:^|;\\s*)${this.name}=([a-f0-9]{32}\\.[a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie || '');
    return m ? m[1] : null;
  }
  // true when the request carries the cookie minted for exactly this identity
  check(req, identity) {
    const got = this.read(req);
    if (!got) return false;
    const want = this.mint(identity);
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }
}
