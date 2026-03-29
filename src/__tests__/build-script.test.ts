import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

describe('build/install runtime artifacts', () => {
  it('weixin login script points to a built runtime file', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    assert.equal(pkg.scripts['weixin:login'], 'node dist/weixin-login.mjs');
  });

  it('build emits the weixin login runtime bundle', () => {
    fs.rmSync(path.join(DIST_DIR, 'weixin-login.mjs'), { force: true });

    execFileSync('node', ['scripts/build.js'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });

    assert.equal(fs.existsSync(path.join(DIST_DIR, 'daemon.mjs')), true);
    assert.equal(fs.existsSync(path.join(DIST_DIR, 'weixin-login.mjs')), true);
  });
});
