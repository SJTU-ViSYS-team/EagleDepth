import { DepthViewer } from './depth-viewer.js?v=7c96d4066959';

const byId = id => document.getElementById(id);

export function initVisualResults(data) {
  const samples = data.samples;
  if (!samples?.length) throw new Error('No visual results are available.');
  const section = byId('visual-results');
  const strip = byId('visual-thumbnails');
  const tabs = [...section.querySelectorAll('[role="tab"]')];
  const viewer = new DepthViewer(byId('depth-pair'));
  const stages = { depth: byId('depth-stage'), comparison: byId('comparison-stage') };
  let selected = 0;
  let mode = 'depth';
  let revision = 0;
  let comparisonAbort;

  function setBusy(stage, busy) {
    stage.setAttribute('aria-busy', String(busy));
    stage.classList.toggle('is-loading', busy);
    stage.querySelector('.gallery-loading').setAttribute('aria-hidden', String(!busy));
  }

  async function loadComparison(sample, signal) {
    const url = new URL(sample.comparison.src, document.baseURI);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Comparison figure could not be loaded.');
    const documentSVG = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
    if (documentSVG.querySelector('parsererror')) throw new Error('Invalid comparison figure.');
    const svg = documentSVG.documentElement;
    if (svg.localName !== 'svg') throw new Error('Invalid comparison figure.');
    const images = [...svg.querySelectorAll('image')];
    await Promise.all(images.map(async image => {
      const source = image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!source) return;
      const resolved = new URL(source, url).href;
      image.setAttribute('href', resolved);
      image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
      const bitmap = new Image();
      bitmap.src = resolved;
      await bitmap.decode();
    }));
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${sample.title}: RGB, MoGe-2, PPD, InfiniDepth, and Ours.`);
    const link = document.createElement('a');
    link.className = 'paper-comparison-link';
    link.href = sample.comparison.src;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open full-size comparison: ${sample.title}`);
    link.append(document.importNode(svg, true));
    return link;
  }

  async function render() {
    const request = ++revision;
    const activeMode = mode;
    const sample = samples[selected];
    const stage = stages[activeMode];
    comparisonAbort?.abort();
    const error = stage.querySelector('.visual-error');
    error.hidden = true;
    setBusy(stage, true);
    viewer.reset();
    try {
      if (activeMode === 'depth') {
        await viewer.load(sample);
        if (request !== revision) return;
        byId('depth-pair').hidden = false;
      } else if (stage.dataset.scene !== sample.id) {
        comparisonAbort = new AbortController();
        const figure = await loadComparison(sample, comparisonAbort.signal);
        if (request !== revision) return;
        const container = byId('comparison-figure');
        container.style.setProperty('--comparison-aspect', sample.comparison.width / sample.comparison.height);
        container.replaceChildren(figure);
      }
      if (request !== revision) return;
      stage.dataset.scene = sample.id;
      byId('visual-status').textContent = `${activeMode === 'depth' ? 'Depth Map' : 'Comparison'}: ${sample.title}`;
    } catch (failure) {
      if (request !== revision || failure.name === 'AbortError') return;
      delete stage.dataset.scene;
      if (activeMode === 'depth') byId('depth-pair').hidden = true;
      else byId('comparison-figure').replaceChildren();
      error.hidden = false;
      byId('visual-status').textContent = 'The selected result could not be loaded.';
    } finally {
      if (request === revision) setBusy(stage, false);
    }
  }

  const buttons = samples.map((sample, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumbnail';
    button.title = sample.title;
    button.setAttribute('aria-label', sample.title);
    const image = new Image();
    image.src = sample.images.rgb.src;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.width = 116;
    image.height = 70;
    button.append(image);
    button.addEventListener('click', () => select(index, true));
    strip.append(button);
    return button;
  });

  function select(index, scroll = false) {
    selected = (index + samples.length) % samples.length;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === selected)));
    if (scroll) {
      const button = buttons[selected];
      strip.scrollTo({
        left: button.offsetLeft - strip.offsetLeft - (strip.clientWidth - button.clientWidth) / 2,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    }
    render();
  }

  byId('visual-prev').addEventListener('click', () => select(selected - 1, true));
  byId('visual-next').addEventListener('click', () => select(selected + 1, true));
  strip.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: samples.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
    buttons[selected].focus({ preventScroll: true });
  });

  function activate(tab) {
    mode = tab.dataset.mode;
    byId('depth-description').hidden = mode !== 'depth';
    byId('comparison-description').hidden = mode !== 'comparison';
    tabs.forEach(item => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      byId(item.getAttribute('aria-controls')).hidden = !active;
    });
    render();
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      target.focus({ preventScroll: true });
      activate(target);
    });
  }
  for (const button of section.querySelectorAll('.visual-retry')) button.addEventListener('click', render);
  window.addEventListener('pagehide', () => viewer.reset());
  select(0);
}
