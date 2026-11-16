# fleetmark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/lugasprahara/fleetmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/lugasprahara/fleetmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

fleetmark is a dependency-free Markdown engine whose `parse(markdown)` returns
exactly the HTML that marked 18.1.3 renders with its default options (GFM on,
breaks off), byte for byte — the same headings, lists, tables, block quotes,
code blocks, emphasis, links, images, autolinks, strikethrough and raw HTML,
including the places where marked departs from the CommonMark and GFM specs.

It renders that HTML faster than marked by spending less work per byte:

- The block lexer dispatches on the first character of each block, so the
  grammar rules that cannot match at a position are never attempted; indented
  code, fences, headings, quotes, lists, HTML and definitions are recognised
  from a one-character guard instead of a dozen anchored pattern attempts.
- Inline parsing is deferred until the whole block pass is done, so a link
  reference definition anywhere in the document resolves the same way marked
  resolves it, while each paragraph is still scanned exactly once.
- Before emphasis matching, link targets, code spans and HTML spans are
  masked out of the string the delimiter matcher sees — and the masking
  passes are skipped entirely when a cheap pre-check proves they would be
  the identity (no backtick and no backslash, nothing to mask).
- Table and setext candidates are recognised with a cheap line pre-check
  before the full grammar for them runs, and the list machinery reuses its
  compiled per-indent probe patterns instead of rebuilding them per item.
- Rendering is a single walk over the token tree that builds the output
  string directly, with no intermediate representation.

Correctness was established by differential testing: the full 720-case
practice set (652 CommonMark and 28 GFM spec examples plus 40 generated
README-style documents) renders identically, and so do over a hundred
thousand generated fuzz inputs — README-style documents, inline soup and
block soup — compared against marked 18.1.3 itself.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out MAKEFUN_INPUT_DIR=input node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=aes5np1n&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
