# Fleetmark

A small, dependency-free Markdown-to-HTML engine written for speed.
For every input string, `parse(markdown)` returns exactly the HTML
that marked 18.1.3 produces with its default options (GFM enabled,
no line breaks) — byte for byte — while rendering noticeably faster.

## Layout

- `parse.js` — the whole engine: block parsing, inline parsing and
  HTML rendering in one ES module with no dependencies.
- `main.ts` — the harness driver. It reads `{ id, markdown }` cases
  from `<input>/cases.json`, renders each one with `parse()`, and
  writes the HTML strings as a JSON array to `<output>/html.json`.
  The directories come from the `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` environment variables (defaults `/input` and
  `/output`).

## How it works

Parsing runs in two phases, mirroring the reference semantics:

1. **Block phase.** The document is scanned once into block tokens
   (headings, code blocks, blockquotes, lists, tables, HTML blocks,
   link reference definitions, paragraphs). Inline text is not parsed
   yet; it is queued as jobs so that every link reference definition
   in the document is known before any inline parsing happens.
2. **Inline phase.** Each queued job is scanned for escapes, code
   spans, emphasis and strong emphasis (with the reference's
   delimiter-run rules, evaluated against a masked copy of the text
   in which link destinations, code spans and tags are blanked out),
   links and images (inline, full/collapsed/shortcut references),
   autolinks, bare URLs, strikethrough and hard breaks.

The hot paths avoid re-scanning: block continuation checks work line
by line, plain text runs are consumed by a hand-written scanner, and
output is built by direct string concatenation.

## Running

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

Or from Node directly:

```js
import { parse } from './parse.js';
console.log(parse('# Hello *world*'));
```
