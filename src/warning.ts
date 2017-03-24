/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

/** TODO(rictic): upstream this file and its tests into the analyzer. */

import {comparePositionAndRange, isPositionInsideRange, ParsedDocument, SourceRange, Warning} from 'polymer-analyzer';

/** This will be upstreamed to just Warning on Analyzer. */
export interface FixableWarning extends Warning {
  /**
   * If the problem has a single automatic fix, this is it.
   *
   * Whether and how much something is 'automatic' can be a bit tricky to
   * delineate. Roughly speaking, if 99% of the time the change solves the
   * issue completely then it should go in `fix`.
   */
  fix?: Edit;

  /**
   * For warnings with multiple fixes, or even a single fix that has some
   * caveats, these should go into suggestedFixes, where they are only invoked
   * deliberately by the user.
   *
   * e.g. these might be invoked through an interactive CLI menu in `polymer
   * lint` or with a right-click context menu in a text editor.
   */
  suggestedFixes?: SuggestedFix[];
}

export interface SuggestedFix {
  /**
   * Describes what will be done in one short sentence.
   */
  shortDescription: string;
  edit: Edit;
}

/**
 * An array of replacements that must be applied as a group.
 *
 * If any replacement in an edit can't be applied then all replacements from the
 * edit can't be applied (consider an Edit that renames a class, it's invalid to
 * only rename some references).
 *
 * The replacements may be across multiple files.
 */
export type Edit = Array<Replacement>;


/**
 * A single change to a single file.
 *
 * This also encompases insertions (range is a point, start and end identical)
 * and deletions (replacementText is the empty string).
 */
export interface Replacement {
  range: SourceRange;
  replacementText: string;
}

/** The result of attempting to apply some edits. */
export interface EditResult {
  /** The edits that had no conflicts, and are reflected in editedFiles. */
  appliedEdits: Edit[];

  /** Edits that could not be applied due to overlapping ranges. */
  incompatibleEdits: Edit[];

  /** A map from urls to their new contents. */
  editedFiles: Map<string, string>;
}

/**
 * Takes the given edits and, provided there are no overlaps, applies them to
 * the contents loadable from the given loader.
 *
 * If there are overlapping edits, then edits earlier in the array get priority
 * over later ones.
 */
export async function applyEdits(
    edits: Edit[], loader: (url: string) => Promise<ParsedDocument<any, any>>):
    Promise<EditResult> {
  const result: EditResult = {
    appliedEdits: [],
    incompatibleEdits: [],
    editedFiles: new Map()
  };

  const replacementsByFile = new Map<string, Replacement[]>();
  for (const edit of edits) {
    if (canApply(edit, replacementsByFile)) {
      result.appliedEdits.push(edit);
    } else {
      result.incompatibleEdits.push(edit);
    }
  }

  for (const entry of replacementsByFile) {
    const file = entry[0];
    const replacements = entry[1];
    const document = await loader(file);
    let contents = document.contents;
    /**
     * This is the important bit. We know that none of the replacements overlap,
     * so in order for their source ranges in the file to all be valid at the
     * time we apply them, we simply need to apply them starting from the end
     * of the document and working backwards to the beginning.
     */
    replacements.sort((a, b) => {
      const leftEdgeComp =
          comparePositionAndRange(b.range.start, a.range, true);
      if (leftEdgeComp !== 0) {
        return leftEdgeComp;
      }
      return comparePositionAndRange(b.range.end, a.range, false);
    });
    for (const replacement of replacements) {
      const offsets = document.sourceRangeToOffsets(replacement.range);
      contents = contents.slice(0, offsets[0]) + replacement.replacementText +
          contents.slice(offsets[1]);
    }
    result.editedFiles.set(file, contents);
  }

  return result;
}

/**
 * We can apply an edit if none of its replacements overlap with any accepted
 * replacement.
 */
function canApply(
    edit: Edit, replacements: Map<string, Replacement[]>): boolean {
  for (let i = 0; i < edit.length; i++) {
    const replacement = edit[i];
    const fileLocalReplacements =
        replacements.get(replacement.range.file) || [];
    // TODO(rictic): binary search
    for (const acceptedReplacement of fileLocalReplacements) {
      if (doRangesOverlap(replacement.range, acceptedReplacement.range)) {
        return false;
      }
    }
    // Also check consistency between multiple replacements in this edit.
    for (let j = 0; j < i; j++) {
      const acceptedReplacement = edit[j];
      if (doRangesOverlap(replacement.range, acceptedReplacement.range)) {
        return false;
      }
    }
  }

  // Ok, we can be applied to the replacements, so add our replacements in.
  for (const replacement of edit) {
    if (!replacements.has(replacement.range.file)) {
      replacements.set(replacement.range.file, [replacement]);
    } else {
      const fileReplacements = replacements.get(replacement.range.file)!;
      // TODO(rictic): insert in sorted order, needed for binary search above.
      fileReplacements.push(replacement);
    }
  }
  return true;
}

function doRangesOverlap(a: SourceRange, b: SourceRange) {
  if (a.file !== b.file) {
    return false;
  }
  return areRangesEqual(a, b) || isPositionInsideRange(a.start, b, false) ||
      isPositionInsideRange(a.end, b, false) ||
      isPositionInsideRange(b.start, a, false) ||
      isPositionInsideRange(b.end, a, false);
}

function areRangesEqual(a: SourceRange, b: SourceRange) {
  return a.start.line === b.start.line && a.start.column === b.start.column &&
      a.end.line === b.end.line && a.end.column === b.end.column;
}