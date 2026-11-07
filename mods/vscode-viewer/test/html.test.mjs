// node --test mods/vscode-viewer/test/html.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown as md } from "../html.js";

test("head, scripts, styles and comments are dropped; headings, paragraphs and inline marks become Markdown", () => {
  const html = `<!DOCTYPE html><html><head><title>T</title><style>p{}</style></head><body><!-- note --><script>alert("<p>x</p>")</script>
    <h2>Hello &amp; <em>welcome</em></h2>
    <p>Some <b>bold</b>, <i>it</i>, <del>gone</del>, <code>a*b</code><br>next &lt;tag&gt; &#169;&#x263A;</p></body></html>`;
  assert.equal(md(html), "## Hello & *welcome*\n\nSome **bold**, *it*, ~~gone~~, `a*b`\\\nnext \\<tag\\> ©☺");
});

test("links keep text and URL; script links are text; images are links named by their alt", () => {
  assert.equal(md('<a href="https://x.org/a b">site</a> <a href="javascript:evil()">bad</a>'), "[site](https://x.org/a%20b) bad");
  assert.equal(md('<img src="cat.png" alt="A cat"> <a href="/home"><img src="logo.png" alt="logo"></a>'), "[Image: A cat](cat.png) [Image: logo](/home)");
});

test("lists nest and number from start; blockquotes prefix every line", () => {
  assert.equal(md("<ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</ul><ol start=3><li>c<li>d</ol>"),
    "- one\n- two\n  - nested\n- three\n\n3. c\n4. d");
  assert.equal(md("<blockquote><p>a</p><p>b</p></blockquote><p>after</p>"), "> a\n>\n> b\n\nafter");
});

test("pre blocks keep their text and language in a fence longer than any backtick run inside", () => {
  assert.equal(md('<pre><code class="language-js">if (a &lt; b) {\n  x = ```y```;\n}</code></pre>'),
    "````js\nif (a < b) {\n  x = ```y```;\n}\n````");
});

test("tables become pipe tables padded to the widest row, with pipes in cells escaped", () => {
  assert.equal(md("<table><tr><th>A</th><th>B</th></tr><tr><td>1 | x</td><td><b>2</b></td></tr><tr><td>3</td></tr></table>"),
    "| A | B |\n| --- | --- |\n| 1 \\| x | **2** |\n| 3 |   |");
});

test("broken markup still gives text: unclosed tags, stray <, no input", () => {
  assert.equal(md("<div>unclosed <p>para <<x <a"), "unclosed\n\npara \\<\\<x \\<a");
  assert.equal(md("<pre>open"), "```\nopen\n```");
  assert.equal(md(""), "");
  assert.equal(md(null), "");
});
