// Runs in the isolated world after the locally bundled Readability script.
(() => {
  const url = location.href;
  try {
    const copy = document.cloneNode(true);
    copy.querySelectorAll('input, textarea, select, [contenteditable], script, style, noscript, form, [hidden], [aria-hidden="true"]').forEach(el => el.remove());
    const parsed = new Readability(copy, { maxElemsToParse: 50000 }).parse();
    const text = parsed?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return { url, content: text.slice(0, 12001), source: text ? 'local' : 'metadata' };
  } catch { return { url, content: '', source: 'metadata' }; }
})();
