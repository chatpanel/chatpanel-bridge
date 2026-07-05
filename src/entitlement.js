// Offline entitlement verification. The license server signs a compact entitlement
// token with an ECDSA P-256 private key; the bridge ships the matching public key
// and verifies the token's signature locally (no network). Gates Pro features such
// as "bring your own" custom CLI agents.
//
// Token format (identical to the extension's, extension/js/license.js):
//   token   = base64url(JSON payload) + "." + base64url(raw ECDSA signature)
//   signed over UTF-8(head); payload = { typ:'ent', plan, install_id, sub, exp }
//
// Keep ENTITLEMENT_PUBLIC_JWK in sync with the extension's copy.

import { webcrypto } from 'node:crypto';

const ENTITLEMENT_PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'CmgKLC4e3xDMvwhbjVqF7jbDe1JhC1KKQi8JN3qVX_4',
  y: 'r40l6fQiyCcJYqW-SvB4VoSyn4F36yhSt82ZAOSo78E',
};

const PRO_PLANS = new Set(['pro', 'team']);

const b64urlToBytes = (s) => {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(norm, 'base64'));
};

let keyPromise = null;
function publicKey() {
  if (!keyPromise) {
    keyPromise = webcrypto.subtle.importKey(
      'jwk',
      ENTITLEMENT_PUBLIC_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }
  return keyPromise;
}

// Verify a server entitlement token. Returns its payload, or null. Checks the
// ECDSA signature, the token type, and expiry. install_id binding is handled by
// the extension; the bridge checks the signature.
export async function verifyEntitlement(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [head, sig] = token.split('.');
  const enc = new TextEncoder();
  let ok = false;
  try {
    ok = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await publicKey(),
      b64urlToBytes(sig),
      enc.encode(head),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(head)));
  } catch {
    return null;
  }
  if (payload.typ !== 'ent') return null;
  // exp is required; the worker always mints a finite exp, so requiring one is non-breaking.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || Date.now() > payload.exp) return null;
  return payload;
}

// True when `token` is a valid, unexpired Pro (or Team) entitlement.
export async function isProEntitled(token) {
  const p = await verifyEntitlement(token);
  return !!(p && PRO_PLANS.has(p.plan));
}
