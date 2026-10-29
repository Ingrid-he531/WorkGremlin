'use strict';

/**
 * TLS material for the standalone server (`--tls`, or `--tls-cert` + `--tls-key`).
 *
 * Why this exists: the documented way to expose the server beyond loopback used to be a TLS
 * reverse proxy or an SSH tunnel. Both stay valid (and are still the best choice when a proxy is
 * already running), but they require a second process on the server machine. `--tls` lets the
 * server itself speak HTTPS, so a browser-only client gets an encrypted channel with nothing
 * else installed.
 *
 * What a self-signed certificate does and does not do:
 *   · it **does** encrypt the transport, so the token and all session/task data stop travelling
 *     in clear text on the LAN;
 *   · it **does not** prove who the server is —— no CA vouches for it, so the browser shows
 *     "not private" and the user has to accept it once. That is why the SHA-256 fingerprint is
 *     printed at startup: "continue anyway" can be an informed decision instead of blind trust.
 *
 * Files (self-signed mode) live in `~/.workgremlin/tls/`:
 *   server.key  (0600)   server.crt  (0644)
 * They are reused while they still parse, still cover this machine, and have more than
 * RENEW_BEFORE_MS left. Regenerating on every start would invalidate the browser's "continue"
 * decision (and every previously imported copy) for no gain.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { home } = require('@workgremlin/shared');

/** Renew ahead of expiry: an expired certificate is a hard error in the browser, a renewal only a warning. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Browser acceptance of a user-trusted self-signed certificate is capped: Chrome/Edge allow 825
 * days for a certificate the user installed manually, Apple platforms 398. 825 is the largest
 * value that works everywhere we ship, so a certificate is never rejected for being too long-lived.
 */
const VALID_DAYS = 825;

/** `~/.workgremlin/tls` (respects WORKGREMLIN_HOME through shared.home()). */
function tlsDir() {
  return path.join(home(), 'tls');
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** @param {string} value */
const isIp = (value) => IPV4.test(value) || value.includes(':');

/**
 * Names this machine answers to. `localhost` comes first: it is also the CN and always resolves.
 * Internal addresses are skipped (nothing connects to them) and so are IPv6 link-local ones ——
 * `fe80::` addresses are reachable but cannot be typed into a browser address bar with a zone id.
 * @returns {string[]}
 */
function localNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  const host = os.hostname();
  if (host) names.add(host);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (!addr || addr.internal) continue;
      if (/^fe80:/i.test(addr.address)) continue;
      names.add(addr.address);
    }
  }
  return [...names];
}

/**
 * A stored pair is reusable when the key matches the certificate, it is not about to expire, and
 * it still covers at least one current name.
 *
 * "At least one" on purpose: requiring every interface would regenerate the certificate whenever
 * a laptop joins another network. A hostname mismatch is click-throughable, a missing/expired
 * certificate is not, so only the latter forces a new one.
 *
 * @param {{key: string, cert: string}} pair
 * @param {string[]} names
 */
function isUsable({ key, cert }, names) {
  try {
    const x509 = new crypto.X509Certificate(cert);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) return false;
    if (new Date(x509.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) return false;
    return names.some((name) => {
      try {
        // IP SANs need checkIP: checkHost only matches DNS names, so relying on it would treat
        // every address as "not covered" and regenerate the certificate on each start.
        return Boolean(isIp(name) ? x509.checkIP(name) : x509.checkHost(name));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** @param {string} dir @returns {{key: string, cert: string}|null} */
function readPair(dir) {
  try {
    return {
      key: fs.readFileSync(path.join(dir, 'server.key'), 'utf8'),
      cert: fs.readFileSync(path.join(dir, 'server.crt'), 'utf8'),
    };
  } catch {
    return null; // first run, or a half-written pair from a crash: generate a fresh one
  }
}

/** @param {string} dir @param {{key: string, cert: string}} pair */
function writePair(dir, pair) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'server.key');
  const certFile = path.join(dir, 'server.crt');
  fs.writeFileSync(keyFile, pair.key, { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {
    /* non-POSIX: best effort */
  }
  // Private key first: if the process dies in between, the next start sees an incomplete pair
  // and regenerates, instead of serving a certificate whose key is missing.
  fs.writeFileSync(certFile, pair.cert, { mode: 0o644 });
  return { keyFile, certFile };
}

/**
 * @param {string[]} names
 * @returns {Promise<{key: string, cert: string}>}
 */
async function generateSelfSigned(names) {
  // Loaded lazily: only a --tls run needs the generator (and its X.509 dependencies).
  const selfsigned = require('selfsigned');
  const altNames = names.map((name) => (isIp(name) ? { type: 7, ip: name } : { type: 2, value: name }));
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: names[0] }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      // Back-date slightly: a client whose clock is a minute behind must not reject a brand-new
      // certificate as "not valid yet" (a common cause of "it worked yesterday" reports).
      notBeforeDate: new Date(Date.now() - 5 * 60_000),
      notAfterDate: new Date(Date.now() + VALID_DAYS * 24 * 60 * 60_000),
      // Passing `extensions` replaces the generator's defaults, so the full set is spelled out:
      // server-auth usage plus one SAN entry per name, which is what browsers actually match on.
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );
  return { key: pems.private, cert: pems.cert };
}

/**
 * Resolve the TLS material the server should listen with.
 *
 * @param {{certFile?: string, keyFile?: string, selfSigned?: boolean, dir?: string,
 *          names?: string[]}} [opts]
 * @returns {Promise<{key: string, cert: string, fingerprint256: string,
 *   source: 'file'|'self-signed', certFile: string, keyFile: string, validTo: string,
 *   reused: boolean}|null>} null = stay on plain HTTP
 * @throws when a supplied pair is unreadable or does not match
 */
async function resolveTls(opts = {}) {
  const { certFile, keyFile, selfSigned } = opts;

  if (certFile || keyFile) {
    if (!certFile || !keyFile) {
      throw new Error('--tls-cert 和 --tls-key 必须同时给出（证书链 + 私钥）');
    }
    let cert;
    let key;
    try {
      cert = fs.readFileSync(certFile, 'utf8');
    } catch (err) {
      throw new Error(`读不到证书 ${certFile}：${(err && err.message) || err}`);
    }
    try {
      key = fs.readFileSync(keyFile, 'utf8');
    } catch (err) {
      throw new Error(`读不到私钥 ${keyFile}：${(err && err.message) || err}`);
    }
    const x509 = new crypto.X509Certificate(cert);
    // Check the pairing here: at startup the message can name the two files, later it would only
    // surface as a TLS handshake failure on every request.
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) {
      throw new Error(`证书和私钥不匹配：${certFile} 与 ${keyFile}`);
    }
    return {
      key,
      cert,
      fingerprint256: x509.fingerprint256,
      source: 'file',
      certFile,
      keyFile,
      validTo: x509.validTo,
      reused: false,
    };
  }

  if (!selfSigned) return null;

  const dir = opts.dir || tlsDir();
  const names = opts.names || localNames();
  const existing = readPair(dir);
  const reused = Boolean(existing && isUsable(existing, names));
  const pair = reused ? existing : await generateSelfSigned(names);
  const files = reused
    ? { keyFile: path.join(dir, 'server.key'), certFile: path.join(dir, 'server.crt') }
    : writePair(dir, pair);
  const x509 = new crypto.X509Certificate(pair.cert);
  return {
    ...files,
    key: pair.key,
    cert: pair.cert,
    fingerprint256: x509.fingerprint256,
    source: 'self-signed',
    validTo: x509.validTo,
    reused,
  };
}

module.exports = {
  resolveTls,
  localNames,
  tlsDir,
  isUsable,
  isIp,
  RENEW_BEFORE_MS,
  VALID_DAYS,
};
