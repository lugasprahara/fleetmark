// fleetmark driver.
//
// The harness runs `node /bot/main.ts`. The driver reads every case from
// cases.json in the input directory (MAKEFUN_INPUT_DIR, default /input),
// renders each case on its own with parse() from ./parse.js, and writes the
// resulting HTML strings, in the cases' order, as a JSON array to html.json
// in the output directory (MAKEFUN_OUTPUT_DIR, default /output).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
