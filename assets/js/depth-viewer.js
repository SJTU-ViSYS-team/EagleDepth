export class DepthViewer {
  constructor(element) {
    if (!(element instanceof HTMLElement)) throw new TypeError('DepthViewer needs an HTML element.');
    this.element = element;
    this._generation = 0;
    this._pending = null;
    this._current = null;
    this._destroyed = false;
    this._frame = 0;
    this._mode = null;
    this._pointerId = null;
    this._position = { x: 0.5, y: 0.5 };
    this._patchSize = 512;
    this._wheelDelta = 0;
    this._listeners = new AbortController();

    element.classList.add('depth-pair');
    element.innerHTML = `
      <figure class="depth-pane">
        <figcaption class="depth-pane-label">RGB</figcaption>
        <div class="depth-rgb-frame" tabindex="0" role="group"
          aria-label="RGB detail explorer. Hover or drag to inspect. Arrow keys move, plus and minus zoom, Escape restores the full view.">
          <img alt="RGB input" draggable="false">
          <div class="depth-lens" aria-hidden="true"><canvas></canvas></div>
          <span class="depth-zoom" aria-hidden="true"></span>
        </div>
      </figure>
      <figure class="depth-pane">
        <figcaption class="depth-pane-label">EagleDepth</figcaption>
        <div class="depth-output-frame">
          <canvas class="depth-canvas" role="img" aria-label="EagleDepth depth map"></canvas>
        </div>
      </figure>`;
    this._rgbFrame = element.querySelector('.depth-rgb-frame');
    this._rgbImage = this._rgbFrame.querySelector('img');
    this._outputFrame = element.querySelector('.depth-output-frame');
    this._canvas = element.querySelector('.depth-canvas');
    this._context = this._canvas.getContext('2d');
    this._lens = element.querySelector('.depth-lens');
    this._lensCanvas = this._lens.querySelector('canvas');
    this._lensContext = this._lensCanvas.getContext('2d');
    this._zoom = element.querySelector('.depth-zoom');
    if (!this._context || !this._lensContext) throw new Error('Canvas rendering is unavailable.');

    this._bindInputs();
    this._resizeObserver = new ResizeObserver(() => this._schedule());
    this._resizeObserver.observe(this._rgbFrame);
    this._resizeObserver.observe(this._outputFrame);
    window.addEventListener('resize', () => this._schedule(), { signal: this._listeners.signal });
  }

  async load(sample) {
    if (this._destroyed) return false;
    const generation = ++this._generation;
    this._cancelPending();
    const rgb = sample?.images?.rgb;
    const depth = sample?.images?.ours;
    if (!rgb?.src || !depth?.src) throw new Error('The scene needs RGB and EagleDepth images.');
    const pending = {
      rgb: this._decodeImage(rgb.src),
      depth: this._decodeImage(depth.src),
    };
    this._pending = pending;
    this.element.setAttribute('aria-busy', 'true');
    try {
      const [rgbImage, depthImage] = await Promise.all([pending.rgb.promise, pending.depth.promise]);
      if (generation !== this._generation || this._destroyed) return false;
      // Both images become visible together. A slower earlier scene cannot replace them.
      this.reset();
      const previous = this._current;
      rgbImage.alt = sample.title ? `${sample.title} — RGB input` : 'RGB input';
      rgbImage.draggable = false;
      this._rgbImage.replaceWith(rgbImage);
      this._rgbImage = rgbImage;
      this._current = { rgb: rgbImage, depth: depthImage };
      this._maximumPatch = Math.min(512, Math.max(rgbImage.naturalWidth, rgbImage.naturalHeight));
      this._minimumPatch = Math.min(64, this._maximumPatch);
      this._patchSize = this._maximumPatch;
      this._position = { x: 0.5, y: 0.5 };
      const aspect = `${depthImage.naturalWidth} / ${depthImage.naturalHeight}`;
      this.element.style.setProperty('--depth-aspect', depthImage.naturalWidth / depthImage.naturalHeight);
      this._rgbFrame.style.aspectRatio = aspect;
      this._outputFrame.style.aspectRatio = aspect;
      if (previous) {
        previous.rgb.removeAttribute('src');
        previous.depth.removeAttribute('src');
      }
      this._schedule();
      return true;
    } catch (error) {
      if (generation !== this._generation || this._destroyed) return false;
      pending.rgb.cancel();
      pending.depth.cancel();
      throw error;
    } finally {
      if (this._pending === pending) {
        this._pending = null;
        this.element.removeAttribute('aria-busy');
      }
    }
  }

  reset() {
    this._mode = null;
    this._wheelDelta = 0;
    this._patchSize = this._maximumPatch || 512;
    this._rgbFrame.classList.remove('is-active');
    this._lens.classList.remove('is-active');
    this._zoom.classList.remove('is-active');
    if (this._pointerId !== null) {
      const pointerId = this._pointerId;
      this._pointerId = null;
      if (this._rgbFrame.hasPointerCapture(pointerId)) {
        this._rgbFrame.releasePointerCapture(pointerId);
      }
    }
    this._schedule();
  }

  destroy() {
    if (this._destroyed) return;
    this.reset();
    this._destroyed = true;
    ++this._generation;
    this._cancelPending();
    this._listeners.abort();
    this._resizeObserver.disconnect();
    cancelAnimationFrame(this._frame);
    if (this._current) {
      this._current.rgb.removeAttribute('src');
      this._current.depth.removeAttribute('src');
      this._current = null;
    }
    this.element.replaceChildren();
    this.element.classList.remove('depth-pair');
    this.element.removeAttribute('aria-busy');
  }

  _decodeImage(src) {
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    let rejectLoad;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    const promise = new Promise((resolve, reject) => {
      rejectLoad = reject;
      image.onload = async () => {
        try {
          await image.decode();
          if (settled) return;
          if (!image.naturalWidth || !image.naturalHeight) throw new Error(`Empty image: ${src}`);
          settled = true;
          cleanup();
          resolve(image);
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
      };
      image.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Cannot load image: ${src}`));
      };
      image.src = src;
    });
    return {
      image,
      promise,
      cancel() {
        if (!settled) {
          settled = true;
          cleanup();
          rejectLoad(new DOMException('Scene loading was superseded.', 'AbortError'));
        }
        image.removeAttribute('src');
      },
    };
  }

  _cancelPending() {
    if (!this._pending) return;
    this._pending.rgb.cancel();
    this._pending.depth.cancel();
    this._pending = null;
    this.element.removeAttribute('aria-busy');
  }

  _bindInputs() {
    const frame = this._rgbFrame;
    const options = { signal: this._listeners.signal };
    frame.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      this._activate('mouse');
      this._movePointer(event);
    }, options);
    frame.addEventListener('pointermove', event => {
      if (!this._mode || (event.pointerType !== 'mouse' && event.pointerId !== this._pointerId)) return;
      this._movePointer(event);
    }, options);
    frame.addEventListener('pointerleave', event => {
      if (event.pointerType === 'mouse' && this._mode === 'mouse') this.reset();
    }, options);
    frame.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || !this._current || this._pointerId !== null) return;
      event.preventDefault();
      this._activate('touch');
      this._pointerId = event.pointerId;
      frame.setPointerCapture(event.pointerId);
      this._movePointer(event);
    }, options);
    const release = event => {
      if (event.pointerId === this._pointerId) this.reset();
    };
    frame.addEventListener('pointerup', release, options);
    frame.addEventListener('pointercancel', release, options);
    frame.addEventListener('lostpointercapture', release, options);
    frame.addEventListener('wheel', event => {
      if (!this._mode || !this._current || !event.deltaY || event.ctrlKey) return;
      event.preventDefault();
      this._wheelDelta += Math.sign(event.deltaY);
      this._schedule();
    }, { ...options, passive: false });
    frame.addEventListener('keydown', event => this._handleKey(event), options);
    frame.addEventListener('blur', () => {
      if (this._mode === 'keyboard') this.reset();
    }, options);
  }

  _activate(mode) {
    if (!this._current) return;
    if (!this._mode) this._patchSize = this._maximumPatch;
    this._mode = mode;
    this._rgbFrame.classList.add('is-active');
    this._lens.classList.add('is-active');
    this._zoom.classList.add('is-active');
  }

  _movePointer(event) {
    if (!this._current) return;
    const bounds = this._rgbFrame.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    this._position = {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
    this._schedule();
  }

  _handleKey(event) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Escape'];
    if (!this._current || !keys.includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      this.reset();
      return;
    }
    this._activate('keyboard');
    const step = event.shiftKey ? 0.1 : 0.025;
    if (event.key === 'ArrowLeft') this._position.x -= step;
    if (event.key === 'ArrowRight') this._position.x += step;
    if (event.key === 'ArrowUp') this._position.y -= step;
    if (event.key === 'ArrowDown') this._position.y += step;
    this._position.x = Math.max(0, Math.min(1, this._position.x));
    this._position.y = Math.max(0, Math.min(1, this._position.y));
    if (event.key === '+' || event.key === '=') this._wheelDelta -= 1;
    if (event.key === '-' || event.key === '_') this._wheelDelta += 1;
    this._schedule();
  }

  _schedule() {
    if (this._destroyed || this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._render();
    });
  }

  _sizeCanvas(canvas, width, height) {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  }

  _render() {
    if (!this._current || this._destroyed) return;
    const bounds = this._rgbFrame.getBoundingClientRect();
    const output = this._outputFrame.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !output.width || !output.height) return;
    this._sizeCanvas(this._canvas, output.width, output.height);
    this._context.imageSmoothingEnabled = true;
    this._context.imageSmoothingQuality = 'high';
    const { rgb, depth } = this._current;
    this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
    if (!this._mode) {
      this._context.drawImage(depth, 0, 0, this._canvas.width, this._canvas.height);
      return;
    }
    if (this._wheelDelta) {
      this._patchSize = Math.max(this._minimumPatch,
        Math.min(this._maximumPatch, this._patchSize * Math.pow(1.1, this._wheelDelta)));
      this._wheelDelta = 0;
    }

    // The same normalized rectangle addresses both native grids. Its aspect ratio
    // matches the prediction, including when the source RGB has a different ratio.
    const fraction = Math.min(1, this._patchSize / Math.max(rgb.naturalWidth, rgb.naturalHeight));
    const half = fraction / 2;
    const x = Math.max(half, Math.min(1 - half, this._position.x));
    const y = Math.max(half, Math.min(1 - half, this._position.y));
    this._context.drawImage(depth,
      (x - half) * depth.naturalWidth, (y - half) * depth.naturalHeight,
      fraction * depth.naturalWidth, fraction * depth.naturalHeight,
      0, 0, this._canvas.width, this._canvas.height);

    const lensSize = Math.min(150, bounds.width, bounds.height);
    const lensLeft = Math.max(0, Math.min(bounds.width - lensSize, x * bounds.width - lensSize / 2));
    const lensTop = Math.max(0, Math.min(bounds.height - lensSize, y * bounds.height - lensSize / 2));
    Object.assign(this._lens.style, {
      width: `${lensSize}px`, height: `${lensSize}px`, left: `${lensLeft}px`, top: `${lensTop}px`,
    });
    const lensInnerSize = Math.max(1, this._lens.clientWidth);
    this._sizeCanvas(this._lensCanvas, lensInnerSize, lensInnerSize);
    const lensWidth = this._lensCanvas.width;
    const lensHeight = this._lensCanvas.height;
    const aspect = depth.naturalWidth / depth.naturalHeight;
    const drawWidth = aspect >= 1 ? lensWidth * aspect : lensWidth;
    const drawHeight = aspect >= 1 ? lensHeight : lensHeight / aspect;
    this._lensContext.imageSmoothingEnabled = true;
    this._lensContext.imageSmoothingQuality = 'high';
    this._lensContext.clearRect(0, 0, lensWidth, lensHeight);
    this._lensContext.drawImage(rgb,
      (x - half) * rgb.naturalWidth, (y - half) * rgb.naturalHeight,
      fraction * rgb.naturalWidth, fraction * rgb.naturalHeight,
      (lensWidth - drawWidth) / 2, (lensHeight - drawHeight) / 2, drawWidth, drawHeight);
    this._zoom.textContent = `Zoom: ${(this._maximumPatch / this._patchSize).toFixed(1)}×`;
  }
}
