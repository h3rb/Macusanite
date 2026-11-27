/**
 * Leaving one vault for another.
 *
 * The editor's draft is the only copy of the last words typed: autosave is a
 * short clock, not a promise, and opening another vault replaces the draft with
 * that vault's start vein. So a vault change writes the draft first, and only
 * goes on to open the other vault when the save left nothing unsaved — a save
 * that was refused (a locked section, a failed write) keeps the reader in the
 * vault their words belong to.
 *
 * The steps are passed in rather than performed here, so the order can be
 * checked without a window: `isDirty` is asked before and after `save`, and
 * `open` runs only when neither answer found unsaved text.
 */

/**
 * @param {{
 *   isDirty: () => boolean,
 *   save: () => Promise<unknown> | unknown,
 *   open: () => Promise<unknown> | unknown,
 *   cancel?: (error?: unknown) => unknown,
 * }} steps
 * @returns {Promise<boolean>} whether the other vault was opened
 */
export async function switchWithSavedDraft({ isDirty, save, open, cancel }) {
  if (isDirty()) {
    try {
      await save();
    } catch (error) {
      cancel?.(error);
      return false;
    }
    if (isDirty()) {
      cancel?.();
      return false;
    }
  }
  await open();
  return true;
}
