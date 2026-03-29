import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import {
  WORKSPACES_CONFIG_PATH,
  loadWorkspaceConfig,
} from '../workspace-config.js';

describe('workspace-config', () => {
  const fixturesDir = path.join(CTI_HOME, 'workspace-fixtures');

  beforeEach(() => {
    fs.rmSync(WORKSPACES_CONFIG_PATH, { force: true });
    fs.rmSync(fixturesDir, { recursive: true, force: true });
    fs.mkdirSync(fixturesDir, { recursive: true });
  });

  it('returns null when workspace config is missing', () => {
    assert.equal(loadWorkspaceConfig(), null);
  });

  it('loads and normalizes a valid workspace config', () => {
    const zeroDir = path.join(fixturesDir, 'zero');
    fs.mkdirSync(zeroDir, { recursive: true });
    fs.writeFileSync(
      WORKSPACES_CONFIG_PATH,
      JSON.stringify({
        defaultAlias: 'zero',
        workspaces: [
          {
            alias: 'zero',
            path: `${zeroDir}/..//zero`,
          },
        ],
      }, null, 2),
      'utf-8',
    );

    const config = loadWorkspaceConfig();
    assert.ok(config);
    assert.equal(config.defaultAlias, 'zero');
    assert.deepEqual(config.workspaces, [
      {
        alias: 'zero',
        path: fs.realpathSync(zeroDir),
      },
    ]);
  });

  it('throws on duplicate aliases', () => {
    const zeroDir = path.join(fixturesDir, 'zero');
    const fooDir = path.join(fixturesDir, 'foo');
    fs.mkdirSync(zeroDir, { recursive: true });
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(
      WORKSPACES_CONFIG_PATH,
      JSON.stringify({
        defaultAlias: 'zero',
        workspaces: [
          { alias: 'zero', path: zeroDir },
          { alias: 'zero', path: fooDir },
        ],
      }, null, 2),
      'utf-8',
    );

    assert.throws(() => loadWorkspaceConfig(), /Duplicate workspace alias: zero/);
  });

  it('throws when default alias does not exist', () => {
    const zeroDir = path.join(fixturesDir, 'zero');
    fs.mkdirSync(zeroDir, { recursive: true });
    fs.writeFileSync(
      WORKSPACES_CONFIG_PATH,
      JSON.stringify({
        defaultAlias: 'missing',
        workspaces: [
          { alias: 'zero', path: zeroDir },
        ],
      }, null, 2),
      'utf-8',
    );

    assert.throws(() => loadWorkspaceConfig(), /Default workspace alias not found: missing/);
  });
});
