import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import tls from 'node:tls';

const DNS_METHODS = Object.freeze([
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
]);

const CHILD_PROCESS_METHODS = Object.freeze([
  'exec',
  'execFile',
  'execSync',
  'execFileSync',
  'fork',
  'spawn',
  'spawnSync',
]);

const DEFAULT_LABEL = 'deterministic M1';
const DEFAULT_ERROR_CODE = 'M1_NETWORK_BLOCKED';

function guardOptions(options) {
  if (options === undefined) {
    return Object.freeze({
      label: DEFAULT_LABEL,
      errorCode: DEFAULT_ERROR_CODE,
    });
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('deny-all network guard options must be an object');
  }
  const unknown = Object.keys(options).filter(
    (key) => !['errorCode', 'label'].includes(key),
  );
  if (unknown.length > 0) {
    throw new TypeError(`deny-all network guard option is unknown: ${unknown[0]}`);
  }
  const label = options.label ?? DEFAULT_LABEL;
  const errorCode = options.errorCode ?? DEFAULT_ERROR_CODE;
  if (
    typeof label !== 'string'
    || label.trim() !== label
    || label.length === 0
    || label.length > 128
    || /[\r\n]/u.test(label)
  ) {
    throw new TypeError('deny-all network guard label is invalid');
  }
  if (
    typeof errorCode !== 'string'
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode)
  ) {
    throw new TypeError('deny-all network guard errorCode is invalid');
  }
  return Object.freeze({ label, errorCode });
}

function blockedError(channel, options) {
  const error = new Error(
    `${options.label} blocked network-capable operation via ${channel}`,
  );
  error.code = options.errorCode;
  return error;
}

function replaceMethods(target, names, prefix, block, originals) {
  for (const name of names) {
    if (typeof target?.[name] !== 'function') continue;
    originals.push({ target, name, value: target[name] });
    target[name] = block(`${prefix}.${name}`);
  }
}

/**
 * Installs a fail-closed network guard for a deterministic worker process.
 *
 * M1 workers have no legitimate socket, DNS, HTTP, fetch, datagram, TLS, or
 * child-process use after startup. Blocking child-process APIs closes the
 * repository's curl fallback path as well as less obvious command transports.
 */
export function installDenyAllNetworkGuard(options) {
  const validatedOptions = guardOptions(options);
  const blockedAttempts = [];
  const originals = [];
  let restored = false;

  const block = (channel) => function blockedOperation() {
    blockedAttempts.push(Object.freeze({ channel }));
    throw blockedError(channel, validatedOptions);
  };

  if (typeof globalThis.fetch === 'function') {
    originals.push({
      target: globalThis,
      name: 'fetch',
      value: globalThis.fetch,
    });
    globalThis.fetch = block('fetch');
  }

  replaceMethods(http, ['request', 'get'], 'http', block, originals);
  replaceMethods(http2, ['connect'], 'http2', block, originals);
  replaceMethods(https, ['request', 'get'], 'https', block, originals);
  replaceMethods(net, ['connect', 'createConnection'], 'net', block, originals);
  if (typeof net.Socket?.prototype?.connect === 'function') {
    originals.push({
      target: net.Socket.prototype,
      name: 'connect',
      value: net.Socket.prototype.connect,
    });
    net.Socket.prototype.connect = block('net.Socket.connect');
  }
  replaceMethods(tls, ['connect'], 'tls', block, originals);
  replaceMethods(dgram, ['createSocket'], 'dgram', block, originals);
  replaceMethods(dns, DNS_METHODS, 'dns', block, originals);
  replaceMethods(dns.promises, DNS_METHODS, 'dns.promises', block, originals);
  replaceMethods(
    dns.Resolver?.prototype,
    DNS_METHODS,
    'dns.Resolver',
    block,
    originals,
  );
  replaceMethods(
    dns.promises?.Resolver?.prototype,
    DNS_METHODS,
    'dns.promises.Resolver',
    block,
    originals,
  );
  if (typeof globalThis.WebSocket === 'function') {
    originals.push({
      target: globalThis,
      name: 'WebSocket',
      value: globalThis.WebSocket,
    });
    globalThis.WebSocket = block('WebSocket');
  }
  replaceMethods(
    childProcess,
    CHILD_PROCESS_METHODS,
    'child_process',
    block,
    originals,
  );
  syncBuiltinESMExports();

  return Object.freeze({
    blockedAttempts,
    restore() {
      if (restored) return;
      restored = true;
      for (const { target, name, value } of originals.reverse()) {
        target[name] = value;
      }
      syncBuiltinESMExports();
    },
  });
}
