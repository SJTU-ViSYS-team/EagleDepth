import { initVisualResults } from './visual-results.js?v=264eafd2bc91';

const $ = id => document.getElementById(id);
document.querySelectorAll('.section-card').forEach((section, index) => {
  section.style.setProperty('--entrance-delay', `${index * 100}ms`);
  section.classList.add('is-entering');
  section.addEventListener('animationend', event => {
    if (event.target === section) section.classList.remove('is-entering');
  }, { once: true });
});
const fetchJSON = async path => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
};
fetchJSON('assets/visual-data.json?v=58ffbba17288')
  .then(initVisualResults)
  .catch(() => {
    document.getElementById('visual-load-error').hidden = false;
    document.querySelectorAll('#visual-results .visual-panel').forEach(panel => panel.hidden = true);
    document.getElementById('visual-prev').disabled = true;
    document.getElementById('visual-next').disabled = true;
  });
fetchJSON('assets/site-config.json?v=22628dd91785').then(config => {
  if (config.paperUrl && /^https:\/\//.test(config.paperUrl)) {
    const link = $('paper-link');
    link.href = config.paperUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.removeAttribute('aria-disabled');
    link.removeAttribute('tabindex');
    link.title = 'Read the paper';
  }
}).catch(() => {});

let copyReset;
$('copy-citation').addEventListener('click', async () => {
  const button = $('copy-citation');
  const code = $('citation-code');
  try {
    await navigator.clipboard.writeText(code.textContent);
    clearTimeout(copyReset);
    button.classList.add('is-copied');
    $('copy-label').textContent = 'Copied!';
    $('copy-icon').hidden = true;
    $('copied-icon').hidden = false;
    $('citation-status').textContent = 'Citation copied to clipboard.';
    copyReset = setTimeout(() => {
      button.classList.remove('is-copied');
      $('copy-label').textContent = 'Copy BibTeX';
      $('copy-icon').hidden = false;
      $('copied-icon').hidden = true;
      $('citation-status').textContent = '';
    }, 2000);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    $('citation-status').textContent = 'Citation selected. Press Ctrl+C or Command+C to copy.';
  }
});
