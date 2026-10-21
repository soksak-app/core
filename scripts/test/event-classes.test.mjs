import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { classOf } from '../../packages/workbench/event-classes.js';
import { classTables, generatedTables } from '../generate-event-classes.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../docs/spec/events.json', import.meta.url), 'utf8'));

test('the committed class tables equal what the catalog gives', () => {
  for (const [path, text] of Object.entries(generatedTables())) {
    assert.equal(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), text, `${path} differs from docs/spec/events.json`);
  }
});

test('the page table gives every declared event and family member its catalog class', () => {
  for (const [name, declared] of Object.entries(catalog.events)) {
    const probe = name.replace(/<[a-z_]+>$/, 'x1_y.z');
    assert.equal(classOf(probe), declared.class, name);
  }
  assert.equal(classOf('page.call'), 'call');
  assert.equal(classOf('page.console.warn'), 'lifecycle');
  assert.equal(classOf('page.console.'), undefined);
  assert.equal(classOf('page.console.WARN'), undefined);
  assert.equal(classOf('plugin.probe.opened'), undefined);
});

test('a family whose placeholder is not at the end and a class outside the contract are refused', () => {
  assert.throws(() => classTables({ events: { 'page.<x>.end': { class: 'call' } } }), /must end with its placeholder/);
  assert.throws(() => classTables({ events: { 'page.x': { class: 'noise' } } }), /class "noise"/);
});
