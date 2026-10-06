const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

for (const mode of ['index', 'embed']) {
  test(`${mode}: composer status participates in layout and QA targets retain 44px minimums`, () => {
    const root = path.resolve(__dirname, '../public');
    const dom = new JSDOM(fs.readFileSync(path.join(root, `${mode}.html`), 'utf8'));
    try {
      const { document, getComputedStyle } = dom.window;
      const style = document.createElement('style');
      style.textContent = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
      document.head.append(style);
      const notice = document.querySelector('#composerNotice');
      notice.textContent = 'Synthetic busy draft status that may wrap to multiple lines.';
      assert.notEqual(getComputedStyle(notice).position, 'absolute');
      assert.equal(getComputedStyle(notice).whiteSpace, 'normal');
      assert.equal(getComputedStyle(notice).gridArea, 'notice');
      assert.equal(getComputedStyle(document.querySelector('#askForm')).gridArea, 'input');
      const latest = document.createElement('button'); latest.className = 'qa-tool return-latest';
      document.querySelector('#readingActions').append(latest);
      for (const node of [document.querySelector('#sidebarToggle'), document.querySelector('#sendButton'), document.querySelector('#draftStopButton'), latest]) {
        const css = getComputedStyle(node);
        assert.ok(parseFloat(css.minWidth) >= 44, `${node.id || node.className} minimum width`);
        assert.ok(parseFloat(css.minHeight) >= 44, `${node.id || node.className} minimum height`);
      }
      assert.equal(getComputedStyle(document.querySelector('#sendButton svg')).width, '22px');
      assert.equal(document.querySelectorAll('#questionInput').length, 1);
      assert.equal(document.querySelectorAll('#askForm button').length, 2);
    } finally { dom.window.close(); }
  });
}
