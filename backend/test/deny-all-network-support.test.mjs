import assert from 'node:assert/strict';
import test from 'node:test';

import { installDenyAllNetworkGuard } from '../scripts/support/denyAllNetwork.mjs';

function blockedFetch(options, expected) {
  const guard = installDenyAllNetworkGuard(options);
  try {
    assert.throws(
      () => globalThis.fetch('https://network.invalid/'),
      (error) => {
        assert.equal(error?.code, expected.code);
        assert.equal(error?.message, expected.message);
        return true;
      },
    );
    assert.deepEqual(guard.blockedAttempts, [{ channel: 'fetch' }]);
  } finally {
    guard.restore();
  }
}

test('deny-all network guard preserves M1 defaults and supports scoped diagnostics', {
  concurrency: false,
}, () => {
  blockedFetch(undefined, {
    code: 'M1_NETWORK_BLOCKED',
    message: 'deterministic M1 blocked network-capable operation via fetch',
  });
  blockedFetch({
    label: 'deterministic W8',
    errorCode: 'W8_NETWORK_BLOCKED',
  }, {
    code: 'W8_NETWORK_BLOCKED',
    message: 'deterministic W8 blocked network-capable operation via fetch',
  });
});

test('deny-all network guard rejects ambiguous diagnostic options', {
  concurrency: false,
}, () => {
  assert.throws(
    () => installDenyAllNetworkGuard({ label: ' deterministic W8' }),
    /label is invalid/u,
  );
  assert.throws(
    () => installDenyAllNetworkGuard({ errorCode: 'w8-network-blocked' }),
    /errorCode is invalid/u,
  );
  assert.throws(
    () => installDenyAllNetworkGuard({ scope: 'W8' }),
    /option is unknown/u,
  );
});
