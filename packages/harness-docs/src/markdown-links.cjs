'use strict';

// Markdown structure extraction for the docs index (#103): first heading as
// title, link/image references for the navigation graph. Fenced code blocks
// and inline code are stripped first — a URL inside an example must not
// become part of the doc's link graph.

const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
// [label](target "title") — capture label and target; images are ![…](…).
const LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/m;

function stripCode(markdown) {
  return markdown.replace(FENCED_BLOCK, '').replace(INLINE_CODE, '');
}

function titleOf(markdown, fallback) {
  const match = HEADING.exec(markdown);
  return match ? match[1].trim().slice(0, 200) : fallback;
}

// Returns { links: [{ label, target }], images: [{ label, target }] } with
// targets exactly as written (resolution is the provider's job).
function extractReferences(markdown) {
  const source = stripCode(markdown);
  const links = [];
  const images = [];
  let match;
  LINK.lastIndex = 0;
  while ((match = LINK.exec(source))) {
    const entry = { label: match[2], target: match[3] };
    (match[1] === '!' ? images : links).push(entry);
  }
  return { links, images };
}

module.exports = { extractReferences, titleOf, stripCode };
