/**
 * The vault list is the one piece of state that lives outside a vault, so its
 * parsing rules matter: a damaged file must never stop a vault opening, and the
 * same folder must never appear twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REGISTRY_FILE, MAX_KNOWN_VAULTS, emptyRegistry, pathKey,
  parseRegistry, serializeRegistry, rememberVault, knownVaults,
} from '../../src/lib/vaultRegistry.js';

test('the registry file is the documented name', () => {
  assert.equal(REGISTRY_FILE, 'vaults.json');
});

test('an unreadable registry is empty rather than an error', () => {
  assert.deepEqual(parseRegistry(null), emptyRegistry());
  assert.deepEqual(parseRegistry(''), emptyRegistry());
  assert.deepEqual(parseRegistry('{ not json'), emptyRegistry());
  assert.deepEqual(parseRegistry('{"vaults": "nope"}'), emptyRegistry());
  assert.deepEqual(parseRegistry('[]'), emptyRegistry());
});

test('entries are cleaned, deduplicated by folder and sorted newest first', () => {
  const registry = parseRegistry({
    version: 1,
    vaults: [
      { path: 'C:\\Notes\\Older', name: 'Older', lastOpened: 10 },
      { path: 'C:/Notes/Newer/', name: '  Newer  ', lastOpened: 20 },
      { path: 'C:\\notes\\older\\', lastOpened: 30 },
      { path: '', name: 'no path' },
      { nope: true },
    ],
  });

  // Newest first, and the duplicate folder (in another case and with a
  // trailing separator) is folded into the first record for it.
  assert.deepEqual(registry.vaults.map((vault) => vault.name), ['Newer', 'Older']);
  assert.equal(registry.vaults[0].path, 'C:/Notes/Newer/');
  assert.equal(registry.vaults[1].path, 'C:\\Notes\\Older');
});

test('a vault recorded without a name takes its folder name', () => {
  const registry = parseRegistry([{ path: '/home/reader/Vaults/Field Notes' }]);
  assert.equal(registry.vaults[0].name, 'Field Notes');
  assert.equal(registry.vaults[0].lastOpened, 0);
});

test('remembering a vault moves it to the front without duplicating it', () => {
  let registry = emptyRegistry();
  registry = rememberVault(registry, { path: 'C:\\Notes\\A', name: 'A', lastOpened: 1 });
  registry = rememberVault(registry, { path: '/home/reader/B', name: 'B', lastOpened: 2 });
  registry = rememberVault(registry, { path: 'c:/notes/a', name: 'A again', lastOpened: 3 });

  assert.deepEqual(registry.vaults.map((vault) => vault.name), ['A again', 'B']);
  assert.equal(registry.vaults[0].lastOpened, 3);
});

test('the list keeps only the most recent vaults', () => {
  let registry = emptyRegistry();
  for (let i = 0; i < MAX_KNOWN_VAULTS + 5; i += 1) {
    registry = rememberVault(registry, { path: `/vaults/${i}`, name: `V${i}`, lastOpened: i });
  }
  assert.equal(registry.vaults.length, MAX_KNOWN_VAULTS);
  assert.equal(registry.vaults[0].name, `V${MAX_KNOWN_VAULTS + 4}`);
  assert.equal(registry.vaults.at(-1).name, 'V5');
});

test('the switch menu leaves out the vault already open', () => {
  const registry = {
    vaults: [
      { path: 'C:\\Notes\\Current', name: 'Current', lastOpened: 3 },
      { path: 'C:\\Notes\\Other', name: 'Other', lastOpened: 2 },
    ],
  };
  assert.deepEqual(knownVaults(registry, { current: 'c:/notes/current/' }).map((v) => v.name), ['Other']);
  assert.equal(knownVaults(registry).length, 2);
  assert.equal(knownVaults(registry, { limit: 1 }).length, 1);
  assert.deepEqual(knownVaults(registry, { current: 'C:\\Notes\\Other' }).map((v) => v.name), ['Current']);
});

test('the written file is readable JSON with the minimum fields', () => {
  const text = serializeRegistry({
    vaults: [{ path: '/vaults/A', name: 'A', lastOpened: 5, secret: 'not written' }],
  });
  assert.ok(text.endsWith('\n'));
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), ['vaults', 'version']);
  assert.deepEqual(Object.keys(parsed.vaults[0]).sort(), ['lastOpened', 'name', 'path']);
  assert.equal(parsed.vaults[0].name, 'A');
});

test('pathKey folds separators, trailing slashes and case', () => {
  assert.equal(pathKey('C:\\Notes\\Vault\\'), 'c:/notes/vault');
  assert.equal(pathKey('/home/reader/vault'), '/home/reader/vault');
  assert.equal(pathKey('  '), '');
});
