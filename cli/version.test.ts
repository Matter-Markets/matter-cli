import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {MATTER_VERSION} from './version.js';

describe('CLI version', () => {
  it('matches the publishable package version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version: string};
    expect(MATTER_VERSION).toBe(manifest.version);
  });
});
