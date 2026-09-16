import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings } from '../settings-scope.js';

test('project values override common values and opening mode remains common-only', () => {
  const defaults = { gap:6, mode:'dark', projectOpening:'windows', links:[] };
  const common = { gap:8, mode:'light', projectOpening:'tabs' };
  const overrides = { gap:12, projectOpening:'windows' };
  assert.deepEqual(effectiveSettings(defaults,common,overrides), {gap:12,mode:'light',projectOpening:'tabs',links:[]});
  delete overrides.gap;
  assert.equal(effectiveSettings(defaults,common,overrides).gap,8);
  assert.equal(effectiveSettings(defaults,{},{}).projectOpening,'windows');
});
