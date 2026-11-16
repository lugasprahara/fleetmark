// fleetmark — a fast Markdown engine that renders, byte for byte, the HTML
// that marked 18.1.3 renders with its default options (GFM on, breaks off,
// pedantic off). Written from scratch as a drop-in replacement: same output,
// less work per byte.
//
// How it is put together:
//
// - parse() normalises line endings, then a block lexer walks the input
//   once. At each block boundary it dispatches on the first character, so
//   grammar rules that cannot match there are never attempted; the heavy
//   patterns (paragraph, table, setext) run only behind a cheap line
//   pre-check that is a strict superset of what they can match.
// - Inline parsing is deferred: block tokens register their text in a queue
//   and the queue is worked off after the block pass, which is what lets a
//   link reference definition anywhere in the document resolve, exactly as
//   in marked. Emphasis matching runs against a masked copy of the text in
//   which link targets, code spans and HTML spans are blanked out; the
//   masking passes are skipped when a pre-check proves them the identity.
// - Rendering is one walk over the token tree building the output string.
//
// The grammar below encodes the CommonMark 0.31.2 and GFM 0.29 rules as
// marked 18.1.3 implements them, including marked's departures from the
// specs, because marked's output — never the spec's — is the target.

// ---------------------------------------------------------------- grammar
// Small shared patterns.

const codeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const outputLinkReplace = /\\([\[\]])/g;
const indentCodeCompensation = /^(\s+)(?:```)/;
const beginningSpace = /^\s+/;
const endingHash = /#$/;
const startingSpaceChar = /^ /;
const endingSpaceChar = / $/;
const endingSpaceTabChar = /[ \t]$/;
const nonSpaceChar = /[^ ]/;
const newLineCharGlobal = /\n/g;
const tabCharGlobal = /\t/g;
const leadingSpaceTab = /^[ \t]+/;
const multipleSpaceGlobal = /\s+/g;
const blankLine = /^[ \t]*$/;
const doubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const blockquoteStart = /^ {0,3}>/;
const blockquoteSetextReplace = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2 = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespace = /^( {0,3}>)([ \t]+)/gm;
const listIsTask = /^\[[ xX]\][ \t]+\S/;
const listReplaceTask = /^\[[ xX]\][ \t]+/;
const listTaskCheckbox = /\[[ xX]\]/;
const anyLine = /\n.*\n/;
const hrefBrackets = /^<(.*)>$/;
const tableDelimiter = /[:|]/;
const tableAlignChars = /^\||\| *$/g;
const tableRowBlankLine = /\n[ \t]*$/;
const tableAlignRight = /^ *-+: *$/;
const tableAlignCenter = /^ *:-+: *$/;
const tableAlignLeft = /^ *:-+ *$/;
const startATag = /^<a /i;
const endATag = /^<\/a>/i;
const startPreScriptTag = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracket = /^</;
const endAngleBracket = />$/;
const unicodeAlphaNumeric = /[\p{L}\p{N}]/u;
const numericCharacterReference = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericCharacterReferenceOrAmpersand =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const percentDecode = /%25/g;
const findPipe = /\|/g;
const splitPipe = / \|/;
const slashPipe = /\\\|/g;
const carriageReturn = /\r\n|\r/g;
const notSpaceStart = /^\S*/;
const endingNewline = /\n$/;

// Per-indent probe patterns used by the list machinery. The indent a probe
// is built for is clamped: a probe for indent t is compiled for
// max(0, min(3, t - 1)) leading spaces, and compiled once, then cached.
function indentFactory(build) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = build(n));
  };
}
const nextBulletProbe = indentFactory((n) => new RegExp(
  '^ {0,' + n + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
const hrProbe = indentFactory((n) => new RegExp(
  '^ {0,' + n + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
const fencesBeginProbe = indentFactory((n) => new RegExp(
  '^ {0,' + n + '}(?:```|~~~)'));
const headingBeginProbe = indentFactory((n) => new RegExp(
  '^ {0,' + n + '}#{1,6}(?:\\s|$)'));
const blockquoteBeginProbe = indentFactory((n) => new RegExp(
  '^ {0,' + n + '}>'));

// The HTML block-level tag names, shared by the HTML patterns.
const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const htmlBeginProbe = indentFactory((n) => new RegExp(
  '^ {0,' + n + '}(?:</?(?:' + TAG_NAMES + ')(?: +|$|/?>)' +
  '|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)' +
  '|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));

// ------------------------------------------------------------ block rules
const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const hrBlockRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const listRe = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const defRe = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const blockTextRe = /^[^\n]+/;
const htmlBlockRe = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i;
const lheadingRe = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const tableRe = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
const paragraphRe = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const blockquoteRe = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;

// ----------------------------------------------------------- inline rules
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const punctuationRe = /^((?![*_])[\s\p{P}\p{S}])/u;
const anyPunctuation = /\\([\p{P}\p{S}])/gu;
const anyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const emStrongLDelimRe = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const emStrongRDelimAstRe = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const emStrongRDelimUndRe = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const delLDelimRe = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const delRDelimRe = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const linkRe = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^\n \t\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const reflinkRe = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const nolinkRe = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const reflinkSearchRe = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const tagRe = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const autolinkRe = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const urlRe = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const blockSkipRe = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const inlineTextRe = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;

// ---------------------------------------------------------------------------
// Small string helpers shared by the tokenizers.
// ---------------------------------------------------------------------------

const blankLineRe = /^[ \t]*$/;

// Strip trailing repeats of one character (marked uses this for '\n').
function rtrim(str, c) {
  if (str.length === 0) return str;
  let end = str.length;
  while (end > 0 && str[end - 1] === c) end--;
  return end === str.length ? str : str.slice(0, end);
}

// Drop trailing blank lines, but only when more than one blank line trails:
// a source ending in a single blank line is returned untouched.
function trimTrailingBlankLines(src) {
  const lines = src.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && blankLineRe.test(lines[last])) last--;
  return lines.length - last <= 2 ? src : lines.slice(0, last + 1).join('\n');
}

// Scan a link destination for balanced parentheses. Returns -1 when the
// parens balance (or none occur), the index of an unmatched closer, or -2
// when openers are left dangling. Backslash escapes the next character.
function findUnbalanced(str) {
  let depth = 0;
  let firstOpen = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') {
      if (depth === 0) firstOpen = i;
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  if (depth === 0) return firstOpen === -1 ? -1 : -1;
  return -2;
}

// Expand tabs to spaces, each tab advancing to the next multiple-of-4
// column, counting code points, starting from column `startCol`.
function expandTabs(str, startCol) {
  if (!str.includes('\t')) return str;
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Fenced code: when the opening fence was indented, remove up to that much
// indentation from every content line.
const indentCodeCompensationRe = /^(\s+)(?:```)/;
const beginningSpaceRe = /^\s+/;
function fencesText(rawWhole, content) {
  const m = indentCodeCompensationRe.exec(rawWhole);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const lead = beginningSpaceRe.exec(line);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

// Split a table row into cells. Pipes preceded by an even number of
// backslashes are delimiters; escaped pipes stay in the cell text as '|'.
// The row is padded/truncated to `count` cells when a count is given.
function splitCells(row, count) {
  const cells = [];
  let current = '';
  let backslashes = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\') {
      backslashes++;
      current += c;
    } else if (c === '|') {
      if (backslashes % 2 === 0) {
        cells.push(current);
        current = '';
      } else {
        current += c;
      }
      backslashes = 0;
    } else {
      backslashes = 0;
      current += c;
    }
  }
  cells.push(current);
  // A leading/trailing empty cell comes from a leading/trailing pipe.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  return cells.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// HTML escaping in two flavours: full encoding, and the no-encode variant
// that leaves existing entity references alone.
const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeTestRe = /[&<>"']/;
const escapeReplaceRe = /[&<>"']/g;
const escapeTestNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escapeHtml(html, encode) {
  if (encode) {
    if (escapeTestRe.test(html)) {
      return html.replace(escapeReplaceRe, (ch) => escapeReplacements[ch]);
    }
  } else if (escapeTestNoEncodeRe.test(html)) {
    return html.replace(escapeReplaceNoEncodeRe, (ch) => escapeReplacements[ch]);
  }
  return html;
}

// URLs are passed through encodeURI; a literal %25 produced by encoding a
// '%' is folded back to '%' so already-encoded URLs survive.
const percentDecodeRe = /%25/g;
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(percentDecodeRe, '%');
  } catch {
    return null;
  }
}

// Numeric character references in text: decode the code point, mapping
// NUL, out-of-range values and surrogates to U+FFFD. An ampersand that does
// not open a valid reference is escaped, and a decoded '&' is written as
// '&amp;' so later escaping leaves it alone.
const numericRefTestRe = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const numericRefOrAmpRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeTextEntities(text) {
  if (!numericRefTestRe.test(text)) return text;
  return text.replace(numericRefOrAmpRe, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
      return '\uFFFD';
    }
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// ---------------------------------------------------------------------------
// Per-document state. A fresh set is created for every parse() call; the
// tokenizers below operate on whichever document is currently being lexed.
// ---------------------------------------------------------------------------

let links = Object.create(null);
let inlineQueue = [];
let lexerState = null;

function newLexerState() {
  return {
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Reference labels fold case and collapse internal whitespace runs.
const multipleSpaceGlobalRe = /\s+/g;
function normalizeLabel(label) {
  return label.trim().replace(multipleSpaceGlobalRe, ' ')
    .toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the remaining source and returns a token or
// undefined. Inline content is not parsed here; blockTokens queues it.
// ---------------------------------------------------------------------------

function spaceToken(src) {
  const cap = newlineRe.exec(src);
  if (cap && cap[0].length > 0) {
    return { type: 'space', raw: cap[0] };
  }
  return undefined;
}

const codeRemoveIndentRe = /^(?: {0,3}\t| {1,4})/gm;
function codeToken(src) {
  const cap = blockCodeRe.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'code',
    raw,
    codeBlockStyle: 'indented',
    text: raw.replace(codeRemoveIndentRe, ''),
  };
}

function fencesToken(src) {
  const cap = fencesRe.exec(src);
  if (!cap) return undefined;
  const raw = cap[0];
  return {
    type: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(anyPunctuation, '$1') : cap[2],
    text: fencesText(raw, cap[3] ?? ''),
  };
}

const endingHashRe = /#$/;
const endingSpaceTabCharRe = /[ \t]$/;
function headingToken(src) {
  const cap = headingRe.exec(src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (endingHashRe.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || endingSpaceTabCharRe.test(trimmed)) {
      text = trimmed.trim();
    }
  }
  const token = {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[1].length,
    text,
    tokens: [],
  };
  token.tokens = queueInline(text);
  return token;
}

function hrToken(src) {
  const cap = hrBlockRe.exec(src);
  if (!cap) return undefined;
  return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

const startAngleBracketRe = /^</;
function htmlToken(src) {
  const cap = htmlBlockRe.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

const hrefBracketsRe = /^<(.*)>$/;
function defToken(src) {
  const cap = defRe.exec(src);
  if (!cap) return undefined;
  if (!startAngleBracketRe.test(cap[2]) && findUnbalanced(cap[2]) !== -1) {
    return undefined;
  }
  const href = cap[2]
    ? cap[2].replace(hrefBracketsRe, '$1').replace(anyPunctuation, '$1')
    : '';
  const title = cap[3]
    ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuation, '$1')
    : cap[3];
  return {
    type: 'def',
    tag: normalizeLabel(cap[1]),
    raw: rtrim(cap[0], '\n'),
    href,
    title,
  };
}

// Queue an inline-parsing job for later; returns the token array that the
// job will fill once the whole block structure is known.
function queueInline(src, tokens = []) {
  inlineQueue.push({ src, tokens });
  return tokens;
}

const blockquoteStartRe = /^ {0,3}>/;
const blockquoteSetextReplaceRe = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2Re = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespaceRe = /^( {0,3}>)([ \t]+)/gm;

function blockquoteToken(src) {
  const cap = blockquoteRe.exec(src);
  if (!cap) return undefined;
  const lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    // One group: leading non-marker lines plus the marker lines after them,
    // stopping at the first plain line that follows a marker line.
    let inQuote = false;
    const group = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (blockquoteStartRe.test(lines[p])) {
        group.push(lines[p]);
        inQuote = true;
      } else if (!inQuote) {
        group.push(lines[p]);
      } else {
        break;
      }
    }
    const rest = lines.slice(p);
    const groupRaw = group.join('\n');
    const groupText = groupRaw
      .replace(blockquoteMarkerWhitespaceRe,
        (m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(blockquoteSetextReplaceRe, '\n    $1')
      .replace(blockquoteSetextReplace2Re, '');
    raw = raw ? raw + '\n' + groupRaw : groupRaw;
    text = text ? text + '\n' + groupText : groupText;
    const savedTop = lexerState.top;
    lexerState.top = true;
    blockTokens(groupText, tokens, true);
    lexerState.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' ||
        last.type === 'hr' || last.type === 'html' || last.type === 'table')) {
      break;
    }
    if (last && last.type === 'blockquote') {
      const joined = rest.join('\n');
      const mergedSrc = last.raw + '\n' +
        joined.replace(blockquoteSetextReplace2Re, '');
      const merged = blockquoteToken(mergedSrc);
      tokens[tokens.length - 1] = merged;
      const leftover = mergedSrc.substring(merged.raw.length)
        .replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? rest.slice(0, -leftoverCount) : rest;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      const remaining = rest.slice(consumed.length);
      if (remaining.length > 0 && blockquoteStartRe.test(remaining[0])) {
        lines.splice(0, lines.length, ...remaining);
        continue;
      }
      break;
    }
    if (last && last.type === 'list') {
      const mergedSrc = last.raw + '\n' + rest.join('\n');
      const merged = listToken(mergedSrc);
      tokens[tokens.length - 1] = merged;
      const extra = merged.raw.length > last.raw.length
        ? mergedSrc.slice(last.raw.length + 1, merged.raw.length)
            .split('\n').length
        : 0;
      if (extra > 0) {
        const consumedText = rest.slice(0, extra).join('\n');
        raw += '\n' + consumedText;
        text += '\n' + consumedText;
      }
      lines.splice(0, lines.length, ...rest.slice(extra));
      continue;
    }
    lines.splice(0, lines.length, ...rest);
  }
  return { type: 'blockquote', raw, tokens, text };
}

const tableDelimiterRe = /[:|]/;
const tableAlignCharsRe = /^\||\| *$/g;
const tableRowBlankLineRe = /\n[ \t]*$/;
const tableAlignRightRe = /^ *-+: *$/;
const tableAlignCenterRe = /^ *:-+: *$/;
const tableAlignLeftRe = /^ *:-+ *$/;

function tableToken(src) {
  const cap = tableRe.exec(src);
  if (!cap || !tableDelimiterRe.test(cap[2])) return undefined;
  const headerCells = splitCells(cap[1]);
  const alignCells = cap[2].replace(tableAlignCharsRe, '').split('|');
  const rowLines = cap[3] && cap[3].trim()
    ? cap[3].replace(tableRowBlankLineRe, '').split('\n')
    : [];
  if (headerCells.length !== alignCells.length) return undefined;
  const token = {
    type: 'table',
    raw: rtrim(cap[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };
  for (const cell of alignCells) {
    if (tableAlignRightRe.test(cell)) token.align.push('right');
    else if (tableAlignCenterRe.test(cell)) token.align.push('center');
    else if (tableAlignLeftRe.test(cell)) token.align.push('left');
    else token.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    token.header.push({
      text: headerCells[i],
      tokens: queueInline(headerCells[i]),
      header: true,
      align: token.align[i],
    });
  }
  for (const rowLine of rowLines) {
    const cells = splitCells(rowLine, token.header.length);
    token.rows.push(cells.map((cellText, j) => ({
      text: cellText,
      tokens: queueInline(cellText),
      header: false,
      align: token.align[j],
    })));
  }
  return token;
}

function lheadingToken(src) {
  const cap = lheadingRe.exec(src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(text),
  };
}

const endingNewlineRe = /\n$/;
function paragraphToken(src) {
  const cap = paragraphRe.exec(src);
  if (!cap) return undefined;
  const text = endingNewlineRe.test(cap[1]) ? cap[1].slice(0, -1) : cap[1];
  return {
    type: 'paragraph',
    raw: cap[0],
    text,
    tokens: queueInline(text),
  };
}

function blockTextToken(src) {
  const cap = blockTextRe.exec(src);
  if (!cap) return undefined;
  return {
    type: 'text',
    raw: cap[0],
    text: cap[0],
    tokens: queueInline(cap[0]),
  };
}

function firstLineOf(str) {
  const nl = str.indexOf('\n');
  return nl < 0 ? str : str.slice(0, nl);
}

// Expand the leading whitespace run of a line (tabs advance to the next
// multiple-of-4 column starting at startCol). Lines whose leading run has
// no tab are returned unchanged.
function expandLineLead(line, startCol) {
  let i = 0;
  let hasTab = false;
  while (line[i] === ' ' || line[i] === '\t') {
    if (line[i] === '\t') hasTab = true;
    i++;
  }
  if (i === 0 || !hasTab) return line;
  return expandTabs(line.slice(0, i), startCol) + line.slice(i);
}

// Item patterns are built per bullet style; cache them by pattern text.
const listItemPatternCache = new Map();
function listItemPattern(bulletPattern) {
  let re = listItemPatternCache.get(bulletPattern);
  if (re === undefined) {
    re = new RegExp('^( {0,3}' + bulletPattern + ')' +
      '((?:[\\t ][^\\n]*)?(?:\\n|$))');
    listItemPatternCache.set(bulletPattern, re);
  }
  return re;
}

function listToken(src) {
  const cap = listRe.exec(src);
  if (!cap) return undefined;
  const origSrc = src;
  let rest = src;
  const consumed = () => origSrc.length - rest.length;
  const bullet = cap[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered
    ? '\\d{1,9}\\' + bullet.slice(-1)
    : '\\' + bullet;
  const itemRe = listItemPattern(bulletPattern);
  let prevItemBlankEnd = false;
  let match = cap;
  while (rest) {
    let itemBlankEnd = false;
    let itemText = '';
    match = itemRe.exec(rest);
    if (!match || hrBlockRe.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(match[0].length);
    const firstLine = firstLineOf(match[2]);
    const bulletLen = match[1].length;
    let prevContent = expandLineLead(firstLine, bulletLen);
    let nextLine = firstLineOf(rest);
    let prevBlank = !prevContent.trim();
    let indent = 0;
    if (prevBlank) {
      indent = bulletLen + 1;
    } else {
      indent = prevContent.search(nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = prevContent.slice(indent);
      indent += bulletLen;
    }
    if (prevBlank && blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      itemBlankEnd = true;
    }
    if (!itemBlankEnd) {
      const nextBullet = nextBulletProbe(indent);
      const hrP = hrProbe(indent);
      const fencesP = fencesBeginProbe(indent);
      const headingP = headingBeginProbe(indent);
      const htmlP = htmlBeginProbe(indent);
      const quoteP = blockquoteBeginProbe(indent);
      while (rest) {
        const line = firstLineOf(rest);
        const expanded = expandLineLead(line, 0);
        if (fencesP.test(line) || headingP.test(line) || htmlP.test(line) ||
            quoteP.test(line) || nextBullet.test(line) || hrP.test(line)) {
          break;
        }
        if (expanded.search(nonSpaceChar) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          // Lazy continuation: the line belongs to the item only if the
          // previous line could not lazily absorb it.
          if (prevBlank ||
              prevContent.replace(tabCharGlobal, '    ')
                .search(nonSpaceChar) >= 4 ||
              fencesP.test(prevContent) || headingP.test(prevContent) ||
              htmlP.test(prevContent) || hrP.test(prevContent)) {
            break;
          }
          if (/^ {0,3}(?:=+|-+) *$/.test(line) &&
              lheadingRe.test(prevContent + '\n' + line)) {
            itemText += '\n    ' + expanded.replace(/^ {0,3}/, '');
          } else {
            itemText += '\n' + line;
          }
        }
        prevBlank = !line.trim();
        rest = rest.substring(line.length + 1);
        prevContent = expanded.slice(indent);
      }
    }
    const itemRaw = origSrc.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevItemBlankEnd) list.loose = true;
      else if (doubleBlankLine.test(itemRaw)) prevItemBlankEnd = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = origSrc.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    lexerState.top = false;
    item.tokens = blockTokens(item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 &&
        spaces.some((t) => anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task &&
        (first && (first.type === 'text' || first.type === 'paragraph'))) {
      item.text = item.text.replace(listReplaceTask, '');
      first.raw = first.raw.replace(listReplaceTask, '');
      first.text = first.text.replace(listReplaceTask, '');
      for (let g = inlineQueue.length - 1; g >= 0; g--) {
        if (listIsTask.test(inlineQueue[g].src)) {
          inlineQueue[g].src =
            inlineQueue[g].src.replace(listReplaceTask, '');
          break;
        }
      }
      const checkboxMatch = listTaskCheckbox.exec(item.raw);
      if (checkboxMatch) {
        const checkbox = {
          type: 'checkbox',
          raw: checkboxMatch[0] + ' ',
          checked: checkboxMatch[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (first && (first.type === 'paragraph' ||
              first.type === 'text') && first.tokens) {
            first.raw = checkbox.raw + first.raw;
            first.text = checkbox.raw + first.text;
            first.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkbox.raw,
              text: checkbox.raw,
              tokens: [checkbox],
            });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) {
        if (t.type === 'text') t.type = 'paragraph';
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// The block lexer. Tokenizers are attempted in marked's order; a cheap
// first-character guard skips any tokenizer whose grammar cannot match.
// The guards are strict supersets: they never skip a possible match.
// ---------------------------------------------------------------------------

function firstLineIsBlank(src) {
  let i = 0;
  while (src[i] === ' ' || src[i] === '\t') i++;
  return src[i] === '\n' || i === src.length;
}

function countLeadSpaces(src) {
  let i = 0;
  while (src[i] === ' ') i++;
  return i;
}

// A table can only start when the second line consists solely of delimiter
// characters (spaces, '|', ':', '-') and contains at least one '-'.
function secondLineCouldBeDelimiter(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let hasDash = false;
  for (let i = nl + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') break;
    if (c === '-') hasDash = true;
    else if (c !== ' ' && c !== '\t' && c !== '|' && c !== ':') return false;
  }
  return hasDash;
}

// A setext heading needs an underline line (up to 3 spaces, then a run of
// '=' or '-', then only blanks) somewhere before the first blank line.
function couldBeSetext(src) {
  let pos = src.indexOf('\n');
  if (pos < 0) return false;
  pos++;
  while (pos <= src.length) {
    let i = pos;
    let spaces = 0;
    while (src[i] === ' ') { i++; spaces++; }
    const ch = src[i];
    if (spaces <= 3 && (ch === '=' || ch === '-')) {
      let j = i;
      while (src[j] === ch) j++;
      let k = j;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (k === src.length || src[k] === '\n') return true;
    }
    const nl = src.indexOf('\n', pos);
    if (nl < 0) return false;
    let blank = true;
    for (let b = pos; b < nl; b++) {
      if (src[b] !== ' ' && src[b] !== '\t') { blank = false; break; }
    }
    if (blank) return false;
    pos = nl + 1;
  }
  return false;
}

function blockTokens(src, tokens, keepPrevPara = false) {
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else break;
    let token;
    const c = src[0];
    const lead = (c === ' ' || c === '\t') ? countLeadSpaces(src) : 0;
    const at = lead <= 3 ? src[lead] : undefined;

    if ((c === '\n' || c === ' ' || c === '\t') && firstLineIsBlank(src) &&
        (token = spaceToken(src))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(token);
      continue;
    }
    if ((lead >= 4 || (lead <= 3 && src[lead] === '\t')) &&
        (token = codeToken(src))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.text;
        inlineQueue[inlineQueue.length - 1].src = prev.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if ((at === '`' || at === '~') && (token = fencesToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (at === '#' && (token = headingToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((at === '-' || at === '_' || at === '*') && (token = hrToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (at === '>' && (token = blockquoteToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((at === '*' || at === '+' || at === '-' ||
         (at >= '0' && at <= '9')) && (token = listToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (at === '<' && (token = htmlToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (at === '[' && (token = defToken(src))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.raw;
        inlineQueue[inlineQueue.length - 1].src = prev.text;
      } else {
        if (!links[token.tag]) {
          links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }
    if (secondLineCouldBeDelimiter(src) && (token = tableToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (couldBeSetext(src) && (token = lheadingToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (lexerState.top && (token = paragraphToken(src))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (keepPrevPara && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.text;
        inlineQueue.pop();
        inlineQueue[inlineQueue.length - 1].src = prev.text;
      } else {
        tokens.push(token);
      }
      // Only the first paragraph of a call may continue the previous one.
      keepPrevPara = false;
      continue;
    }
    if (c !== '\n' && (token = blockTextToken(src))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.text;
        inlineQueue.pop();
        inlineQueue[inlineQueue.length - 1].src = prev.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    break;
  }
  lexerState.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline lexing. Before the token loop runs, the source is masked: link
// destinations, code spans and escapes are rewritten with placeholder
// characters so emphasis delimiter scans are not confused by their content.
// ---------------------------------------------------------------------------

function maskReflinkPart(match) {
  const lastBracket = match.lastIndexOf('[');
  if (!Object.hasOwn(links, normalizeLabel(match.slice(lastBracket + 1, -1)))) {
    return match;
  }
  if (lastBracket > 1 && match.charAt(0) !== '!') {
    const inner = match.slice(1, lastBracket - 1);
    if (linkInText(inner)) {
      return '[' + inner.replace(reflinkSearchRe, maskReflinkPart) +
        '][' + 'a'.repeat(match.length - lastBracket - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

function buildMask(src) {
  let masked = src;
  if (src.includes('[')) {
    masked = masked.replace(reflinkSearchRe, maskReflinkPart);
  }
  // The punctuation/code masking is the identity when the source holds no
  // backslash and no backtick; the block skipping is the identity when it
  // holds no '[', backtick or '<'. Skip those passes then.
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(anyPunctuationOutsideCode,
      (match, codeRun, escaped) => {
        if (escaped !== undefined) return '+'.repeat(match.length);
        if (codeRun !== undefined) {
          return codeRun +
            match.slice(codeRun.length, -codeRun.length)
              .replace(/`/g, '+') +
            codeRun;
        }
        return match;
      });
  }
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(blockSkipRe, (match, pre, keep) => {
      const keepLen = keep ? keep.length : 0;
      return match.slice(0, keepLen) + '[' +
        'a'.repeat(match.length - keepLen - 2) + ']';
    });
  }
  return masked;
}

// Does this text contain a complete link (inline or reference) anywhere?
// Used to decide whether a would-be reference link's label may itself
// contain link syntax.
function linkInText(src) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(blockSkipRe)) {
    if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(reflinkSearchRe)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' ||
          !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1)))) {
      return true;
    }
  }
  return false;
}

// Scan a masked string for the last index at which an emphasis or
// strikethrough closer run may start, per delimiter character.
function scanMaskInfo(masked) {
  const emClose = { '*': -1, '_': -1 };
  let delClose = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' &&
        prev !== '\r' && prev !== '\f') {
      if (ch === '~') delClose = i;
      else emClose[ch] = i;
    }
    i = j - 1;
  }
  return { emClose, delClose };
}

// ---------------------------------------------------------------------------
// Inline tokenizers.
// ---------------------------------------------------------------------------

function escapeToken(src) {
  const cap = escapeRe.exec(src);
  if (!cap) return undefined;
  return { type: 'escape', raw: cap[0], text: cap[1] };
}

const startATagRe = /^<a /i;
const endATagRe = /^<\/a>/i;
const startPreScriptTagRe = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTagRe = /^<\/(pre|code|kbd|script)(\s|>)/i;

function tagToken(src) {
  const cap = tagRe.exec(src);
  if (!cap) return undefined;
  const inLink = lexerState.inLink;
  if (startATagRe.test(src)) lexerState.inLink = true;
  else if (endATagRe.test(src)) lexerState.inLink = false;
  const inRawBlock = lexerState.inRawBlock;
  if (startPreScriptTagRe.test(src)) lexerState.inRawBlock = true;
  else if (endPreScriptTagRe.test(src)) lexerState.inRawBlock = false;
  return {
    type: 'html',
    raw: cap[0],
    inLink,
    inRawBlock,
    block: false,
    text: cap[0],
  };
}

const newLineCharGlobalRe = /\n/g;
function codespanToken(src) {
  const cap = inlineCodeRe.exec(src);
  if (!cap) return undefined;
  let text = cap[2].replace(newLineCharGlobalRe, ' ');
  const hasNonSpace = nonSpaceChar.test(text);
  const hasSpaceChars = startingSpaceChar.test(text) && endingSpaceChar.test(text);
  if (hasNonSpace && hasSpaceChars) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: cap[0], text };
}

function brToken(src) {
  const cap = brRe.exec(src);
  if (!cap) return undefined;
  return { type: 'br', raw: cap[0] };
}

function autolinkToken(src) {
  const cap = autolinkRe.exec(src);
  if (!cap) return undefined;
  const text = cap[1];
  const href = cap[2] === '@' ? 'mailto:' + text : text;
  return {
    type: 'link',
    raw: cap[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function urlToken(src) {
  const cap = urlRe.exec(src);
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = backpedalRe.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return {
    type: 'link',
    raw: cap[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function inlineTextToken(src) {
  const cap = inlineTextRe.exec(src);
  if (!cap) return undefined;
  const inRaw = lexerState.inRawBlock;
  return {
    type: 'text',
    raw: cap[0],
    text: inRaw ? cap[0] : decodeTextEntities(cap[0]),
    escaped: inRaw,
  };
}

// A link label that contains a complete tag or autolink reaching past the
// label's end invalidates the link (the '<' started something bigger).
function labelContainsLink(src, label, textStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      const m = inlineCodeRe.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (c !== '<') continue;
    const rest = src.slice(textStart + i);
    const m = tagRe.exec(rest) || autolinkRe.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

const outputLinkReplaceRe = /\\([\[\]])/g;

// Build a link/image token, tokenizing the label text. A link whose label
// itself emitted a link is rejected (links cannot nest); images may.
function makeLink(cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(outputLinkReplaceRe, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = lexerState.inLink;
  const savedEmitted = lexerState.linkEmitted;
  const savedRawBlock = lexerState.inRawBlock;
  lexerState.inLink = true;
  lexerState.linkEmitted = false;
  const tokens = inlineTokens(text);
  const innerEmitted = lexerState.linkEmitted;
  lexerState.linkEmitted = savedEmitted;
  lexerState.inLink = savedInLink;
  if (!isImage) {
    if (innerEmitted) {
      lexerState.inRawBlock = savedRawBlock;
      return undefined;
    }
    lexerState.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

const endAngleBracketRe = />$/;
function linkToken(src) {
  if (lexerState.linkParenPossible === false) return undefined;
  const cap = linkRe.exec(src);
  if (!cap) return undefined;
  const textStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelContainsLink(src, cap[1], textStart)) return undefined;
  let href = cap[2].trim();
  if (startAngleBracketRe.test(href)) {
    if (!endAngleBracketRe.test(href)) return undefined;
    const trimmed = rtrim(href.slice(0, -1), '\\');
    if ((href.length - trimmed.length) % 2 === 0) return undefined;
  } else {
    const extra = findUnbalanced(cap[2]);
    if (extra === -2) return undefined;
    if (extra > -1) {
      const end = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + extra;
      cap[2] = cap[2].substring(0, extra);
      cap[0] = cap[0].substring(0, end).trim();
      cap[3] = '';
    }
  }
  const rawTrimmed = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - rawTrimmed.length) % 2 === 0) return undefined;
  let finalHref = cap[2].trim();
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  if (startAngleBracketRe.test(finalHref)) {
    finalHref = finalHref.slice(1, -1);
  }
  return makeLink(cap, {
    href: finalHref && finalHref.replace(anyPunctuation, '$1'),
    title: title && title.replace(anyPunctuation, '$1'),
  }, cap[0]);
}

function reflinkToken(src) {
  let cap = reflinkRe.exec(src);
  if (!cap) cap = nolinkRe.exec(src);
  if (!cap) return undefined;
  const textStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelContainsLink(src, cap[1], textStart)) return undefined;
  const link = links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const firstChar = cap[0].charAt(0);
    return { type: 'text', raw: firstChar, text: firstChar };
  }
  return makeLink(cap, link, cap[0]);
}

function emStrongToken(src, masked, prevChar, maskInfo) {
  const cap = emStrongLDelimRe.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
  const delim = cap[0][0];
  const prevIsDelim = prevChar === delim;
  const offset = masked.length - src.length;
  let runStart = offset;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeRun = masked.slice(Math.max(0, runStart - 2), runStart);
  const prevPoint = [...beforeRun].at(-1) ?? '';
  const prevIsPunct = prevPoint === '*' || prevPoint === '_' ||
    !!punctuationRe.exec(prevPoint);
  let effectivePrev = prevChar;
  if (runStart < offset) effectivePrev = prevPoint;
  const prevPunct = runStart < offset
    ? prevIsPunct
    : !!punctuationRe.exec(effectivePrev);
  if (cap[4] && unicodeAlphaNumeric.test(effectivePrev)) return undefined;
  const nextChar = cap[1] || cap[3] || '';
  if (!nextChar || !effectivePrev || prevPunct) {
    const openerLen = [...cap[0]].length - 1;
    let remaining = openerLen;
    let ignored = 0;
    const totalRun = offset - runStart + openerLen;
    const canPartial = !!prevPoint.trim() &&
      (!!nextChar || (delim === '*' && !prevIsPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const rDelim = delim === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
    const lastCloser = maskInfo.emClose[delim];
    const afterOpener = offset + openerLen;
    if (lastCloser < afterOpener) return undefined;
    const rest = masked.slice(offset + openerLen);
    const limit = lastCloser - afterOpener;
    let m;
    rDelim.lastIndex = 0;
    while ((m = rDelim.exec(rest)) !== null && !(m.index > limit)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      const len = [...g].length;
      if (m[3] || m[4]) {
        remaining += len;
        continue;
      }
      if (m[5] || m[6] || canPartial) {
        if (prevIsDelim && (m[5] || m[6])) break;
        if (totalRun % 3 && !((totalRun + len) % 3)) {
          ignored += len;
          continue;
        }
      }
      remaining -= len;
      if (remaining > 0) continue;
      const useLen = Math.min(len, len + remaining + ignored);
      const firstPointLen = [...m[0]][0].length;
      const raw = src.slice(0, openerLen + m.index + firstPointLen + useLen);
      if (Math.min(openerLen, useLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(text) };
    }
  }
  return undefined;
}

function delToken(src, masked, prevChar, maskInfo) {
  const cap = delLDelimRe.exec(src);
  if (!cap) return undefined;
  if (!(cap[1] || '') || !prevChar || punctuationRe.exec(prevChar)) {
    const openerLen = [...cap[0]].length - 1;
    let remaining = openerLen;
    const lastCloser = maskInfo.delClose;
    const afterOpener = masked.length - src.length + openerLen;
    if (lastCloser < afterOpener) return undefined;
    const rest = masked.slice(masked.length - src.length + openerLen);
    const limit = lastCloser - afterOpener;
    let m;
    delRDelimRe.lastIndex = 0;
    while ((m = delRDelimRe.exec(rest)) !== null && !(m.index > limit)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      let len = [...g].length;
      if (len !== openerLen) continue;
      if (m[3] || m[4]) {
        remaining += len;
        continue;
      }
      remaining -= len;
      if (remaining > 0) continue;
      len = Math.min(len, len + remaining);
      const firstPointLen = [...m[0]][0].length;
      const raw = src.slice(0, openerLen + m.index + firstPointLen + len);
      const text = raw.slice(openerLen, -openerLen);
      return { type: 'del', raw, text, tokens: inlineTokens(text) };
    }
  }
  return undefined;
}

function inlineTokens(src, tokens = []) {
  const saved = lexerState.linkParenPossible;
  lexerState.linkParenPossible = saved && src.includes(')');
  try {
    return inlineLoop(src, tokens);
  } finally {
    lexerState.linkParenPossible = saved;
  }
}

// The inline token loop. Tokenizers are attempted in marked's order; the
// first-character dispatch below only skips tokenizers whose grammar
// cannot match at the current character.
function inlineLoop(src, tokens) {
  let masked = src;
  let maskInfo = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = buildMask(src);
  }
  let prevChar = '';
  let keepPrev = false;
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else break;
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    let token;
    const c = src[0];
    if (c === '\\') {
      if (token = escapeToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = brToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '<') {
      if (token = tagToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = autolinkToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '[' || c === '!') {
      if (token = linkToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = reflinkToken(src)) {
        src = src.substring(token.raw.length);
        const prev = tokens[tokens.length - 1];
        if (token.type === 'text' && prev && prev.type === 'text') {
          prev.raw += token.raw;
          prev.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    } else if (c === '*' || c === '_') {
      if (token = emStrongToken(src, masked, prevChar,
          maskInfo ?? (maskInfo = scanMaskInfo(masked)))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '`') {
      if (token = codespanToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '~') {
      if (token = delToken(src, masked, prevChar,
          maskInfo ?? (maskInfo = scanMaskInfo(masked)))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === ' ') {
      if (token = brToken(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (!lexerState.inLink &&
        ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c === '.' || c === '+' || c === '-' ||
         c === '_') &&
        (token = urlToken(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (token = inlineTextToken(src)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrev = true;
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += token.raw;
        prev.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    break;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering: a fused walk over the token tree producing marked's HTML.
// ---------------------------------------------------------------------------

const notSpaceStartRe = /^\S*/;

function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) out += renderBlock(token);
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const token of tokens) out += renderInlineToken(token);
  return out;
}

// Plain-text rendering, used for image alt attributes.
function renderTextOnly(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderTextOnly(token.tokens) : token.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += token.text;
        break;
      case 'checkbox':
        out += token.raw;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderBlock(token) {
  switch (token.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return '<h' + token.depth + '>' + renderInline(token.tokens) +
        '</h' + token.depth + '>\n';
    case 'code': {
      const langString = (token.lang || '').match(notSpaceStartRe)?.[0];
      const code = token.text
        ? token.text.replace(endingNewlineRe, '') + '\n'
        : '';
      const body = token.escaped ? code : escapeHtml(code, true);
      if (!langString) return '<pre><code>' + body + '</code></pre>\n';
      return '<pre><code class="language-' + escapeHtml(langString) +
        '">' + body + '</code></pre>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + renderTokens(token.tokens) + '</blockquote>\n';
    case 'html':
      return token.text;
    case 'paragraph':
      return '<p>' + renderInline(token.tokens) + '</p>\n';
    case 'list': {
      let body = '';
      for (const item of token.items) {
        body += '<li>' + renderTokens(item.tokens) + '</li>\n';
      }
      const type = token.ordered ? 'ol' : 'ul';
      const startAttr = token.ordered && token.start !== 1
        ? ' start="' + token.start + '"'
        : '';
      return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
    }
    case 'table': {
      let headerCells = '';
      for (const cell of token.header) headerCells += renderTableCell(cell);
      let body = '';
      for (const row of token.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell);
        body += '<tr>\n' + cells + '</tr>\n';
      }
      if (body) body = '<tbody>' + body + '</tbody>';
      return '<table>\n<thead>\n<tr>\n' + headerCells + '</tr>\n</thead>\n' +
        body + '</table>\n';
    }
    case 'text':
    case 'checkbox':
      return renderInlineToken(token);
    default:
      return '';
  }
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align
    ? '<' + tag + ' align="' + cell.align + '">'
    : '<' + tag + '>';
  return open + renderInline(cell.tokens) + '</' + tag + '>\n';
}

function renderInlineToken(token) {
  switch (token.type) {
    case 'escape':
      return escapeHtml(token.text);
    case 'html':
      return token.text;
    case 'strong':
      return '<strong>' + renderInline(token.tokens) + '</strong>';
    case 'em':
      return '<em>' + renderInline(token.tokens) + '</em>';
    case 'del':
      return '<del>' + renderInline(token.tokens) + '</del>';
    case 'codespan':
      return '<code>' + escapeHtml(token.text, true) + '</code>';
    case 'br':
      return '<br>';
    case 'checkbox':
      return '<input ' + (token.checked ? 'checked="" ' : '') +
        'disabled="" type="checkbox"> ';
    case 'link': {
      const content = token.autolink
        ? escapeHtml(token.text, true)
        : renderInline(token.tokens);
      const cleaned = cleanUrl(token.href);
      if (cleaned === null) return content;
      let out = '<a href="' + escapeHtml(cleaned, token.autolink) + '"';
      if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
      return out + '>' + content + '</a>';
    }
    case 'image': {
      const alt = token.tokens ? renderTextOnly(token.tokens) : token.text;
      const cleaned = cleanUrl(token.href);
      if (cleaned === null) return escapeHtml(alt);
      let out = '<img src="' + escapeHtml(cleaned) + '" alt="' +
        escapeHtml(alt) + '"';
      if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
      return out + '>';
    }
    case 'text':
      if (token.tokens) return renderInline(token.tokens);
      return token.escaped ? token.text : escapeHtml(token.text);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const carriageReturnRe = /\r\n|\r/g;

export function parse(markdown) {
  const src = String(markdown).replace(carriageReturnRe, '\n');
  links = Object.create(null);
  inlineQueue = [];
  lexerState = newLexerState();
  const tokens = blockTokens(src, []);
  for (let i = 0; i < inlineQueue.length; i++) {
    const job = inlineQueue[i];
    lexerState.inRawBlock = false;
    inlineTokens(job.src, job.tokens);
  }
  inlineQueue = [];
  return renderTokens(tokens);
}
