import { describe, it, expect } from 'vitest';

import { isIgnoredDir } from '../../../src/services/ignore-match.js';

describe('isIgnoredDir', () => {
  it('anchors a line with an inner slash at the root, with * inside one segment', () => {
    const lines = ['plugin-config-data/*/cache/'];
    expect(isIgnoredDir('plugin-config-data/tides/cache', lines)).toBe(true);
    expect(isIgnoredDir('plugin-config-data/tides/cache/deeper', lines)).toBe(true);
    expect(isIgnoredDir('plugin-config-data/tides/sub/cache', lines)).toBe(false);
    expect(isIgnoredDir('cache', lines)).toBe(false);
    expect(isIgnoredDir('plugin-config-data/tides', lines)).toBe(false);
  });

  it('matches a line without an inner slash at any depth', () => {
    const lines = ['node_modules/', 'charts*/'];
    expect(isIgnoredDir('node_modules', lines)).toBe(true);
    expect(isIgnoredDir('plugin-config-data/foo/node_modules', lines)).toBe(true);
    expect(isIgnoredDir('charts-simple', lines)).toBe(true);
    expect(isIgnoredDir('plugin-config-data/foo/charts', lines)).toBe(true);
    expect(isIgnoredDir('node_modules.backup', lines)).toBe(false);
  });

  it('lets the last matching line win, so ! re-includes', () => {
    const lines = ['plugin-config-data/*/*-cache/', '!plugin-config-data/tides/harmonics-cache/'];
    expect(isIgnoredDir('plugin-config-data/tides/harmonics-cache', lines)).toBe(false);
    expect(isIgnoredDir('plugin-config-data/charts/raster-tile-cache', lines)).toBe(true);
    expect(
      isIgnoredDir('plugin-config-data/tides/harmonics-cache', [...lines, 'harmonics-cache/'])
    ).toBe(true);
  });

  it('cannot re-include below an ignored directory', () => {
    const lines = ['plugin-config-data/foo/', '!plugin-config-data/foo/keep/'];
    expect(isIgnoredDir('plugin-config-data/foo/keep', lines)).toBe(true);
  });

  it('treats ? as one character and other regex characters literally', () => {
    expect(isIgnoredDir('a1', ['a?/'])).toBe(true);
    expect(isIgnoredDir('a12', ['a?/'])).toBe(false);
    expect(isIgnoredDir('axb', ['a.b/'])).toBe(false);
    expect(isIgnoredDir('a.b', ['a.b/'])).toBe(true);
  });

  it('skips blank and comment lines, and a leading slash only anchors', () => {
    expect(isIgnoredDir('logs', ['', '# logs/', '/logs/'])).toBe(true);
    expect(isIgnoredDir('foo/logs', ['/logs/'])).toBe(false);
    expect(isIgnoredDir('logs', ['', '# logs/'])).toBe(false);
  });

  it('lets ** stand for zero or more directories', () => {
    expect(isIgnoredDir('plugin-config-data/foo/a/b/cache', ['plugin-config-data/**/cache/'])).toBe(
      true
    );
    expect(isIgnoredDir('plugin-config-data/cache', ['plugin-config-data/**/cache/'])).toBe(true);
    expect(isIgnoredDir('cache', ['plugin-config-data/**/cache/'])).toBe(false);
    expect(isIgnoredDir('x/y/logs', ['**/logs/'])).toBe(true);
    expect(isIgnoredDir('logs', ['**/logs/'])).toBe(true);
    expect(isIgnoredDir('plugin-config-data/kip/history', ['plugin-config-data/kip/**'])).toBe(
      true
    );
  });

  it('supports [...] character classes and their [!...] complement', () => {
    expect(isIgnoredDir('plugin-config-data/kip', ['plugin-config-data/[kt]*/'])).toBe(true);
    expect(isIgnoredDir('plugin-config-data/tides', ['plugin-config-data/[kt]*/'])).toBe(true);
    expect(isIgnoredDir('plugin-config-data/crowd-depth', ['plugin-config-data/[kt]*/'])).toBe(
      false
    );
    expect(isIgnoredDir('plugin-config-data/crowd-depth', ['plugin-config-data/[!kt]*/'])).toBe(
      true
    );
    expect(isIgnoredDir('a[b', ['a[b/'])).toBe(true);
  });

  it('anchors a line with a leading slash', () => {
    expect(isIgnoredDir('plugin-config-data/kip', ['/plugin-config-data/kip/'])).toBe(true);
  });
});
