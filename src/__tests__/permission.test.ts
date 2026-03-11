import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PendingPermissions } from '../permission-gateway.js';

describe('PendingPermissions', () => {
  it('waitFor resolves on allow', async () => {
    const pp = new PendingPermissions();
    const promise = pp.waitFor('req-1');
    assert.equal(pp.size, 1);

    pp.resolve('req-1', { behavior: 'allow' });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.equal(pp.size, 0);
  });

  it('waitFor resolves on deny', async () => {
    const pp = new PendingPermissions();
    const promise = pp.waitFor('req-2');

    pp.resolve('req-2', { behavior: 'deny', message: 'Not allowed' });
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.message, 'Not allowed');
  });

  it('resolve returns false for unknown id', () => {
    const pp = new PendingPermissions();
    assert.equal(pp.resolve('unknown', { behavior: 'allow' }), false);
  });

  it('resolve returns true for known id', async () => {
    const pp = new PendingPermissions();
    pp.waitFor('req-3');
    assert.equal(pp.resolve('req-3', { behavior: 'allow' }), true);
  });

  it('passes updatedPermissions through allow resolutions', async () => {
    const pp = new PendingPermissions();
    const promise = pp.waitFor('req-4');

    pp.resolve('req-4', {
      behavior: 'allow',
      updatedPermissions: [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo test' }],
      }],
    });

    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedPermissions, [{
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
      rules: [{ toolName: 'Bash', ruleContent: 'echo test' }],
    }]);
  });

  it('denyAll resolves all pending', async () => {
    const pp = new PendingPermissions();
    const p1 = pp.waitFor('req-a');
    const p2 = pp.waitFor('req-b');
    assert.equal(pp.size, 2);

    pp.denyAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.behavior, 'deny');
    assert.equal(r2.behavior, 'deny');
    assert.equal(pp.size, 0);
  });

  it('denyAll message says bridge shutting down', async () => {
    const pp = new PendingPermissions();
    const p = pp.waitFor('req-c');
    pp.denyAll();
    const result = await p;
    assert.equal(result.message, 'Bridge shutting down');
  });

  it('timeout auto-denies after expiry', async () => {
    // Create with short timeout for testing
    const pp = new PendingPermissions();
    // Access private field to set short timeout
    (pp as any).timeoutMs = 50;

    const result = await pp.waitFor('req-timeout');
    assert.equal(result.behavior, 'deny');
    assert.match(result.message!, /timed out/i);
    assert.equal(pp.size, 0);
  });
});
