/**
 * Opening another vault replaces the open draft, so the order of a switch is
 * the whole safety property: write the draft first, open second, and stay where
 * the words are when the write did not take.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { switchWithSavedDraft } from '../../src/lib/vaultSwitch.js';

function harness({ dirty = false, saveFails = false, saveKeepsDirty = false } = {}) {
  const calls = [];
  let unsaved = dirty;
  let failure = null;
  const steps = {
    isDirty: () => {
      calls.push('dirty');
      return unsaved;
    },
    save: async () => {
      calls.push('save');
      if (saveFails) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      if (!saveKeepsDirty) unsaved = false;
    },
    open: async () => {
      calls.push('open');
    },
    cancel: (error) => {
      failure = error ?? null;
      calls.push('cancel');
    },
  };
  return { steps, calls, failure: () => failure };
}

test('a clean draft opens the other vault without saving', async () => {
  const { steps, calls } = harness();
  assert.equal(await switchWithSavedDraft(steps), true);
  assert.deepEqual(calls, ['dirty', 'open']);
});

test('a dirty draft is written before the other vault opens', async () => {
  const { steps, calls } = harness({ dirty: true });
  assert.equal(await switchWithSavedDraft(steps), true);
  assert.deepEqual(calls, ['dirty', 'save', 'dirty', 'open']);
});

test('a save that leaves the draft dirty keeps the vault open', async () => {
  const { steps, calls } = harness({ dirty: true, saveKeepsDirty: true });
  assert.equal(await switchWithSavedDraft(steps), false);
  assert.deepEqual(calls, ['dirty', 'save', 'dirty', 'cancel']);
});

test('a failed save keeps the vault open and reports the failure', async () => {
  const { steps, calls, failure } = harness({ dirty: true, saveFails: true });
  assert.equal(await switchWithSavedDraft(steps), false);
  assert.deepEqual(calls, ['dirty', 'save', 'cancel']);
  assert.equal(failure()?.message, 'disk full');
});

test('a switch still opens when there is nothing to cancel with', async () => {
  const steps = {
    isDirty: () => true,
    save: () => {
      throw new Error('read-only');
    },
    open: () => {
      throw new Error('must not open');
    },
  };
  assert.equal(await switchWithSavedDraft(steps), false);
});
