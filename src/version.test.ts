import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import config from './pluginConfig.ts';

// The release workflow publishes the version in pluginConfig.ts and tags it; package.json must say the same.
test('package.json and pluginConfig.ts have the same version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.match(config.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.version, config.version);
});
