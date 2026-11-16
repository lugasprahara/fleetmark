// Fleetmark driver for the markdown-render-speed-02 harness.
//
// The harness runs `node /bot/main.ts` (Node 22). This driver reads
// every case from <input>/cases.json — a JSON array of
// { id, markdown } — renders each Markdown string on its own with
// parse() from ./parse.js, and writes the resulting HTML strings to
// <output>/html.json as a JSON array in the same order as the cases.
// The input/output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR, defaulting to /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
