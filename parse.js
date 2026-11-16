// Fleetmark — a dependency-free Markdown renderer.
//
// Fleetmark renders Markdown to exactly the HTML that marked 18.1.3
// produces with its default options (GFM enabled, breaks off, pedantic
// off). It is an original implementation written for speed: a line-aware
// block scanner produces a token tree while collecting link reference
// definitions, then a single-pass inline scanner renders each block's
// text. Inline work is deferred until the whole document's blocks are
// known, so link references resolve no matter where they are defined.
//
// No dependencies; runs anywhere Node 22+ runs.

'use strict';

// ---------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape the five HTML-significant characters. With `encode` false, an
// ampersand that already begins a character reference (&#123;, &#x1F; or
// &name;) is left alone, matching the reference renderer's behaviour.
function escapeHtml(text, encode) {
  if (encode) {
    return /[&<>"']/.test(text)
      ? text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
      : text;
  }
  // Cheap class pre-test before the lookahead-bearing pattern.
  if (!/[<>"'&]/.test(text)) return text;
  return /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(text)
    ? text.replace(
        /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
        (ch) => HTML_ESCAPES[ch],
      )
    : text;
}

const NUMERIC_REF_TEST = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;

// Inline text preprocessing: numeric character references are decoded
// to the characters they name (NUL, surrogates and out-of-range values
// become U+FFFD; &#38; becomes the literal text "&amp;"), and a stray
// ampersand that does not start a reference is written as &amp;.
function decodeNumericRefs(text) {
  if (!text.includes('&#')) return text;
  if (!NUMERIC_REF_TEST.test(text)) return text;
  return text.replace(
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
    (match, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return '�';
      }
      if (cp === 38) return '&amp;';
      return String.fromCodePoint(cp);
    },
  );
}

// URLs in href/src attributes go through encodeURI (which leaves most
// characters alone); a literal % is preserved by undoing %25 afterwards.
// Returns null when the URL cannot be encoded (lone surrogates).
// Characters encodeURI leaves untouched (plus % itself, handled by
// the %25 rule below).
const URL_SAFE_RE = /^[\w\-!~*'();/?:@&=+$.,#%]*$/;
function cleanUrl(href) {
  // Fast path: nothing to encode and no %25 to collapse.
  if (URL_SAFE_RE.test(href) && !href.includes('%25')) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Link labels are compared case-insensitively with whitespace runs
// collapsed. The lower->upper->lower pass mirrors Unicode default case
// folding for characters such as ß.
function normalizeLabel(label) {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// Scan a string for a bracket pair, skipping backslash-escaped chars.
// Returns the index where the depth first goes negative, -2 when the
// string ends with unclosed openers, and -1 when balanced or when
// neither bracket occurs at all.
function bracketBalance(text, open, close) {
  if (!text.includes(open) && !text.includes(close)) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Remove a trailing run of one character (used for '\n' and '#').
// With `invert`, removes a trailing run of characters != ch instead.
function rtrimChar(text, ch, invert) {
  let count = 0;
  while (count < text.length) {
    const c = text.charAt(text.length - count - 1);
    if (invert ? c !== ch : c === ch) count++;
    else break;
  }
  return count === 0 ? text : text.slice(0, text.length - count);
}

// Expand tabs to spaces with tab stops every 4 columns, counting from
// the given starting column. Iterates by code point, like the reference.
function expandTabs(text, startColumn) {
  let column = startColumn || 0;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const width = 4 - (column % 4);
      out += ' '.repeat(width);
      column += width;
    } else {
      out += ch;
      column++;
    }
  }
  return out;
}

// Code and HTML block raw text keeps at most one trailing blank line:
// when two or more blank lines trail, all of them are dropped.
function dropExcessTrailingBlankLines(raw) {
  const lines = raw.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  if (lines.length - last <= 2) return raw;
  return lines.slice(0, last + 1).join('\n');
}

// Split a table row into cells. An unescaped '|' is a cell boundary; a
// backslash-escaped pipe stays in the cell and loses its backslash.
// The first/last empty cells produced by edge pipes are dropped, and
// the row is truncated or padded to `count` cells when count is given.
function splitTableCells(row, count) {
  // Fast path: with no backslash anywhere, no pipe is escaped, so the
  // cells are exactly the '|'-separated parts (the general path below
  // rewrites each unescaped '|' to ' |' and splits on ' |', which
  // yields the same parts after trimming).
  if (!row.includes('\\')) {
    const cells = row.split('|');
    if (cells.length > 0 && !cells[0].trim()) cells.shift();
    if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
    if (count !== undefined) {
      if (cells.length > count) cells.splice(count);
      while (cells.length < count) cells.push('');
    }
    for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim();
    return cells;
  }
  let spaced = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch !== '|') {
      spaced += ch;
      continue;
    }
    let slashes = 0;
    for (let j = i - 1; j >= 0 && row[j] === '\\'; j--) slashes++;
    spaced += slashes % 2 === 1 ? '|' : ' |';
  }
  const cells = spaced.split(' |');
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Unescape backslash-escaped punctuation (\" -> ", \\ -> \, ...).
const ESCAPED_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(text) {
  if (!text.includes('\\')) return text;
  return text.replace(ESCAPED_PUNCT, '$1');
}

// ---------------------------------------------------------------------
// Character classes (Unicode-aware, matching the reference grammar)
// ---------------------------------------------------------------------

const PUNCT_SPACE_RE = /^[\s\p{P}\p{S}]$/u; // whitespace, punctuation or symbol
const PUNCT_SYMBOL_RE = /^[\p{P}\p{S}]$/u; // punctuation or symbol
const ALNUM_RE = /[\p{L}\p{N}]/u;

// Is this code point a JS \s whitespace?
function isSpaceCp(cp) {
  if (cp < 128) return cp === 32 || (cp >= 9 && cp <= 13);
  return (
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000 ||
    cp === 0xfeff
  );
}

// Is this code point a Unicode punctuation or symbol (\p{P}\p{S})?
// Every printable ASCII character that is not alphanumeric is one,
// so only non-ASCII characters need the regex.
function isPunctSymbolCp(cp, ch) {
  if (cp < 128) {
    return (
      cp >= 33 &&
      cp <= 126 &&
      !((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122))
    );
  }
  return PUNCT_SYMBOL_RE.test(ch);
}

// Is this single-code-point string a Unicode letter or number?
function isAlnumChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  if (cp < 128) {
    return (
      (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)
    );
  }
  return ALNUM_RE.test(ch);
}

// The reference's "punctuation" test for the character before a
// delimiter run: a whitespace/punctuation/symbol char that is not one
// of the emphasis delimiters themselves.
function isPunctSpaceNotDelim(ch) {
  if (!ch || ch === '*' || ch === '_') return false;
  const cp = ch.codePointAt(0);
  if (cp < 128) return isSpaceCp(cp) || isPunctSymbolCp(cp, ch);
  return PUNCT_SPACE_RE.test(ch);
}

// Is this char a Unicode whitespace (JS \s)?
function isSpaceChar(ch) {
  return ch !== undefined && /\s/.test(ch);
}

// ---------------------------------------------------------------------
// Shared grammar constants
// ---------------------------------------------------------------------

// Block-level HTML tag names (the CommonMark block tag list).
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|' +
  'colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|' +
  'footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|' +
  'link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|' +
  'search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp('^(?:' + BLOCK_TAGS + ')');
const RAW_TEXT_TAGS = ['script', 'pre', 'style', 'textarea'];

const BLANK_LINE_RE = /^[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

// ---------------------------------------------------------------------
// Inline parsing
//
// State shared by every inline pass of one document, mirroring the
// reference: whether we are inside a link's text (no nested links, no
// bare-URL autolinking), inside a raw HTML element (text stays raw),
// and whether a link has been emitted inside the current link text.
// ---------------------------------------------------------------------

let LINKS; // normalized label -> { href, title }
let DEFS_EXIST = false; // whether any link reference definition registered
let JOBS; // deferred inline jobs: { src, tokens }
let STATE; // { inLink, inRawBlock, linkEmitted, top }

function queueInline(text) {
  const job = { src: text, tokens: [] };
  JOBS.push(job);
  return job;
}

// --- Emphasis masking -------------------------------------------------
// Before inline scanning, a masked copy of the text is made (same
// length) in which link destinations, code spans and HTML tags are
// blanked out, so that delimiter runs inside them are not mistaken for
// emphasis closers. The mask also yields, for each delimiter char, the
// last position at which a closing run could start.

const BRACKET_NEST = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LINK_LABEL =
  '(?:\\[(?:' +
  BRACKET_NEST +
  '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF_CONTENT = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const SEARCH_REF = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const SEARCH_LABEL =
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:' +
  BRACKET_NEST +
  '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';

const REFLINK_SEARCH_RE = new RegExp(
  '!?\\[(' + SEARCH_LABEL + ')\\]\\[(' + SEARCH_REF + ')\\]|!?\\[(' + SEARCH_REF + ')\\](?:\\[\\])?(?!\\()',
  'g',
);
const BLOCK_SKIP_RE =
  /\[(?:[^\[\]`]|(?<qa>`+)[^`]+\k<qa>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<qb>`+)[^`]+\k<qb>(?!`)|<(?! )[^<>]*?>/g;
const ESC_OR_CODE_RE =
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

const LINK_RE = new RegExp(
  '^!?\\[(' +
    LINK_LABEL +
    ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)',
);
const REFLINK_RE = new RegExp(
  '^!?\\[(' + LINK_LABEL + ')\\]\\[(' + REF_CONTENT + ')\\]',
);
const NOLINK_RE = new RegExp('^!?\\[(' + REF_CONTENT + ')\\](?:\\[\\])?');

// Does this text contain a complete link (used by the mask logic)?
function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const match = m[0];
    const open = match.lastIndexOf('[');
    const known = Object.hasOwn(
      LINKS,
      normalizeLabel(match.slice(open + 1, -1)),
    );
    if (
      !(match.charAt(0) === '!' || !known) &&
      !(open > 1 && linkInText(match.slice(1, open - 1)))
    ) {
      return true;
    }
  }
  return false;
}

function maskReflink(match) {
  const open = match.lastIndexOf('[');
  if (!Object.hasOwn(LINKS, normalizeLabel(match.slice(open + 1, -1)))) {
    return match;
  }
  if (open > 1 && match.charAt(0) !== '!') {
    const inner = match.slice(1, open - 1);
    if (linkInText(inner)) {
      return (
        '[' +
        inner.replace(REFLINK_SEARCH_RE, maskReflink) +
        '][' +
        'a'.repeat(match.length - open - 2) +
        ']'
      );
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

function buildMask(src) {
  let t = src;
  if (src.includes('[') && DEFS_EXIST) {
    t = t.replace(REFLINK_SEARCH_RE, maskReflink);
  }
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(ESC_OR_CODE_RE, (whole, codeRun, escPunct) => {
      if (escPunct !== undefined) return '+'.repeat(whole.length);
      if (codeRun !== undefined) {
        // The interior backticks must be blanked; a plain span whose
        // interior holds no backtick (the first backtick after the
        // opening run is the closing run itself) needs no rebuild.
        const innerEnd = whole.length - codeRun.length;
        if (whole.indexOf('`', codeRun.length) >= innerEnd) return whole;
        return (
          codeRun +
          whole.slice(codeRun.length, innerEnd).replace(/`/g, '+') +
          codeRun
        );
      }
      return whole;
    });
  }
  // The block-skip pass can only match an inline link (needs ']('),
  // a code span (needs '`') or a tag (needs '<'); the earlier passes
  // never create those characters, so when none is present in the
  // text the pass is a no-op and can be skipped.
  if (t.includes('](') || t.includes('`') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (whole) => '[' + 'a'.repeat(whole.length - 2) + ']');
  }
  return t;
}

// The last index in the masked text where a run of `delim` starts and
// the preceding char is not whitespace — the last place a closing
// delimiter could live. Computed lazily per delimiter (most inline
// runs only ever need one of the three), by walking runs backwards
// from the last occurrence.
function lastCloserPos(masked, delim) {
  let i = masked.lastIndexOf(delim);
  while (i !== -1) {
    let s = i;
    while (s > 0 && masked[s - 1] === delim) s--;
    if (s === 0) return 0;
    const prev = masked[s - 1];
    if (
      prev !== ' ' &&
      prev !== '\t' &&
      prev !== '\n' &&
      prev !== '\r' &&
      prev !== '\f'
    ) {
      return s;
    }
    i = masked.lastIndexOf(delim, s - 1);
  }
  return -1;
}

// Resolve the last-closer position for `delim` from the per-scan
// cache (values are -2 while unknown, then a position or -1).
function closerFor(closers, masked, delim) {
  let pos = closers[delim];
  if (pos === -2) {
    pos = lastCloserPos(masked, delim);
    closers[delim] = pos;
  }
  return pos;
}

// --- Individual inline tokenizers ------------------------------------
// Each takes the remaining source and returns a token or null.

const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
function tokEscape(rest) {
  const cap = ESCAPE_RE.exec(rest);
  return cap ? { type: 'escape', raw: cap[0], text: cap[1] } : null;
}

const TAG_RE =
  /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/;
const START_A_RE = /^<a /i;
const END_A_RE = /^<\/a>/i;
const START_RAW_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

function tokTag(rest) {
  const cap = TAG_RE.exec(rest);
  if (!cap) return null;
  const raw = cap[0];
  if (!STATE.inLink && START_A_RE.test(raw)) STATE.inLink = true;
  else if (STATE.inLink && END_A_RE.test(raw)) STATE.inLink = false;
  if (!STATE.inRawBlock && START_RAW_RE.test(raw)) STATE.inRawBlock = true;
  else if (STATE.inRawBlock && END_RAW_RE.test(raw)) STATE.inRawBlock = false;
  return { type: 'html', raw, text: raw };
}

// A link whose label contains an unescaped '<' is invalid when a tag
// or autolink starting inside the label would run past the label's end.
const CODESPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
function labelHasLongTag(src, label, labelOffset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    const ch = label[s];
    if (ch === '\\') {
      s++;
      continue;
    }
    if (ch === '`') {
      const code = CODESPAN_RE.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (ch !== '<') continue;
    const tail = src.slice(labelOffset + s);
    const tag = TAG_RE.exec(tail) || AUTOLINK_RE.exec(tail);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, tokenizing the label text. A link whose
// text itself emits a link is rejected (links cannot nest); images are
// exempt. Returns null when rejected.
function outputLink(cap, href, title, raw) {
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = raw.charAt(0) === '!';
  const savedInLink = STATE.inLink;
  const savedEmitted = STATE.linkEmitted;
  const savedRaw = STATE.inRawBlock;
  STATE.inLink = true;
  STATE.linkEmitted = false;
  const tokens = inlineTokens(text, []);
  const emitted = STATE.linkEmitted;
  STATE.linkEmitted = savedEmitted;
  STATE.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      STATE.inRawBlock = savedRaw;
      return null;
    }
    STATE.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title: title || null,
    text,
    tokens,
  };
}

function tokLink(rest) {
  if (!STATE.linkParenPossible) return null;
  // Native pre-gate: an inline link needs the literal ']('.
  if (!rest.includes('](')) return null;
  const cap = LINK_RE.exec(rest);
  if (!cap) return null;
  const isImage = cap[0].charAt(0) === '!';
  if (labelHasLongTag(rest, cap[1], isImage ? 2 : 1)) return null;
  const hrefPart = cap[2].trim();
  if (hrefPart.startsWith('<')) {
    if (!hrefPart.endsWith('>')) return null;
    const stripped = rtrimChar(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - stripped.length) % 2 === 0) return null;
  } else {
    const balance = bracketBalance(cap[2], '(', ')');
    if (balance === -2) return null;
    if (balance > -1) {
      const cut = (isImage ? 5 : 4) + cap[1].length + balance;
      cap[2] = cap[2].substring(0, balance);
      cap[0] = cap[0].substring(0, cut).trim();
      cap[3] = '';
    }
  }
  const beforeClose = rtrimChar(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - beforeClose.length) % 2 === 0) return null;
  let href = cap[2].trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  return outputLink(
    cap,
    href ? unescapePunct(href) : href,
    title ? unescapePunct(title) : title,
    cap[0],
  );
}

function tokReflink(rest) {
  // Native pre-gate: a full reference link needs the literal '][';
  // without it only the collapsed/shortcut form can match.
  const cap =
    (rest.includes('][') ? REFLINK_RE.exec(rest) : null) ||
    NOLINK_RE.exec(rest);
  if (!cap) return null;
  const isImage = cap[0].charAt(0) === '!';
  if (labelHasLongTag(rest, cap[1], isImage ? 2 : 1)) return null;
  const def = LINKS[normalizeLabel(cap[2] || cap[1])];
  if (!def) {
    const first = cap[0].charAt(0);
    return { type: 'text', raw: first, text: first };
  }
  return outputLink(cap, def.href, def.title, cap[0]);
}

// --- Emphasis and strikethrough ---------------------------------------
// The opener is classified by the character that follows its run and
// the character before it; closers are found by scanning the masked
// text with context-sensitive run patterns, keeping a running "debt"
// of delimiter length that inner openers increase and closers repay.
// This reproduces the reference's delimiter-run semantics, including
// its rule-of-three check for embedded openers.

// The closer scans run in place over the full masked text. Each
// pattern's first alternative is anchored to the scan start and
// captures nothing (a match only advances the scan), so it is split
// off as a sticky probe tried once at the scan position; the main
// patterns keep the remaining alternatives (group numbering is
// unchanged: the first alternatives contain no capture groups).
const EM_ALT1_AST_RE = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/uy;
const EM_ALT1_UND_RE = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/uy;
const EM_RDELIM_AST_RE =
  /[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND_RE =
  /[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;

function tokEmStrong(rest, masked, prevChar, closers) {
  // Hand-rolled opener classification (was EM_LDELIM_RE): the run of
  // delimiters at the start of rest, then the code point after it —
  // afterPunct when it is a punctuation/symbol other than the
  // delimiter and '~', afterOther when it is any other non-whitespace
  // char. Both empty (run at end of text or followed by whitespace)
  // means no emphasis can start here.
  const delim = rest[0];
  let openerRun = 0;
  while (rest[openerRun] === delim) openerRun++;
  let afterPunct = '';
  let afterOther = '';
  const cpAfter = rest.codePointAt(openerRun);
  if (cpAfter !== undefined && !isSpaceCp(cpAfter)) {
    const chAfter = String.fromCodePoint(cpAfter);
    if (
      chAfter !== delim &&
      chAfter !== '~' &&
      isPunctSymbolCp(cpAfter, chAfter)
    ) {
      afterPunct = chAfter;
    } else {
      afterOther = chAfter;
    }
  }
  if (!afterPunct && !afterOther) return null;
  const sameAsPrev = prevChar === delim;
  const posInFull = masked.length - rest.length;
  let runStart = posInFull;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  // Last code point before the run (surrogate-aware), without spreading.
  let before = '';
  if (runStart > 0) {
    const c1 = masked.charCodeAt(runStart - 1);
    if (c1 >= 0xdc00 && c1 <= 0xdfff && runStart > 1) {
      const c0 = masked.charCodeAt(runStart - 2);
      before =
        c0 >= 0xd800 && c0 <= 0xdbff
          ? masked.slice(runStart - 2, runStart)
          : masked[runStart - 1];
    } else {
      before = masked[runStart - 1];
    }
  }
  const beforeIsDelimOrPunct =
    before === '*' || before === '_' || isPunctSpaceNotDelim(before);
  let prev = prevChar;
  if (runStart < posInFull) prev = before;
  const flanking = runStart < posInFull
    ? beforeIsDelimOrPunct
    : isPunctSpaceNotDelim(prev);
  if (delim === '_' && afterOther && isAlnumChar(prev)) return null;
  if (!afterPunct || !prev || flanking) {
    // openLen: the delimiter run length.
    const openLen = openerRun;
    let debt = openLen;
    let skipped = 0;
    const openerTotal = posInFull - runStart + openLen;
    const embedded =
      !!before.trim() &&
      (!!afterPunct || (delim === '*' && !beforeIsDelimOrPunct));
    const afterOpener = posInFull + openLen;
    const lastCloser = closerFor(closers, masked, delim);
    if (lastCloser < afterOpener) return null;
    const maxIndex = lastCloser - afterOpener;
    const rdelim = delim === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
    // In-place scan over the full masked text: the anchored first
    // alternative is probed stickily at the scan start (a match only
    // advances the scan), then the main pattern runs from there.
    // Match indices below are relative to afterOpener, as they were
    // relative to the sliced scan string before.
    let scanPos = afterOpener;
    const alt1 = delim === '*' ? EM_ALT1_AST_RE : EM_ALT1_UND_RE;
    alt1.lastIndex = afterOpener;
    const a1 = alt1.exec(masked);
    if (a1) scanPos = afterOpener + a1[0].length;
    rdelim.lastIndex = scanPos;
    let m;
    while ((m = rdelim.exec(masked)) !== null) {
      const relIndex = m.index - afterOpener;
      if (relIndex > maxIndex) break;
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let runLen = run.length;
      if (m[3] || m[4]) {
        debt += runLen;
        continue;
      }
      if (m[5] || m[6] || embedded) {
        if (sameAsPrev && (m[5] || m[6])) break;
        if (openerTotal % 3 && !((openerTotal + runLen) % 3)) {
          skipped += runLen;
          continue;
        }
      }
      debt -= runLen;
      if (debt > 0) continue;
      runLen = Math.min(runLen, runLen + debt + skipped);
      const c0 = m[0].charCodeAt(0);
      const firstCpLen = c0 >= 0xd800 && c0 <= 0xdbff ? 2 : 1;
      const raw = rest.slice(0, openLen + relIndex + firstCpLen + runLen);
      if (Math.min(openLen, runLen) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(inner, []) };
      }
      const inner = raw.slice(2, -2);
      return {
        type: 'strong',
        raw,
        text: inner,
        tokens: inlineTokens(inner, []),
      };
    }
  }
  return null;
}

// Split like the emphasis patterns: the anchored, capture-less
// first alternative becomes a sticky probe; the main pattern keeps
// the rest (group numbering unchanged).
const DEL_ALT1_RE = /[^~]+(?=[^~])/uy;
const DEL_RDELIM_RE =
  /(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

function tokDel(rest, masked, prevChar, closers) {
  // Hand-rolled opener classification (was DEL_LDELIM_RE): a run of
  // one or two '~' (the regex prefers two and backtracks to one) plus
  // the code point after it. afterPunct is that code point ONLY when
  // it is a punctuation/symbol — a letter or digit after the run (as
  // in H~2~O) is captured by the regex's second alternative and does
  // NOT count as afterPunct. No classification at all (run followed
  // by '~', whitespace, or the end of the text) means no match.
  let openLen = 0;
  let afterPunct = '';
  const maxRun = rest.charCodeAt(1) === 126 ? 2 : 1;
  for (let run = maxRun; run >= 1; run--) {
    const cp = rest.codePointAt(run);
    if (cp === undefined || cp === 126 || isSpaceCp(cp)) continue;
    const ch = String.fromCodePoint(cp);
    afterPunct = isPunctSymbolCp(cp, ch) ? ch : '';
    openLen = run;
    break;
  }
  if (openLen === 0) return null;
  if (!afterPunct || !prevChar || isPunctSpaceNotDelim(prevChar)) {
    let debt = openLen;
    const afterOpener = masked.length - rest.length + openLen;
    const lastCloser = closerFor(closers, masked, '~');
    if (lastCloser < afterOpener) return null;
    const maxIndex = lastCloser - afterOpener;
    // In-place scan over the full masked text, like tokEmStrong:
    // sticky probe for the anchored first alternative, then the
    // main pattern; indices are relative to afterOpener.
    let scanPos = afterOpener;
    DEL_ALT1_RE.lastIndex = afterOpener;
    const a1 = DEL_ALT1_RE.exec(masked);
    if (a1) scanPos = afterOpener + a1[0].length;
    DEL_RDELIM_RE.lastIndex = scanPos;
    let m;
    while ((m = DEL_RDELIM_RE.exec(masked)) !== null) {
      const relIndex = m.index - afterOpener;
      if (relIndex > maxIndex) break;
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let runLen = run.length;
      if (runLen !== openLen) continue;
      if (m[3] || m[4]) {
        debt += runLen;
        continue;
      }
      debt -= runLen;
      if (debt > 0) continue;
      runLen = Math.min(runLen, runLen + debt);
      const c0 = m[0].charCodeAt(0);
      const firstCpLen = c0 >= 0xd800 && c0 <= 0xdbff ? 2 : 1;
      const raw = rest.slice(0, openLen + relIndex + firstCpLen + runLen);
      const inner = raw.slice(openLen, raw.length - openLen);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(inner, []) };
    }
  }
  return null;
}

function tokCodespan(rest) {
  // Native pre-gate: a code span needs a closing backtick run, so at
  // least one more backtick must exist after the opening run starts.
  if (rest.indexOf('`', 1) === -1) return null;
  const cap = CODESPAN_RE.exec(rest);
  if (!cap) return null;
  let text = cap[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
    text = text.slice(1, -1);
  }
  return { type: 'codespan', raw: cap[0], text };
}

const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
function tokBr(rest) {
  const cap = BR_RE.exec(rest);
  return cap ? { type: 'br', raw: cap[0] } : null;
}

const AUTOLINK_RE =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
function tokAutolink(rest) {
  const cap = AUTOLINK_RE.exec(rest);
  if (!cap) return null;
  const isEmail = cap[2] === '@';
  const text = cap[1];
  return {
    type: 'link',
    raw: cap[0],
    text,
    href: isEmail ? 'mailto:' + text : text,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

const URL_RE =
  /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL_RE =
  /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// Cheap pre-check: can a bare URL or bare email possibly start here?
// Covers the www. prefix, the mailto:/xmpp: schemes, scheme:// URLs
// and bare emails (local part run followed by '@').
function urlMayStart(s) {
  if (s.startsWith('www.') || s.startsWith('mailto:') || s.startsWith('xmpp:')) {
    return true;
  }
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 46 || // .
      c === 43 || // +
      c === 45 || // -
      c === 95 // _
    ) {
      i++;
    } else {
      break;
    }
  }
  if (i > 0 && s[i] === '@') return true;
  // scheme:// — letters then '://'
  if (i > 0 && s.startsWith('://', i)) {
    const scheme = s.slice(0, i).toLowerCase();
    return scheme === 'http' || scheme === 'https' || scheme === 'ftp';
  }
  return false;
}

function tokUrl(rest) {
  if (!urlMayStart(rest)) return null;
  const cap = URL_RE.exec(rest);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let cur = cap[0];
    let prev;
    do {
      prev = cur;
      const step = BACKPEDAL_RE.exec(cur);
      cur = step ? step[0] : '';
    } while (prev !== cur);
    if (cur === '') return null;
    text = cur;
    href = cap[1] === 'www.' ? 'http://' + cur : cur;
  }
  return {
    type: 'link',
    raw: text,
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

// --- Plain inline text -------------------------------------------------
// Text runs stop before anything that could start another construct:
// special characters, word-boundary underscores, "http"/"ftp://"/
// "www." prefixes, email addresses and mailto:/xmpp: schemes, and the
// two-spaces-plus-newline of a hard break.

const EMAIL_LOCAL_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-",
);
// Same set as a lookup table by char code (hot path).
const EMAIL_LOCAL_TABLE = new Uint8Array(128);
for (const ch of EMAIL_LOCAL_CHARS) EMAIL_LOCAL_TABLE[ch.charCodeAt(0)] = 1;
function isEmailLocalAt(s, i) {
  const c = s.charCodeAt(i);
  return c < 128 && EMAIL_LOCAL_TABLE[c] === 1;
}
function isAlnumCode(c) {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  );
}
// Does an email address start at s[i]? (a run of email characters
// immediately followed by '@')
function emailStartsAt(s, i) {
  let j = i;
  while (j < s.length && EMAIL_LOCAL_CHARS.has(s[j])) j++;
  return j > i && s[j] === '@';
}
// Does s start with 2+ spaces and a newline at position i?
function spacesThenNewline(s, i) {
  let j = i;
  while (j < s.length && s[j] === ' ') j++;
  return j - i >= 2 && s[j] === '\n';
}

// Candidate positions where a plain-text run can end: a construct
// character, a hard-break space run, an http/ftp/www prefix, a
// mailto:/xmpp: scheme, or the '@' of a possible email. The scan
// jumps from candidate to candidate (native regex search) and
// verifies each one precisely. Case-insensitive prefixes are spelled
// with explicit ASCII case classes instead of the /i flag (the
// verifier below accepts only the exact lowercase forms where the
// reference does, and the flag makes the native scan slower).
const TEXT_CANDIDATE_RE =
  /[\\<!\[`*~_]| {2,}\n|[hH][tT][tT][pP]|[fF][tT][pP]:\/\/|[wW][wW][wW]\.|[mM][aA][iI][lL][tT][oO]:|[xX][mM][pP][pP]:|@/g;

function tokInlineText(rest) {
  const s = rest;
  const n = s.length;
  let i = 0;
  // Memoized email lookahead: atPos is the index of the '@' of the
  // next candidate email at or after the scan position, atStart the
  // start of the email-character run that ends at that '@'. An email
  // starts at p exactly when atStart <= p < atPos.
  let atPos = -1;
  let atStart = -1;
  let atSearched = false;
  const c0 = s.charCodeAt(0);
  if (
    !isAlnumCode(c0) &&
    (s.startsWith('mailto:', 1) || s.startsWith('xmpp:', 1))
  ) {
    return makeTextToken(s.slice(0, 1));
  }
  if (c0 === 96 || c0 === 126) {
    // a run of backticks or tildes is the first unit
    while (i < n && s.charCodeAt(i) === c0) i++;
  } else {
    i = 1;
  }
  if (i >= n) return makeTextToken(s.slice(0, i));
  {
    const c = s.charCodeAt(i);
    if (c === 96 || c === 126) return makeTextToken(s.slice(0, i));
    if (spacesThenNewline(s, i)) return makeTextToken(s.slice(0, i));
    // Does an email start at i? (open-coded lookahead over the
    // memoized atPos/atStart state declared above)
    if (!atSearched || i > atPos) {
      atPos = s.indexOf('@', i);
      atSearched = true;
      if (atPos === -1) {
        atStart = -1;
      } else {
        atStart = atPos;
        while (atStart > 0 && isEmailLocalAt(s, atStart - 1)) atStart--;
      }
    }
    if (atPos !== -1 && i >= atStart && i < atPos) {
      return makeTextToken(s.slice(0, i));
    }
  }
  // The next email that starts inside this run, if any: an email
  // terminator's effective end is the START of the local-part run
  // ending at the '@', which can precede other candidates (a '_'
  // inside the local part is itself a candidate). Tracked lazily in
  // plain locals and open-coded at its single use in the loop below.
  let nextAtPos = -2; // -2 unknown, -1 none
  let nextAtStart = -1;
  // Jump between candidate end positions.
  TEXT_CANDIDATE_RE.lastIndex = i;
  let m;
  while ((m = TEXT_CANDIDATE_RE.exec(s)) !== null) {
    const q = m.index;
    const ch = m[0];
    const c = ch.charCodeAt(0);
    let end = -1;
    if (ch.length === 1) {
      if (c === 64) {
        // '@': an email include-one terminator lands on the start of
        // the email-character run that ends at this '@'.
        if (atPos !== q) {
          atPos = q;
          atStart = q;
          atSearched = true;
          while (atStart > 0 && isEmailLocalAt(s, atStart - 1)) atStart--;
        }
        if (atStart > i) {
          i = atStart;
          return makeTextToken(s.slice(0, i));
        }
        continue;
      }
      // A construct character: the run ends just before it.
      end = q;
    } else if (c === 32) {
      // ' {2,}\n': consume the character before the spaces, then stop.
      end = q;
    } else if (c === 104 || c === 72) {
      // http (any case): the run ends just before it.
      end = q;
    } else if (c === 102 || c === 70) {
      // ftp:// (any case)
      end = q;
    } else if (c === 119 || c === 87) {
      // www. — only the lowercase form, with the lookbehind rule.
      if (s.startsWith('www.', q) && startsWwwAt(s, q)) end = q;
    } else if (
      // mailto: / xmpp: — an include-one terminator: it fires when the
      // character just before the scheme is not alphanumeric and that
      // character is part of this run.
      (s.startsWith('mailto:', q) || s.startsWith('xmpp:', q)) &&
      q - 1 >= i &&
      !isAlnumCode(s.charCodeAt(q - 1))
    ) {
      end = q;
    }
    if (end !== -1) {
      // Open-coded emailEndUpTo(end): the start of the local-part
      // run of the next email beginning at or before `end`, else -1.
      let ee = -1;
      for (;;) {
        if (nextAtPos === -1) break;
        if (nextAtPos === -2 || nextAtStart <= i) {
          const from = nextAtPos === -2 ? i : nextAtPos + 1;
          nextAtPos = s.indexOf('@', from);
          if (nextAtPos === -1) break;
          nextAtStart = nextAtPos;
          while (nextAtStart > 0 && isEmailLocalAt(s, nextAtStart - 1)) {
            nextAtStart--;
          }
          if (nextAtStart <= i) continue;
        }
        ee = nextAtStart <= end ? nextAtStart : -1;
        break;
      }
      i = ee !== -1 ? ee : end;
      return makeTextToken(s.slice(0, i));
    }
  }
  return makeTextToken(s.slice(0, n));
}

// A "www." prefix starts a bare URL unless the character before it is
// a non-space character other than * _ ~ or (.
function startsWwwAt(s, i) {
  if (!s.startsWith('www.', i)) return false;
  if (i === 0) return true;
  const prev = s[i - 1];
  if (prev.charCodeAt(0) > 127) return /\s/.test(prev);
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '\f' ||
    prev === '\v' ||
    prev === '*' ||
    prev === '_' ||
    prev === '~' ||
    prev === '('
  );
}

function makeTextToken(raw) {
  const inRaw = STATE.inRawBlock;
  return {
    type: 'text',
    raw,
    text: inRaw ? raw : decodeNumericRefs(raw),
    escaped: inRaw,
  };
}

// --- The inline scanner -------------------------------------------------

function inlineTokens(src, tokens) {
  const savedParen = STATE.linkParenPossible;
  STATE.linkParenPossible = savedParen && src.includes(')');
  const out = scanInline(src, tokens);
  STATE.linkParenPossible = savedParen;
  return out;
}

function scanInline(src, tokens) {
  // The emphasis mask is computed lazily: many inline runs never reach
  // an emphasis tokenizer (their *, _ or ~ characters all live inside
  // code spans, links or tags). Last-closer positions are likewise
  // resolved per delimiter on first use and cached in plain locals.
  let masked = null;
  const closers = { '*': -2, _: -2, '~': -2 };
  let prevChar = '';
  let wasText = false;
  let rest = src;
  while (rest.length > 0) {
    if (!wasText) prevChar = '';
    wasText = false;
    let tok = null;
    // Dispatch on the first character: at any position only a few of
    // the tokenizers can possibly match, in the reference's order.
    const c = rest.charCodeAt(0);
    if (c === 92) {
      // backslash: escape, or a hard break
      tok = tokEscape(rest) || tokBr(rest);
    } else if (c === 60) {
      // <: inline HTML, or an autolink
      tok = tokTag(rest) || tokAutolink(rest);
    } else if (c === 91 || (c === 33 && rest.charCodeAt(1) === 91)) {
      // [ or ![ : inline link, then reference link
      tok = tokLink(rest);
      if (!tok) {
        tok = tokReflink(rest);
        if (tok) {
          // A failed reference link yields a one-character text token
          // that merges into a preceding text token; it does not count
          // as a text token for previous-character tracking.
          if (tok.type === 'text') {
            const prevTok = tokens[tokens.length - 1];
            if (prevTok && prevTok.type === 'text') {
              prevTok.raw += tok.raw;
              prevTok.text += tok.text;
            } else {
              tokens.push(tok);
            }
          } else {
            tokens.push(tok);
          }
          rest = rest.slice(tok.raw.length);
          continue;
        }
      }
    } else if (c === 42 || c === 95) {
      // * or _: emphasis; a leading _ can also start a bare email URL
      if (masked === null) masked = buildMask(src);
      tok = tokEmStrong(rest, masked, prevChar, closers);
      if (!tok && c === 95 && !STATE.inLink) tok = tokUrl(rest);
    } else if (c === 96) {
      // `: code span
      tok = tokCodespan(rest);
    } else if (c === 126) {
      // ~: strikethrough
      if (masked === null) masked = buildMask(src);
      tok = tokDel(rest, masked, prevChar, closers);
    } else if (c === 32) {
      // space: a hard break is the only construct that can start here
      tok = tokBr(rest);
    }
    if (!tok && !STATE.inLink && isUrlStartCode(c)) {
      tok = tokUrl(rest);
    }
    if (tok) {
      tokens.push(tok);
    } else if ((tok = tokInlineText(rest))) {
      if (!tok.raw.endsWith('_')) prevChar = tok.raw.slice(-1);
      wasText = true;
      const prevTok = tokens[tokens.length - 1];
      if (prevTok && prevTok.type === 'text') {
        prevTok.raw += tok.raw;
        prevTok.text += tok.text;
      } else {
        tokens.push(tok);
      }
    } else {
      throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    }
    rest = rest.slice(tok.raw.length);
  }
  return tokens;
}

// Can a bare-URL or bare-email token start with this character?
function isUrlStartCode(c) {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 46 || // .
    c === 43 || // +
    c === 45 // -
  );
}

// ---------------------------------------------------------------------
// Block parsing
//
// Block tokens are produced in one pass; the inline text of headings,
// paragraphs, table cells and text blocks is queued as jobs and only
// tokenized after the whole block pass, so link reference definitions
// are all known before any inline parsing happens.
// ---------------------------------------------------------------------

const SPACE_RE = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES_RE =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const HR_RE =
  /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/;
const BLOCKQUOTE_RE = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))((?:[^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:' +
    BLOCK_TAGS +
    ')(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+',
);
const BLOCKQUOTE_START_RE = /^ {0,3}>/;
const BLOCKQUOTE_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const BLOCKQUOTE_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_STRIP_RE = /^ {0,3}>[ \t]?/gm;
const LIST_START_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const HTML_BLOCK_RE = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(' +
    BLOCK_TAGS +
    ')(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))',
  'i',
);
const DEF_RE =
  /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const TEXT_BLOCK_RE = /^[^\n]+/;

// Interrupt tests used at the start of a would-be continuation line.
const INT_HR_RE =
  /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/;
const INT_HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const INT_BQ_RE = /^ {0,3}>/;
const INT_FENCE_RE =
  /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/;
const INT_LIST_PARA_RE = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const INT_LIST_TABLE_RE = /^ {0,3}(?:[*+-]|1[.)])[ \t]/;
const INT_HTML_RE = new RegExp(
  '^ {0,3}(?:<\\/?(?:' +
    BLOCK_TAGS +
    ')(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
);
const INT_CODE_RE = /^(?: {4}| {0,3}\t)[^\n]/;
const TABLE_DELIM_RE =
  /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n|$)/;

// --- Small tokenizers --------------------------------------------------

function tokSpace(src) {
  const cap = SPACE_RE.exec(src);
  return cap && cap[0].length > 0 ? { type: 'space', raw: cap[0] } : null;
}

function tokIndentedCode(src) {
  const cap = INDENTED_CODE_RE.exec(src);
  if (!cap) return null;
  const raw = dropExcessTrailingBlankLines(cap[0]);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { type: 'code', raw, text, codeBlockStyle: 'indented' };
}

function tokFences(src) {
  const cap = FENCES_RE.exec(src);
  if (!cap) return null;
  const raw = cap[0];
  let text = cap[3] || '';
  const comp = /^(\s+)(?:```)/.exec(raw);
  if (comp) {
    const indent = comp[1];
    text = text
      .split('\n')
      .map((line) => {
        const lead = /^\s+/.exec(line);
        if (!lead) return line;
        return line.slice(Math.min(lead[0].length, indent.length));
      })
      .join('\n');
  }
  const lang = cap[2] ? unescapePunct(cap[2].trim()) : cap[2];
  return { type: 'code', raw, lang, text, codeBlockStyle: 'fenced' };
}

function tokHeading(src) {
  const cap = HEADING_RE.exec(src);
  if (!cap) return null;
  let text = cap[2].trim();
  if (/#$/.test(text)) {
    const stripped = rtrimChar(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  const job = queueInline(text);
  return {
    type: 'heading',
    raw: rtrimChar(cap[0], '\n'),
    depth: cap[1].length,
    text,
    tokens: job.tokens,
  };
}

function tokHr(src) {
  const cap = HR_RE.exec(src);
  return cap ? { type: 'hr', raw: rtrimChar(cap[0], '\n') } : null;
}

function tokHtml(src) {
  const cap = HTML_BLOCK_RE.exec(src);
  if (!cap) return null;
  const raw = dropExcessTrailingBlankLines(cap[0]);
  return { type: 'html', raw, text: raw, block: true };
}

function tokDef(src) {
  const cap = DEF_RE.exec(src);
  if (!cap) return null;
  if (!cap[2].startsWith('<') && bracketBalance(cap[2], '(', ')') !== -1) {
    return null;
  }
  let href = cap[2].replace(/^<(.*)>$/, '$1');
  href = unescapePunct(href);
  const title = cap[3]
    ? unescapePunct(cap[3].substring(1, cap[3].length - 1))
    : cap[3];
  return {
    type: 'def',
    tag: normalizeLabel(cap[1]),
    raw: rtrimChar(cap[0], '\n'),
    href,
    title,
  };
}

// --- Tables --------------------------------------------------------------

// Regex-level table start at `ls`: a header line plus a delimiter
// line. Returns { header, delim, afterDelim } or null.
function matchTableStart(src, ls) {
  const nl = src.indexOf('\n', ls);
  if (nl === -1) return null;
  const header = src.slice(ls, nl);
  // The header line must have a non-space character (hand test for
  // /^ *[^\n ]/ on a single line).
  let hi = 0;
  while (hi < header.length && header[hi] === ' ') hi++;
  if (hi >= header.length) return null;
  // Cheap pre-gate for the delimiter line: TABLE_DELIM_RE can only
  // match a line of at most 3 leading spaces whose characters are all
  // in { ' ', '|', ':', '-' } (the match must consume the whole line)
  // and which contains at least one '-'. Reject anything else here
  // without slicing or running the regex.
  let d = nl + 1;
  let lead = 0;
  while (src[d] === ' ') {
    d++;
    lead++;
    if (lead > 3) return null;
  }
  let hasDash = false;
  for (; d < src.length && src[d] !== '\n'; d++) {
    const c = src[d];
    if (c === '-') hasDash = true;
    else if (c !== '|' && c !== ':' && c !== ' ') return null;
  }
  if (!hasDash) return null;
  const dm = TABLE_DELIM_RE.exec(src.slice(nl + 1));
  if (!dm) return null;
  return { header, delim: dm[1], afterDelim: nl + 1 + dm[0].length };
}

function isTableRowInterrupt(src, ls) {
  const rest = src.slice(ls);
  return (
    /^ *\n/.test(rest) ||
    INT_HR_RE.test(rest) ||
    INT_HEADING_RE.test(rest) ||
    INT_BQ_RE.test(rest) ||
    INT_CODE_RE.test(rest) ||
    INT_FENCE_RE.test(rest) ||
    INT_LIST_TABLE_RE.test(rest) ||
    INT_HTML_RE.test(rest)
  );
}

function tokTable(src) {
  const start = matchTableStart(src, 0);
  if (!start) return null;
  if (!/[:|]/.test(start.delim)) return null;
  const headerCells = splitTableCells(start.header);
  const delimCells = start.delim.replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== delimCells.length) return null;
  const align = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  let pos = start.afterDelim;
  const rowLines = [];
  while (pos < src.length) {
    if (isTableRowInterrupt(src, pos)) break;
    const eol = src.indexOf('\n', pos);
    const lineEnd = eol === -1 ? src.length : eol + 1;
    rowLines.push(src.slice(pos, lineEnd));
    pos = lineEnd;
  }
  let matchEnd = pos;
  while (matchEnd < src.length && src[matchEnd] === '\n') matchEnd++;
  let rawLen = matchEnd;
  while (rawLen > 0 && src[rawLen - 1] === '\n') rawLen--;
  const rowsText = rowLines.join('');
  const rowTexts = rowsText.trim()
    ? rowsText.replace(/\n[ \t]*$/, '').split('\n')
    : [];
  const header = headerCells.map((text, i) => ({
    text,
    tokens: queueInline(text).tokens,
    header: true,
    align: align[i],
  }));
  const rows = rowTexts.map((rowText) =>
    splitTableCells(rowText, headerCells.length).map((text, i) => ({
      text,
      tokens: queueInline(text).tokens,
      header: false,
      align: align[i],
    })),
  );
  return { type: 'table', raw: src.slice(0, rawLen), header, align, rows };
}

// --- Setext headings ------------------------------------------------------

const LH_LEAD_BULLET_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)]) /;
const LH_LEAD_CODE_RE = /^(?: {4}| {0,3}\t)/;
const LH_LEAD_FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/;
const LH_LEAD_TAG_RE = /^ {0,3}<[^\n>]+\>\n/;
const LH_LEAD_TABLE_RE = /^ {0,3}\|?(?:[:\-]*\|)+[\:\-]*\n/;
const LH_BLOCK_BULLET_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)]) /;
const LH_BLOCK_FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/;
const LH_BLOCK_TAG_RE = /^ {0,3}<[^\n>]+\>\n/;
const LH_BLOCK_TABLE_RE = /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;

function lheadingBlockedAt(src, ls) {
  const rest = src.slice(ls);
  if (/^\s*?\n/.test(rest)) return true; // blank line
  const { ch, spaces } = firstSigChar(rest);
  if (spaces > 3) return false;
  if (ch === '>') return true;
  if (ch === '#') return INT_HEADING_RE.test(rest);
  if (ch === '`' || ch === '~') return LH_BLOCK_FENCE_RE.test(rest);
  if (ch === '-' || ch === '_' || ch === '*') {
    return (
      INT_HR_RE.test(rest) ||
      LH_BLOCK_BULLET_RE.test(rest) ||
      (ch === '-' && LH_BLOCK_TABLE_RE.test(rest))
    );
  }
  if (ch === '+' || (ch >= '0' && ch <= '9')) {
    return LH_BLOCK_BULLET_RE.test(rest);
  }
  if (ch === '<') return LH_BLOCK_TAG_RE.test(rest);
  if (ch === '|' || ch === ':') return LH_BLOCK_TABLE_RE.test(rest);
  return false;
}

// Pure setext-heading match (no side effects): returns
// { text, depth, raw } or null.
function lheadingMatch(src) {
  if (
    LH_LEAD_BULLET_RE.test(src) ||
    LH_LEAD_CODE_RE.test(src) ||
    LH_LEAD_FENCE_RE.test(src) ||
    INT_BQ_RE.test(src) ||
    INT_HEADING_RE.test(src) ||
    LH_LEAD_TAG_RE.test(src) ||
    LH_LEAD_TABLE_RE.test(src)
  ) {
    return null;
  }
  let nl = src.indexOf('\n');
  while (nl !== -1) {
    // Hand scan for the setext underline at nl + 1 (was
    // LH_UNDERLINE_RE.exec on a slice): up to 3 spaces, a run of one
    // of '=' / '-', trailing spaces/tabs, then newlines or the end.
    let d = nl + 1;
    let sp = 0;
    while (src[d] === ' ') {
      d++;
      sp++;
    }
    let umLen = -1;
    let umEq = false;
    if (sp <= 3 && (src[d] === '=' || src[d] === '-')) {
      const uc = src[d];
      umEq = uc === '=';
      while (src[d] === uc) d++;
      while (src[d] === ' ' || src[d] === '\t') d++;
      if (d >= src.length || src[d] === '\n') {
        while (src[d] === '\n') d++;
        umLen = d - (nl + 1);
      }
    }
    if (umLen !== -1 && nl > 0) {
      return {
        text: src.slice(0, nl).trim(),
        depth: umEq ? 1 : 2,
        raw: rtrimChar(src.slice(0, nl + 1 + umLen), '\n'),
      };
    }
    if (lheadingBlockedAt(src, nl + 1)) return null;
    nl = src.indexOf('\n', nl + 1);
  }
  return null;
}

function tokLheading(src) {
  const m = lheadingMatch(src);
  if (!m) return null;
  const job = queueInline(m.text);
  return { type: 'heading', raw: m.raw, depth: m.depth, text: m.text, tokens: job.tokens };
}

// --- Paragraphs -----------------------------------------------------------

// The first character of a block that is not a leading space, and how
// many spaces precede it (block constructs allow at most 3). Returns
// { ch, spaces } with ch === '' at a blank line or end of input. The
// result is a shared scratch object: callers must copy the fields out
// before any other call (all current callers destructure at once).
const SIG_SCRATCH = { ch: '', spaces: 0 };
function firstSigChar(src) {
  let i = 0;
  while (src[i] === ' ') i++;
  SIG_SCRATCH.ch = i < src.length ? src[i] : '';
  SIG_SCRATCH.spaces = i;
  return SIG_SCRATCH;
}

function isParagraphInterrupt(src, ls) {
  const rest = src.slice(ls);
  if (/^[ \t]+\n/.test(rest)) return true;
  // Fast path on the first significant character: most continuation
  // lines start with a letter or digit and interrupt nothing.
  const { ch, spaces } = firstSigChar(rest);
  if (spaces <= 3) {
    if (ch === '>' ) return true;
    if (ch === '#') {
      if (INT_HEADING_RE.test(rest)) return true;
    } else if (ch === '-' || ch === '_' || ch === '*') {
      if (INT_HR_RE.test(rest)) return true;
      if (INT_LIST_PARA_RE.test(rest)) return true;
    } else if (ch === '+' ) {
      if (INT_LIST_PARA_RE.test(rest)) return true;
    } else if (ch === '1') {
      if (INT_LIST_PARA_RE.test(rest)) return true;
    } else if (ch === '`' || ch === '~') {
      if (INT_FENCE_RE.test(rest)) return true;
    } else if (ch === '<') {
      if (INT_HTML_RE.test(rest)) return true;
    }
  }
  return matchTableStart(src, ls) !== null;
}

// Length of the paragraph token's text starting at src[0]: the first
// line plus every continuation line that no block construct interrupts.
function paragraphEnd(src) {
  let end = src.indexOf('\n');
  if (end === -1) return src.length;
  let pos = end;
  while (pos < src.length) {
    const ls = pos + 1;
    if (ls >= src.length) break;
    if (src[ls] === '\n') break; // an empty line ends the paragraph
    if (isParagraphInterrupt(src, ls)) break;
    const next = src.indexOf('\n', ls);
    end = next === -1 ? src.length : next;
    pos = end;
  }
  return end;
}

function tokParagraph(src) {
  const end = paragraphEnd(src);
  if (end === 0) return null;
  const raw = src.slice(0, end);
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const job = queueInline(text);
  return { type: 'paragraph', raw, text, tokens: job.tokens };
}

function tokText(src) {
  const cap = TEXT_BLOCK_RE.exec(src);
  if (!cap) return null;
  const job = queueInline(cap[0]);
  return { type: 'text', raw: cap[0], text: cap[0], tokens: job.tokens };
}

// --- Blockquotes ------------------------------------------------------------

function tokBlockquote(src) {
  const cap = BLOCKQUOTE_RE.exec(src);
  if (!cap) return null;
  let lines = rtrimChar(cap[0], '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BLOCKQUOTE_START_RE.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else {
        break;
      }
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const u = chunkRaw
      .replace(BLOCKQUOTE_MARKER_WS_RE, (m, g1, g2) => g1 + expandTabs(g2, g1.length))
      .replace(BLOCKQUOTE_SETEXT_RE, '\n    $1')
      .replace(BLOCKQUOTE_STRIP_RE, '');
    rawAll = rawAll ? rawAll + '\n' + chunkRaw : chunkRaw;
    textAll = textAll ? textAll + '\n' + u : u;
    const savedTop = STATE.top;
    STATE.top = true;
    blockTokens(u, tokens, true);
    STATE.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) continue;
    if (
      last.type === 'code' ||
      last.type === 'heading' ||
      last.type === 'hr' ||
      last.type === 'html' ||
      last.type === 'table'
    ) {
      break;
    }
    if (last.type === 'blockquote') {
      const joined = lines.join('\n');
      const extended = last.raw + '\n' + joined.replace(BLOCKQUOTE_STRIP_RE, '');
      const grown = tokBlockquote(extended);
      if (!grown) break;
      tokens[tokens.length - 1] = grown;
      const leftover = extended.substring(grown.raw.length).replace(/^\n/, '');
      const usedLines = leftover ? leftover.split('\n').length : 0;
      const taken = usedLines ? lines.slice(0, -usedLines) : lines;
      if (taken.length > 0) rawAll += '\n' + taken.join('\n');
      textAll = textAll.substring(0, textAll.length - last.text.length) + grown.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && BLOCKQUOTE_START_RE.test(lines[0])) continue;
      break;
    }
    if (last.type === 'list') {
      const joined = last.raw + '\n' + lines.join('\n');
      const grown = tokList(joined);
      if (!grown) break;
      tokens[tokens.length - 1] = grown;
      const extra =
        grown.raw.length > last.raw.length
          ? joined.slice(last.raw.length + 1, grown.raw.length).split('\n').length
          : 0;
      if (extra > 0) {
        const takenText = lines.slice(0, extra).join('\n');
        rawAll += '\n' + takenText;
        textAll += '\n' + takenText;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAll, text: textAll, tokens };
}

// --- Lists ------------------------------------------------------------------

const LIST_IS_TASK_RE = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK_RE = /^\[[ xX]\][ \t]+/;
const LIST_CHECKBOX_RE = /\[[ xX]\]/;
const LIST_SETEXT_RE = /^ {0,3}(?:=+|-+) *$/;
// Equivalent of /\n[ \t]*\n[ \t]*$/ without scanning the whole string.
function hasDoubleBlankEnd(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  if (i < 0 || s[i] !== '\n') return false;
  i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i >= 0 && s[i] === '\n';
}

function expandLeadingRun(text, startColumn) {
  // Hand-scanned equivalent of the /^[ \t]+/ prefix test.
  let end = 0;
  let hasTab = false;
  while (end < text.length) {
    const c = text.charCodeAt(end);
    if (c === 32) end++;
    else if (c === 9) {
      hasTab = true;
      end++;
    } else break;
  }
  if (end === 0 || !hasTab) return text; // spaces expand to themselves
  return expandTabs(text.slice(0, end), startColumn) + text.slice(end);
}

// Is this string entirely whitespace (String.trim() === ''), tested
// char by char; non-ASCII characters defer to trim itself.
function isBlankText(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 13) continue;
    if (c < 128) return false;
    return s.trim() === '';
  }
  return true;
}

// First index whose character is not a space, or -1 (the semantics of
// String.search(/[^ ]/), where a tab counts as a non-space).
function firstNonSpaceIdx(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') return i;
  }
  return -1;
}

// Do any of the list-item "begin" constructs start this line? Gated on
// the first significant character, which each pattern requires.
function beginBreaksAt(line, begin) {
  const { ch, spaces } = firstSigChar(line);
  if (spaces > 3 || ch === '') return false;
  if (ch === '`' || ch === '~') return begin.fences.test(line);
  if (ch === '#') return begin.heading.test(line);
  if (ch === '<') return begin.html.test(line);
  if (ch === '>') return begin.blockquote.test(line);
  if (ch === '-' || ch === '*') {
    return begin.nextBullet.test(line) || begin.hr.test(line);
  }
  if (ch === '+') return begin.nextBullet.test(line);
  if (ch === '_') return begin.hr.test(line);
  if (ch >= '0' && ch <= '9') return begin.nextBullet.test(line);
  return false;
}

// The lazy-continuation break tests against the previous line: only
// fences, heading, html and hr are consulted there.
function prevBeginBreaksAt(prev, begin) {
  const { ch, spaces } = firstSigChar(prev);
  if (spaces > 3 || ch === '') return false;
  if (ch === '`' || ch === '~') return begin.fences.test(prev);
  if (ch === '#') return begin.heading.test(prev);
  if (ch === '<') return begin.html.test(prev);
  if (ch === '-' || ch === '_' || ch === '*') return begin.hr.test(prev);
  return false;
}

const BEGIN_CACHE = [null, null, null, null];
function beginRegexes(indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  if (BEGIN_CACHE[n]) return BEGIN_CACHE[n];
  const built = {
    nextBullet: new RegExp(
      '^ {0,' + n + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))',
    ),
    hr: new RegExp(
      '^ {0,' +
        n +
        '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)',
    ),
    fences: new RegExp('^ {0,' + n + '}(?:```|~~~)'),
    heading: new RegExp('^ {0,' + n + '}#{1,6}(?:\\s|$)'),
    html: new RegExp(
      '^ {0,' +
        n +
        '}(?:<\\/?(?:' +
        BLOCK_TAGS +
        ')(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    ),
    blockquote: new RegExp('^ {0,' + n + '}>'),
  };
  BEGIN_CACHE[n] = built;
  return built;
}

function tokList(src) {
  const startCap = LIST_START_RE.exec(src);
  if (!startCap) return null;
  const origSrc = src;
  let rest = src;
  // Consumed length so far is origSrc.length - rest.length, computed
  // inline at the uses below (no per-call closure).
  const bulletTrimmed = startCap[1].trim();
  const ordered = bulletTrimmed.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bulletTrimmed.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPat = ordered
    ? '\\d{1,9}\\' + bulletTrimmed.charAt(bulletTrimmed.length - 1)
    : '\\' + bulletTrimmed;
  const itemRe = new RegExp(
    '^( {0,3}' + bulletPat + ')((?:[\\t ][^\\n]*)?(?:\\n|$))',
  );
  let pendingLoose = false;
  let cap;
  while (rest) {
    cap = itemRe.exec(rest);
    if (!cap || HR_RE.test(rest)) break;
    const itemStart = origSrc.length - rest.length;
    rest = rest.slice(cap[0].length);
    const firstNl = (cap[2] || '').indexOf('\n');
    const firstLine = firstNl === -1 ? cap[2] || '' : (cap[2] || '').slice(0, firstNl);
    const bulletLen = cap[1].length;
    const expanded = expandLeadingRun(firstLine, bulletLen);
    const nextNl = rest.indexOf('\n');
    let nextLine = nextNl === -1 ? rest : rest.slice(0, nextNl);
    const blankFirst = isBlankText(expanded);
    let indent;
    let itemText = '';
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      indent = firstNonSpaceIdx(expanded);
      if (indent > 4) indent = 1;
      itemText = expanded.slice(indent);
      indent += bulletLen;
    }
    let itemDone = false;
    if (blankFirst && BLANK_LINE_RE.test(nextLine)) {
      rest = rest.slice(nextLine.length + 1);
      itemDone = true;
    }
    if (!itemDone) {
      const begin = beginRegexes(indent);
      let prevBlank = blankFirst;
      let prevDedented = expanded;
      while (rest) {
        const lineNl = rest.indexOf('\n');
        const line = lineNl === -1 ? rest : rest.slice(0, lineNl);
        const dedented = expandLeadingRun(line, 0);
        if (beginBreaksAt(line, begin)) break;
        if (firstNonSpaceIdx(dedented) >= indent || isBlankText(line)) {
          itemText += '\n' + dedented.slice(indent);
        } else {
          const prevExpanded = prevDedented.replace(/\t/g, '    ');
          if (
            prevBlank ||
            firstNonSpaceIdx(prevExpanded) >= 4 ||
            prevBeginBreaksAt(prevDedented, begin)
          ) {
            break;
          }
          let add = line;
          if (LIST_SETEXT_RE.test(line) && lheadingMatch(prevDedented + '\n' + line)) {
            add = '    ' + dedented.replace(/^ {0,3}/, '');
          }
          itemText += '\n' + add;
        }
        prevBlank = isBlankText(line);
        rest = rest.slice(line.length + 1);
        prevDedented = dedented.slice(indent);
      }
    }
    const itemRaw = origSrc.slice(itemStart, origSrc.length - rest.length);
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (hasDoubleBlankEnd(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: LIST_IS_TASK_RE.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = origSrc.slice(0, origSrc.length - rest.length).trimEnd();
  for (const item of list.items) {
    STATE.top = false;
    item.tokens = blockTokens(item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => /\n.*\n/.test(t.raw))) {
        list.loose = true;
      }
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(LIST_REPLACE_TASK_RE, '');
      first.raw = first.raw.replace(LIST_REPLACE_TASK_RE, '');
      first.text = first.text.replace(LIST_REPLACE_TASK_RE, '');
      for (let g = JOBS.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK_RE.test(JOBS[g].src)) {
          JOBS[g].src = JOBS[g].src.replace(LIST_REPLACE_TASK_RE, '');
          break;
        }
      }
      const chk = LIST_CHECKBOX_RE.exec(item.raw);
      if (chk) {
        const checkbox = {
          type: 'checkbox',
          raw: chk[0] + ' ',
          checked: chk[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          const t0 = item.tokens[0];
          if (
            t0 &&
            (t0.type === 'paragraph' || t0.type === 'text') &&
            t0.tokens
          ) {
            t0.raw = checkbox.raw + t0.raw;
            t0.text = checkbox.raw + t0.text;
            t0.tokens.unshift(checkbox);
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

// --- The block driver ---------------------------------------------------------

function blockTokens(src, tokens, mergePara) {
  let rest = src;
  let clipped = mergePara;
  while (rest) {
    let tok;
    if ((tok = tokSpace(rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    // Gate the remaining tokenizers on the first significant
    // character: most block starts can only begin a few constructs.
    const sig = firstSigChar(rest);
    const ch = sig.ch;
    const sp3 = sig.spaces <= 3;
    if (
      (sig.spaces >= 4 || ch === '\t') &&
      (tok = tokIndentedCode(rest))
    ) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        JOBS[JOBS.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    if (sp3 && (ch === '`' || ch === '~') && (tok = tokFences(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp3 && ch === '#' && (tok = tokHeading(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp3 && (ch === '-' || ch === '_' || ch === '*') && (tok = tokHr(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp3 && ch === '>' && (tok = tokBlockquote(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (
      sp3 &&
      (ch === '*' ||
        ch === '+' ||
        ch === '-' ||
        (ch >= '0' && ch <= '9')) &&
      (tok = tokList(rest))
    ) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp3 && ch === '<' && (tok = tokHtml(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp3 && ch === '[' && (tok = tokDef(rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        JOBS[JOBS.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(LINKS, tok.tag)) {
          LINKS[tok.tag] = { href: tok.href, title: tok.title };
        }
        DEFS_EXIST = true;
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokLheading(rest))) {
      rest = rest.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (STATE.top && (tok = tokParagraph(rest))) {
      const prev = tokens[tokens.length - 1];
      if (clipped && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        JOBS.pop();
        JOBS[JOBS.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      clipped = false;
      rest = rest.slice(tok.raw.length);
      continue;
    }
    if ((tok = tokText(rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        JOBS.pop();
        JOBS[JOBS.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  STATE.top = true;
  return tokens;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderCheckbox(tok) {
  return (
    '<input ' +
    (tok.checked ? 'checked="" ' : '') +
    'disabled="" type="checkbox"> '
  );
}

function renderLink(tok) {
  const text = tok.autolink
    ? escapeHtml(tok.text, true)
    : renderInlineTokens(tok.tokens);
  const clean = cleanUrl(tok.href);
  if (clean === null) return text;
  let out = '<a href="' + escapeHtml(clean, tok.autolink) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title, false) + '"';
  return out + '>' + text + '</a>';
}

function renderImage(tok) {
  let alt = tok.text;
  if (tok.tokens) alt = renderPlainTokens(tok.tokens);
  const clean = cleanUrl(tok.href);
  if (clean === null) return escapeHtml(alt, false);
  let out =
    '<img src="' +
    escapeHtml(clean, false) +
    '" alt="' +
    escapeHtml(alt, false) +
    '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title, false) + '"';
  return out + '>';
}

// Inline rendering. In plain mode (used for image alt text) markup is
// flattened to its text content.
function renderInlineTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += escapeHtml(tok.text, false);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += renderLink(tok);
        break;
      case 'image':
        out += renderImage(tok);
        break;
      case 'checkbox':
        out += renderCheckbox(tok);
        break;
      case 'strong':
        out += '<strong>' + renderInlineTokens(tok.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInlineTokens(tok.tokens) + '</em>';
        break;
      case 'del':
        out += '<del>' + renderInlineTokens(tok.tokens) + '</del>';
        break;
      case 'codespan':
        out += '<code>' + escapeHtml(tok.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'text':
        out += tok.tokens
          ? renderInlineTokens(tok.tokens)
          : tok.escaped
            ? tok.text
            : escapeHtml(tok.text, false);
        break;
      default:
        break;
    }
  }
  return out;
}

function renderPlainTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderPlainTokens(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderList(tok) {
  let items = '';
  for (const item of tok.items) {
    items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
  }
  const tag = tok.ordered ? 'ol' : 'ul';
  const start =
    tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (
    '<' +
    tag +
    (cell.align ? ' align="' + cell.align + '"' : '') +
    '>' +
    renderInlineTokens(cell.tokens) +
    '</' +
    tag +
    '>\n'
  );
}

function renderTable(tok) {
  let headerCells = '';
  for (const cell of tok.header) headerCells += renderCell(cell);
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderCell(cell);
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return (
    '<table>\n<thead>\n<tr>\n' +
    headerCells +
    '</tr>\n</thead>\n' +
    body +
    '</table>\n'
  );
}

function renderBlock(tok) {
  switch (tok.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return (
        '<h' +
        tok.depth +
        '>' +
        renderInlineTokens(tok.tokens) +
        '</h' +
        tok.depth +
        '>\n'
      );
    case 'code': {
      const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
      const lang = tok.lang ? tok.lang.match(/^\S*/)[0] : '';
      if (lang) {
        return (
          '<pre><code class="language-' +
          escapeHtml(lang, false) +
          '">' +
          escapeHtml(body, true) +
          '</code></pre>\n'
        );
      }
      return '<pre><code>' + escapeHtml(body, true) + '</code></pre>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
    case 'html':
      return tok.text;
    case 'paragraph':
      return '<p>' + renderInlineTokens(tok.tokens) + '</p>\n';
    case 'text':
      return tok.tokens
        ? renderInlineTokens(tok.tokens)
        : tok.escaped
          ? tok.text
          : escapeHtml(tok.text, false);
    case 'checkbox':
      return renderCheckbox(tok);
    case 'list':
      return renderList(tok);
    case 'table':
      return renderTable(tok);
    default:
      return '';
  }
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) out += renderBlock(tok);
  return out;
}

// ---------------------------------------------------------------------
// Entry point: render a Markdown document to HTML, byte-identical to
// the reference implementation's default configuration.
// ---------------------------------------------------------------------

export function parse(markdown) {
  let src = String(markdown);
  if (src.includes('\r')) src = src.replace(/\r\n|\r/g, '\n');
  LINKS = Object.create(null);
  DEFS_EXIST = false;
  JOBS = [];
  STATE = {
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const tokens = blockTokens(src, [], false);
  for (const job of JOBS) {
    STATE.inRawBlock = false;
    inlineTokens(job.src, job.tokens);
  }
  return renderBlocks(tokens);
}
