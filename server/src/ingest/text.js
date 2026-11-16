'use strict';

/**
 * Text normalization for the ingest layer.
 *
 * The records view renders a task's "output summary" as Markdown (see the `md()` helper in
 * renderer/src/views/TaskRecordsView.vue). Markdown is line-oriented: a heading, a list item and a
 * code fence only mean something when they start a line. So a free-text result has to reach the
 * database with its line structure intact — collapsing every whitespace run into one space (as
 * normText() in ingest/bus.js does for single-line fields) turns the whole summary into one
 * paragraph and the Markdown renderer has nothing left to work with.
 */

/**
 * Normalize a multi-line free-text field while keeping its line structure.
 *
 *   · CRLF / lone CR become LF;
 *   · trailing blanks on each line are dropped (they render as nothing);
 *   · a run of blank lines collapses to a single blank line (paragraph spacing, not a screen of gaps);
 *   · leading / trailing blank lines are trimmed, but the first line's indentation is kept (it may
 *     open an indented code block);
 *   · the text is then cut to `max` characters.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null} null when the normalized text is empty
 */
function normalizeMultiline(value, max) {
  const s = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return s ? s.slice(0, max) : null;
}

module.exports = { normalizeMultiline };
