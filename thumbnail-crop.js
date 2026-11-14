const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const THUMB_SIZE = 256;

export function normalizeCrop(crop) {
    if (crop && Number.isFinite(crop.x) && Number.isFinite(crop.y)
        && Number.isFinite(crop.zoom) && crop.zoom >= MIN_ZOOM && crop.zoom <= MAX_ZOOM
        && crop.x >= 0 && crop.x <= 1 && crop.y >= 0 && crop.y <= 1) {
        return { x: crop.x, y: crop.y, zoom: crop.zoom };
    }
    return null;
}

export function encodeImage(image, outputWidth, outputHeight, quality, source = {}) {
    const { x = 0, y = 0, width = image.naturalWidth, height = image.naturalHeight } = source;
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, outputWidth, outputHeight);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, x, y, width, height, 0, 0, outputWidth, outputHeight);

    const webp = canvas.toDataURL('image/webp', quality);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function cropBounds(width, height, zoom, centerX, centerY) {
    const size = Math.min(width, height) / zoom;
    return {
        x: clamp(centerX - size / 2, 0, width - size),
        y: clamp(centerY - size / 2, 0, height - size),
        size,
    };
}

export function openThumbnailCrop(source, initialCrop, signal, onApply) {
    const dialog = document.createElement('dialog');
    dialog.className = 'po-crop-dialog';
    dialog.setAttribute('aria-labelledby', 'po-crop-title');
    dialog.innerHTML = `
        <h2 id="po-crop-title">Crop thumbnail</h2>
        <p id="po-crop-help">Drag or use the arrow keys to position the image. Scroll or use the slider to zoom.</p>
        <div class="po-crop-frame" tabindex="0" role="group" aria-label="Thumbnail preview" aria-describedby="po-crop-help"></div>
        <label class="po-crop-zoom">
            <span>Zoom</span>
            <input type="range" min="${MIN_ZOOM}" max="${MAX_ZOOM}" step="0.01" value="${MIN_ZOOM}" disabled>
            <output>100%</output>
        </label>
        <p class="po-crop-status" role="status">Loading image…</p>
        <div class="po-crop-actions">
            <button type="button" class="menu_button po-crop-reset" disabled>Reset</button>
            <button type="button" class="menu_button po-crop-cancel">Cancel</button>
            <button type="button" class="menu_button po-crop-apply" disabled>Apply</button>
        </div>`;

    const frame = dialog.querySelector('.po-crop-frame');
    const slider = dialog.querySelector('input');
    const readout = dialog.querySelector('output');
    const status = dialog.querySelector('.po-crop-status');
    const reset = dialog.querySelector('.po-crop-reset');
    const apply = dialog.querySelector('.po-crop-apply');
    const image = new Image();
    image.alt = '';
    image.draggable = false;
    // Anonymous CORS accepts cooperative remote hosts without sending them credentials.
    image.crossOrigin = 'anonymous';
    frame.append(image);

    let zoom = MIN_ZOOM;
    let crop = null;
    let pointer = null;
    const resize = new ResizeObserver(paint);

    function paint() {
        if (!crop) {
            return;
        }
        const scale = frame.getBoundingClientRect().width / crop.size;
        image.style.transform = `translate(${-crop.x * scale}px, ${-crop.y * scale}px) scale(${scale})`;
        slider.value = String(zoom);
        readout.value = `${Math.round(zoom * 100)}%`;
    }

    function position(nextZoom, x, y) {
        zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
        crop = cropBounds(image.naturalWidth, image.naturalHeight, zoom, x, y);
        paint();
    }

    function adjust(nextZoom, dx = 0, dy = 0) {
        position(nextZoom, crop.x + crop.size / 2 + dx, crop.y + crop.size / 2 + dy);
    }

    function cleanup() {
        dialog.removeEventListener('close', cleanup);
        signal.removeEventListener('abort', close);
        resize.disconnect();
        image.onload = image.onerror = null;
        image.removeAttribute('src');
        dialog.remove();
    }

    function close() {
        dialog.close();
        cleanup();
    }

    dialog.addEventListener('close', cleanup, { once: true });
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.querySelector('.po-crop-cancel').addEventListener('click', close);
    signal.addEventListener('abort', close, { once: true });

    slider.addEventListener('input', () => adjust(Number(slider.value)));
    reset.addEventListener('click', () => position(MIN_ZOOM, image.naturalWidth / 2, image.naturalHeight / 2));
    frame.addEventListener('wheel', event => {
        event.preventDefault();
        if (crop && event.deltaY) {
            adjust(zoom * (event.deltaY < 0 ? 1.09 : 1 / 1.09));
        }
    }, { passive: false });

    frame.addEventListener('keydown', event => {
        if (!crop) {
            return;
        }
        const step = crop.size * (event.shiftKey ? 0.12 : 0.03);
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (Object.hasOwn(moves, event.key)) {
            event.preventDefault();
            adjust(zoom, ...moves[event.key]);
        }
    });

    frame.addEventListener('pointerdown', event => {
        if (!crop || pointer || event.button !== 0) {
            return;
        }
        frame.focus({ preventScroll: true });
        frame.setPointerCapture(event.pointerId);
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        frame.classList.add('po-crop-dragging');
    });

    frame.addEventListener('pointermove', event => {
        if (pointer?.id !== event.pointerId) {
            return;
        }
        const units = crop.size / frame.getBoundingClientRect().width;
        adjust(zoom, (pointer.x - event.clientX) * units, (pointer.y - event.clientY) * units);
        pointer.x = event.clientX;
        pointer.y = event.clientY;
    });

    frame.addEventListener('lostpointercapture', () => {
        pointer = null;
        frame.classList.remove('po-crop-dragging');
    });

    apply.addEventListener('click', () => {
        try {
            const { x, y, size } = crop;
            const thumb = encodeImage(image, THUMB_SIZE, THUMB_SIZE, 0.82, { x, y, width: size, height: size });
            if (!onApply(thumb, {
                x: (x + size / 2) / image.naturalWidth,
                y: (y + size / 2) / image.naturalHeight,
                zoom,
            })) {
                throw new Error('Invalid thumbnail output');
            }
        } catch (error) {
            status.textContent = error.name === 'SecurityError'
                ? 'This image host blocks thumbnail cropping (CORS). You can keep using the image as is.'
                : 'Could not create the thumbnail. Your previous thumbnail is intact.';
            return;
        }
        close();
    });

    image.onload = () => {
        const { naturalWidth: width, naturalHeight: height } = image;
        if (!width || !height) {
            image.onerror();
            return;
        }
        image.style.width = `${width}px`;
        image.style.height = `${height}px`;
        const saved = normalizeCrop(initialCrop) ?? { x: 0.5, y: 0.5, zoom: MIN_ZOOM };
        position(saved.zoom, saved.x * width, saved.y * height);
        status.textContent = '';
        slider.disabled = reset.disabled = apply.disabled = false;
        frame.classList.add('po-crop-ready');
        resize.observe(frame);
    };

    image.onerror = () => {
        image.removeAttribute('src');
        status.textContent = /^data:/i.test(source)
            ? 'Could not open this image for cropping. Your previous thumbnail is intact.'
            : 'Could not load this URL for cropping. The host may block canvas access (CORS), or the image may be unavailable. You can keep using the URL as is.';
    };

    document.body.append(dialog);
    dialog.showModal();
    frame.focus();
    image.src = source;
}
