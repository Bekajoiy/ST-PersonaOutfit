/*
 * Persona Outfits — a floating outfit manager for SillyTavern.
 *
 * Wearing an outfit rewrites the [outfit: ...] placeholder in the active
 * persona's description and shows the outfit's image in a draggable panel.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { user_avatar, setPersonaDescription } from '../../../personas.js';

const MODULE_NAME = 'persona_outfits';
const PLACEHOLDER = '[outfit: ]';
const OUTFIT_RE = /\[outfit\s*:[^\]]*\]/gi;
const IMAGE_MAX_EDGE = 1024;
const THUMB_MAX_EDGE = 160;
const MAX_IMAGE_SOURCE_LENGTH = 4_000_000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const RESERVED_PERSONA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ctx = getContext();

let settings = null;
let editingId = null;
let draftOutfit = null;
let lastPersonaKey = null;
let displayedOutfitId = null;
let resizeTimer = null;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function defaultSettings() {
    return {
        outfits: [], // Legacy global list; moved into outfitsByPersona on first use.
        outfitsByPersona: {},
        appendIfMissing: true,
        showImagePanel: true,
        showTextPanel: true,
        panelOpen: false,
        panel: { left: null, top: null },
        imagePanel: { left: null, top: null },
        imagePanelSize: { width: null, height: null },
        textPanel: { left: null, top: null },
        textPanelSize: { width: null, height: null },
        toggle: { left: null, top: null },
    };
}

function loadSettings() {
    const stored = extension_settings[MODULE_NAME] ?? {};
    settings = { ...defaultSettings(), ...stored };

    // Migrate the old single "autoShowImage" switch to the two independent ones.
    if (stored.showImagePanel === undefined && stored.showTextPanel === undefined && stored.autoShowImage !== undefined) {
        settings.showImagePanel = !!stored.autoShowImage;
        settings.showTextPanel = !!stored.autoShowImage;
    }
    settings.showImagePanel = !!settings.showImagePanel;
    settings.showTextPanel = !!settings.showTextPanel;
    delete settings.autoShowImage;
    delete settings.activeOutfitId;

    settings.panel = { ...defaultSettings().panel, ...(stored.panel ?? {}) };
    settings.imagePanel = { ...defaultSettings().imagePanel, ...(stored.imagePanel ?? {}) };
    settings.imagePanelSize = { ...defaultSettings().imagePanelSize, ...(stored.imagePanelSize ?? {}) };
    settings.textPanel = { ...defaultSettings().textPanel, ...(stored.textPanel ?? {}) };
    settings.textPanelSize = { ...defaultSettings().textPanelSize, ...(stored.textPanelSize ?? {}) };
    settings.toggle = { ...defaultSettings().toggle, ...(stored.toggle ?? {}) };
    settings.outfits = Array.isArray(settings.outfits)
        ? settings.outfits.filter(outfit => outfit && typeof outfit === 'object').map(normalizeOutfit)
        : [];

    // Rebuild with a null prototype, skip dangerous keys, and prune empty
    // persona lists so switching personas does not accumulate empty entries.
    const source = settings.outfitsByPersona;
    const clean = Object.create(null);
    if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [key, list] of Object.entries(source)) {
            if (!isSafePersonaKey(key) || !Array.isArray(list)) {
                continue;
            }
            const normalized = list
                .filter(outfit => outfit && typeof outfit === 'object')
                .map(normalizeOutfit);
            if (normalized.length) {
                clean[key] = normalized;
            }
        }
    }
    settings.outfitsByPersona = clean;

    extension_settings[MODULE_NAME] = settings;
}

function normalizeOutfit(outfit) {
    return {
        id: String(outfit.id || uid()),
        name: String(outfit.name ?? ''),
        description: String(outfit.description ?? ''),
        image: typeof outfit.image === 'string' ? outfit.image : '',
        thumb: typeof outfit.thumb === 'string' ? outfit.thumb : '',
    };
}

/* ------------------------------------------------------------------ */
/* Persona ↔ outfits                                                   */
/* ------------------------------------------------------------------ */

function isSafePersonaKey(key) {
    return typeof key === 'string' && key.length > 0 && !RESERVED_PERSONA_KEYS.has(key);
}

function getActivePersonaKey() {
    return isSafePersonaKey(user_avatar) ? user_avatar : '';
}

function getPersonaName(avatar = getActivePersonaKey()) {
    if (!isSafePersonaKey(avatar)) {
        return '';
    }
    const name = power_user.personas?.[avatar];
    return name ? String(name).trim() : '';
}

function ensureOutfitsByPersonaContainer() {
    if (!settings.outfitsByPersona || typeof settings.outfitsByPersona !== 'object' || Array.isArray(settings.outfitsByPersona)) {
        settings.outfitsByPersona = Object.create(null);
    }
}

function personaOutfitsList(avatar) {
    if (!isSafePersonaKey(avatar)) {
        return null;
    }
    ensureOutfitsByPersonaContainer();
    const list = settings.outfitsByPersona[avatar];
    return Array.isArray(list) ? list : null;
}

function ensurePersonaOutfits(avatar) {
    if (!isSafePersonaKey(avatar)) {
        return null;
    }
    ensureOutfitsByPersonaContainer();
    if (!Array.isArray(settings.outfitsByPersona[avatar])) {
        settings.outfitsByPersona[avatar] = [];
    }
    return settings.outfitsByPersona[avatar];
}

function migrateLegacyOutfits(avatar) {
    if (!isSafePersonaKey(avatar)) {
        return;
    }

    const legacy = Array.isArray(settings.outfits) ? settings.outfits : [];
    if (!legacy.length) {
        return;
    }

    const target = ensurePersonaOutfits(avatar);
    if (!target) {
        return;
    }

    const existingIds = new Set(target.map(outfit => outfit.id));
    let moved = 0;

    for (const outfit of legacy) {
        if (!existingIds.has(outfit.id)) {
            target.push(outfit);
            existingIds.add(outfit.id);
            moved++;
        }
    }

    settings.outfits = [];
    saveSettings();

    if (moved) {
        const name = getPersonaName(avatar) || 'the current persona';
        toastr.info(`Existing outfits were assigned to ${escapeHtml(name)}.`, 'Persona Outfits', { escapeHtml: false });
    }
}

function getPersonaOutfits(avatar = getActivePersonaKey()) {
    if (!isSafePersonaKey(avatar)) {
        return [];
    }
    migrateLegacyOutfits(avatar);
    return personaOutfitsList(avatar) ?? [];
}

function saveSettings() {
    saveSettingsDebounced();
}

function uid() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `outfit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/* UI construction                                                     */
/* ------------------------------------------------------------------ */

function buildUi() {
    $('body').append(`
        <button id="po-toggle" class="po-toggle" title="Persona outfits" aria-label="Persona outfits">
            <i class="fa-solid fa-shirt"></i>
        </button>

        <div id="po-panel" class="po-panel po-hidden" role="dialog" aria-label="Persona outfits">
            <div class="po-header">
                <i class="fa-solid fa-grip-vertical po-grip"></i>
                <span class="po-title">Outfits</span>
                <span id="po-persona-name" class="po-persona-name" title="Persona"></span>
                <button id="po-close" class="po-icon-btn po-close" title="Close" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div id="po-list" class="po-list"></div>
            <div class="po-footer">
                <button id="po-add" class="menu_button po-add">
                    <i class="fa-solid fa-plus"></i> New outfit
                </button>
                <button id="po-clear" class="menu_button po-clear" title="Empty the [outfit: ] placeholder">
                    Clear
                </button>
            </div>
        </div>

        <div id="po-image-panel" class="po-image-panel po-hidden" role="dialog" aria-label="Outfit image">
            <div class="po-image-header">
                <i class="fa-solid fa-grip-vertical po-grip"></i>
                <span id="po-image-title" class="po-image-title"></span>
                <button id="po-image-close" class="po-icon-btn po-image-close" title="Close" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="po-image-wrap">
                <img id="po-image" alt="Current outfit">
            </div>
            <div id="po-image-resize" class="po-resize-grip" title="Drag to resize" aria-hidden="true"></div>
        </div>

        <div id="po-text-panel" class="po-text-panel po-hidden" role="dialog" aria-label="Outfit description">
            <div class="po-text-header">
                <i class="fa-solid fa-grip-vertical po-grip"></i>
                <span id="po-text-title" class="po-text-title"></span>
                <button id="po-text-close" class="po-icon-btn po-text-close" title="Close" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div id="po-text-body" class="po-text-body"></div>
            <div id="po-text-resize" class="po-resize-grip" title="Drag to resize" aria-hidden="true"></div>
        </div>
    `);

    const $container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $container.append(`
        <div class="po-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Persona Outfits</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="po-setting-append">
                        <span>Add <code>[outfit: ]</code> to the persona description if it is missing</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="po-setting-show-image">
                        <span>Open the outfit image window when wearing an outfit</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="po-setting-show-text">
                        <span>Open the outfit description window when wearing an outfit</span>
                    </label>
                    <div class="po-help">
                        Outfits are saved per persona: switching persona switches the list.
                        Put <code>[outfit: ]</code> anywhere in your persona description; wearing an outfit fills it in
                        without touching the rest of the description.
                    </div>
                    <button id="po-reset-positions" class="menu_button">Reset floating windows</button>
                </div>
            </div>
        </div>
    `);

    $('#po-setting-append')
        .prop('checked', !!settings.appendIfMissing)
        .on('change', function () {
            settings.appendIfMissing = !!this.checked;
            saveSettings();
        });

    $('#po-setting-show-image')
        .prop('checked', !!settings.showImagePanel)
        .on('change', function () {
            settings.showImagePanel = !!this.checked;
            saveSettings();
        });

    $('#po-setting-show-text')
        .prop('checked', !!settings.showTextPanel)
        .on('change', function () {
            settings.showTextPanel = !!this.checked;
            saveSettings();
        });

    $('#po-reset-positions').on('click', () => {
        settings.panel = { left: null, top: null };
        settings.imagePanel = { left: null, top: null };
        settings.imagePanelSize = { width: null, height: null };
        settings.textPanel = { left: null, top: null };
        settings.textPanelSize = { width: null, height: null };
        settings.toggle = { left: null, top: null };

        $('#po-panel, #po-image-panel, #po-text-panel, #po-toggle').css({ left: '', top: '', right: '', bottom: '' });
        $('#po-image-panel, #po-text-panel').css({ width: '', height: '', maxHeight: '' });
        applyImagePanelSize();
        applyTextPanelSize();
        positionToggle();

        if (settings.panelOpen) {
            placeDefault(document.getElementById('po-panel'), 'panel');
        }

        const imagePanel = document.getElementById('po-image-panel');
        if (imagePanel && !imagePanel.classList.contains('po-hidden')) {
            placeDefault(imagePanel, 'image');
        }

        const textPanel = document.getElementById('po-text-panel');
        if (textPanel && !textPanel.classList.contains('po-hidden')) {
            placeTextDefault();
            clampIntoView(textPanel);
        }

        saveSettings();
        toastr.info('Floating windows reset.', 'Persona Outfits');
    });

    makeToggleDraggable();
    $('#po-close').on('click', () => setPanelOpen(false));
    $('#po-add').on('click', addOutfit);
    $('#po-clear').on('click', clearOutfit);
    $('#po-image-close').on('click', hideImagePanel);
    $('#po-text-close').on('click', hideTextPanel);

    $('#po-image').on('load', () => {
        const panel = document.getElementById('po-image-panel');
        if (!panel || panel.classList.contains('po-hidden')) {
            return;
        }
        if (!hasSavedPosition(settings.imagePanel)) {
            placeDefault(panel, 'image');
        }
        clampIntoView(panel);

        const textPanel = document.getElementById('po-text-panel');
        if (textPanel && !textPanel.classList.contains('po-hidden') && !hasSavedPosition(settings.textPanel)) {
            placeTextDefault();
            clampIntoView(textPanel);
        }
    });

    makeDraggable(
        document.getElementById('po-panel'),
        document.querySelector('#po-panel .po-header'),
        'panel',
    );
    makeDraggable(
        document.getElementById('po-image-panel'),
        document.querySelector('#po-image-panel .po-image-header'),
        'imagePanel',
    );
    makeDraggable(
        document.getElementById('po-text-panel'),
        document.querySelector('#po-text-panel .po-text-header'),
        'textPanel',
    );
    makeResizable(
        document.getElementById('po-image-panel'),
        document.getElementById('po-image-resize'),
        'imagePanelSize',
        'imagePanel',
    );
    makeResizable(
        document.getElementById('po-text-panel'),
        document.getElementById('po-text-resize'),
        'textPanelSize',
        'textPanel',
    );

    restorePosition(document.getElementById('po-panel'), settings.panel);
    restorePosition(document.getElementById('po-image-panel'), settings.imagePanel);
    restorePosition(document.getElementById('po-text-panel'), settings.textPanel);
    applyImagePanelSize();
    applyTextPanelSize();
}

function setPanelOpen(open) {
    settings.panelOpen = !!open;
    updatePanelVisibility();
    saveSettings();
}

function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        positionToggle();
        applyImagePanelSize();
        applyTextPanelSize();

        if (settings.panelOpen) {
            const panel = document.getElementById('po-panel');
            if (hasSavedPosition(settings.panel)) {
                clampIntoView(panel);
            } else {
                placeDefault(panel, 'panel');
            }
        }

        const imagePanel = document.getElementById('po-image-panel');
        if (imagePanel && !imagePanel.classList.contains('po-hidden')) {
            if (hasSavedPosition(settings.imagePanel)) {
                clampIntoView(imagePanel);
            } else {
                placeDefault(imagePanel, 'image');
            }
        }

        const textPanel = document.getElementById('po-text-panel');
        if (textPanel && !textPanel.classList.contains('po-hidden')) {
            if (hasSavedPosition(settings.textPanel)) {
                clampIntoView(textPanel);
            } else {
                placeTextDefault();
                clampIntoView(textPanel);
            }
        }
    }, 150);
}

function updatePanelVisibility() {
    const panel = document.getElementById('po-panel');
    if (!panel) {
        return;
    }

    const open = !!settings.panelOpen;

    if (open) {
        const wasHidden = panel.classList.contains('po-hidden');
        panel.classList.remove('po-hidden');

        if (wasHidden) {
            // SillyTavern gives <html> an identity transform, so a fixed
            // element's containing block is zero-height. Compute top/left
            // ourselves instead of relying on `bottom`.
            panel.style.visibility = 'hidden';
            if (hasSavedPosition(settings.panel)) {
                restorePosition(panel, settings.panel);
            } else {
                placeDefault(panel, 'panel');
            }
            clampIntoView(panel);
            panel.style.visibility = '';
        }
    } else {
        panel.classList.add('po-hidden');
    }

    $('#po-toggle').toggleClass('po-active', open);
}

/* ------------------------------------------------------------------ */
/* Dragging                                                            */
/* ------------------------------------------------------------------ */

function makeDraggable(panel, handle, settingKey) {
    if (!panel || !handle) {
        return;
    }

    let drag = null;

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button, input, textarea, select, a')) {
            return;
        }

        const rect = panel.getBoundingClientRect();
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;

        drag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
        };

        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is an optimisation; dragging still works without it.
        }
        panel.classList.add('po-dragging');
        event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        const maxLeft = Math.max(0, window.innerWidth - Math.min(panel.offsetWidth, window.innerWidth));
        const maxTop = Math.max(0, window.innerHeight - Math.min(panel.offsetHeight, window.innerHeight - 40));
        const left = clamp(event.clientX - drag.offsetX, 0, maxLeft);
        const top = clamp(event.clientY - drag.offsetY, 0, maxTop);

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    });

    const endDrag = event => {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }
        drag = null;
        panel.classList.remove('po-dragging');
        const rect = panel.getBoundingClientRect();
        settings[settingKey] = { left: Math.round(rect.left), top: Math.round(rect.top) };
        saveSettings();
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
}

function makeToggleDraggable() {
    const button = document.getElementById('po-toggle');
    if (!button) {
        return;
    }

    let drag = null;
    let suppressClickUntil = 0;

    button.addEventListener('pointerdown', event => {
        if (event.button !== 0) {
            return;
        }

        const rect = button.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        };

        try {
            button.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is an optimisation; dragging still works without it.
        }
    });

    button.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 4) {
            return;
        }

        drag.moved = true;
        button.classList.add('po-dragging');

        const rect = button.getBoundingClientRect();
        const left = clamp(event.clientX - drag.offsetX, 0, Math.max(0, window.innerWidth - rect.width));
        const top = clamp(event.clientY - drag.offsetY, 0, Math.max(0, window.innerHeight - rect.height));

        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
    });

    const endDrag = event => {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        const moved = drag.moved;
        drag = null;
        button.classList.remove('po-dragging');

        if (moved) {
            const rect = button.getBoundingClientRect();
            settings.toggle = { left: Math.round(rect.left), top: Math.round(rect.top) };
            saveSettings();

            // The click event fires right after a drag; swallow that one.
            suppressClickUntil = Date.now() + 300;
        }
    };

    button.addEventListener('pointerup', endDrag);
    button.addEventListener('pointercancel', endDrag);
    button.addEventListener('click', event => {
        if (Date.now() < suppressClickUntil) {
            suppressClickUntil = 0;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        setPanelOpen(!settings.panelOpen);
    });
}

function positionToggle() {
    const toggle = document.getElementById('po-toggle');
    if (!toggle) {
        return;
    }

    if (hasSavedPosition(settings.toggle)) {
        restorePosition(toggle, settings.toggle);
        clampIntoView(toggle);
    } else {
        placeDefault(toggle, 'toggle');
    }
}

function makeResizable(panel, handle, sizeKey, positionKey) {
    if (!panel || !handle) {
        return;
    }

    let resize = null;

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) {
            return;
        }

        const rect = panel.getBoundingClientRect();
        resize = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
        };

        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is an optimisation; resizing still works without it.
        }
        panel.style.maxHeight = 'none';
        panel.classList.add('po-resizing');
        event.preventDefault();
        event.stopPropagation();
    });

    handle.addEventListener('pointermove', event => {
        if (!resize || event.pointerId !== resize.pointerId) {
            return;
        }

        const width = clamp(resize.width + (event.clientX - resize.startX), 180, Math.max(180, window.innerWidth - 16));
        const height = clamp(resize.height + (event.clientY - resize.startY), 140, Math.max(140, window.innerHeight - 16));

        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;

        // Keep the whole window on screen; when it grows past the right or
        // bottom edge, slide it left/up instead of stopping the resize.
        const left = Math.max(8, Math.min(resize.left, window.innerWidth - 8 - width));
        const top = Math.max(8, Math.min(resize.top, window.innerHeight - 8 - height));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });

    const endResize = event => {
        if (!resize || event.pointerId !== resize.pointerId) {
            return;
        }

        resize = null;
        panel.classList.remove('po-resizing');

        const rect = panel.getBoundingClientRect();
        settings[sizeKey] = { width: Math.round(rect.width), height: Math.round(rect.height) };
        settings[positionKey] = { left: Math.round(rect.left), top: Math.round(rect.top) };
        saveSettings();

        // If the image window grows, it may cover the description window.
        // Reposition the description only if it is still at its automatic spot.
        if (positionKey === 'imagePanel') {
            const textPanel = document.getElementById('po-text-panel');
            if (textPanel && !textPanel.classList.contains('po-hidden') && !hasSavedPosition(settings.textPanel)) {
                placeTextDefault();
                clampIntoView(textPanel);
            }
        }
    };

    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
}

function hasSavedSize(size) {
    return Number.isFinite(size?.width) && Number.isFinite(size?.height);
}

function applyImagePanelSize() {
    const panel = document.getElementById('po-image-panel');
    if (!panel) {
        return;
    }

    const size = settings.imagePanelSize;
    if (hasSavedSize(size)) {
        const width = clamp(size.width, 180, Math.max(200, window.innerWidth - 16));
        const height = clamp(size.height, 140, Math.max(160, window.innerHeight - 16));
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
    } else {
        panel.style.width = '';
        panel.style.height = '';
    }
}

function applyTextPanelSize() {
    const panel = document.getElementById('po-text-panel');
    if (!panel) {
        return;
    }

    const size = settings.textPanelSize;
    if (hasSavedSize(size)) {
        const width = clamp(size.width, 180, Math.max(200, window.innerWidth - 16));
        const height = clamp(size.height, 100, Math.max(120, window.innerHeight - 16));
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
        panel.style.maxHeight = 'none';
    } else {
        panel.style.width = '';
        panel.style.height = '';
        panel.style.maxHeight = '';
    }
}

function hasSavedPosition(position) {
    return Number.isFinite(position?.left) && Number.isFinite(position?.top);
}

function restorePosition(element, position) {
    if (!element || !hasSavedPosition(position)) {
        return;
    }

    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.left = `${clamp(position.left, 0, Math.max(0, window.innerWidth - 80))}px`;
    element.style.top = `${clamp(position.top, 0, Math.max(0, window.innerHeight - 40))}px`;
}

function placeDefault(element, kind) {
    if (!element) {
        return;
    }

    const rect = element.getBoundingClientRect();
    const width = rect.width || element.offsetWidth || 310;
    const height = rect.height || element.offsetHeight || 180;
    const margin = window.innerWidth <= 600 ? 12 : 18;

    if (kind === 'toggle') {
        element.style.left = `${Math.max(8, window.innerWidth - margin - width)}px`;
        element.style.top = `${Math.max(8, window.innerHeight - margin - height)}px`;
    } else if (kind === 'panel') {
        element.style.left = `${Math.max(8, window.innerWidth - margin - width)}px`;
        element.style.top = `${Math.max(8, window.innerHeight - 76 - height)}px`;
    } else {
        element.style.left = `${Math.max(8, window.innerWidth - margin - width)}px`;
        element.style.top = '96px';
    }

    element.style.right = 'auto';
    element.style.bottom = 'auto';
}

function placeTextDefault() {
    const panel = document.getElementById('po-text-panel');
    if (!panel) {
        return;
    }

    const rect = panel.getBoundingClientRect();
    const width = rect.width || panel.offsetWidth || 300;
    const height = rect.height || panel.offsetHeight || 120;
    const margin = window.innerWidth <= 600 ? 12 : 18;
    let left = Math.max(8, window.innerWidth - margin - width);
    let top = 96;

    const imagePanel = document.getElementById('po-image-panel');
    if (imagePanel && !imagePanel.classList.contains('po-hidden')) {
        const imageRect = imagePanel.getBoundingClientRect();
        const leftOfImage = imageRect.left - 10 - width;
        const belowImage = imageRect.bottom + 10;

        if (leftOfImage >= 8) {
            left = leftOfImage;
            top = imageRect.top;
        } else if (belowImage + height <= window.innerHeight - 8) {
            top = belowImage;
        } else {
            top = Math.max(8, window.innerHeight - margin - height);
        }
    }

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

function clampIntoView(element) {
    if (!element || element.classList.contains('po-hidden')) {
        return;
    }

    const margin = 8;
    const rect = element.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;

    if (rect.right > window.innerWidth - margin) {
        left = window.innerWidth - margin - rect.width;
    }
    if (rect.bottom > window.innerHeight - margin) {
        top = window.innerHeight - margin - rect.height;
    }

    left = Math.max(margin, left);
    top = Math.max(margin, top);

    if (Math.round(left) !== Math.round(rect.left) || Math.round(top) !== Math.round(rect.top)) {
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    }
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/* ------------------------------------------------------------------ */
/* Outfit list                                                         */
/* ------------------------------------------------------------------ */

function updatePersonaHeader(avatar = getActivePersonaKey()) {
    const $name = $('#po-persona-name');
    if (!$name.length) {
        return;
    }

    if (!avatar) {
        $name.text('No persona').attr('title', 'No persona selected');
        return;
    }

    const name = getPersonaName(avatar) || 'Unnamed persona';
    $name.text(name).attr('title', `Persona: ${name}`);
}

function renderList() {
    const $list = $('#po-list');
    if (!$list.length) {
        return;
    }

    document.body.classList.remove('po-reordering');

    const avatar = getActivePersonaKey();
    if (avatar !== lastPersonaKey) {
        lastPersonaKey = avatar;
        editingId = null;
        draftOutfit = null;
    }

    updatePersonaHeader(avatar);

    const outfits = getPersonaOutfits(avatar);
    const scrollTop = $list.scrollTop();
    $list.empty();

    $('#po-add').prop('disabled', !avatar);

    if (!avatar) {
        $list.append('<div class="po-empty">Select a persona to manage its outfits.</div>');
        return;
    }

    if (!outfits.length && !draftOutfit) {
        const name = getPersonaName(avatar);
        $list.append($('<div class="po-empty">').text(
            name ? `No outfits yet for ${name}. Add one below.` : 'No outfits yet for this persona. Add one below.',
        ));
        return;
    }

    const active = getActiveOutfit();

    for (const outfit of outfits) {
        const isActive = active?.id === outfit.id;

        const $row = $('<div>', {
            class: `po-row${isActive ? ' po-active' : ''}`,
            'data-id': outfit.id,
            tabindex: '0',
            role: 'button',
            title: `Wear ${outfit.name || 'this outfit'}`,
        });

        const $handle = $('<span class="po-drag-handle" title="Drag to reorder" aria-label="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>');
        bindReorder($handle, outfit, $row, avatar, $list[0]);

        const $thumb = $('<div class="po-thumb">');
        if (isSafeImage(outfit.thumb || outfit.image)) {
            $('<img alt="" draggable="false">').attr('src', outfit.thumb || outfit.image).appendTo($thumb);
        } else {
            $thumb.append('<i class="fa-solid fa-shirt"></i>');
        }

        const $info = $('<div class="po-info">');
        const $name = $('<div class="po-name">').text(outfit.name || 'Untitled outfit');
        if (isActive) {
            $name.append('<span class="po-badge">Wearing</span>');
        }
        $('<div class="po-sub">')
            .text(snippet(outfit.description) || 'No description')
            .appendTo($info);
        $name.prependTo($info);

        const $actions = $('<div class="po-actions">');
        const $edit = $('<button class="po-icon-btn po-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>');
        const $delete = $('<button class="po-icon-btn po-del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>');
        $edit.on('click', event => {
            event.stopPropagation();
            startEdit(outfit.id);
        });
        $delete.on('click', event => {
            event.stopPropagation();
            deleteOutfit(outfit.id);
        });
        $actions.append($edit, $delete);

        $row.append($handle, $thumb, $info, $actions);

        $row.on('click', () => applyOutfit(outfit.id));
        $row.on('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                applyOutfit(outfit.id);
            }
        });

        $list.append($row);

        if (editingId === outfit.id) {
            $list.append(buildEditor(outfit));
        }
    }

    // A new outfit is kept out of settings until Save; show its editor anyway.
    if (draftOutfit && draftOutfit.id === editingId) {
        $list.append(buildEditor(draftOutfit));
    }

    $list.scrollTop(scrollTop);

    if (settings.panelOpen) {
        const panel = document.getElementById('po-panel');
        if (hasSavedPosition(settings.panel)) {
            clampIntoView(panel);
        } else {
            placeDefault(panel, 'panel');
        }
    }
}

function clearDropIndicators(list) {
    list.querySelectorAll('.po-drop-before, .po-drop-after').forEach(row => {
        row.classList.remove('po-drop-before', 'po-drop-after');
    });
}

function bindReorder($handle, outfit, $row, avatar, list) {
    const handle = $handle[0];
    const row = $row[0];
    let state = null;

    const cleanup = () => {
        state = null;
        row.classList.remove('po-row-reordering');
        document.body.classList.remove('po-reordering');
        clearDropIndicators(list);
    };

    handle.addEventListener('click', event => {
        event.stopPropagation();
    });

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !row.isConnected) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        state = {
            pointerId: event.pointerId,
            startY: event.clientY,
            moved: false,
            targetId: null,
        };

        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is an optimisation; dragging still works without it.
        }

        row.classList.add('po-row-reordering');
        document.body.classList.add('po-reordering');
        clearDropIndicators(list);
    });

    handle.addEventListener('pointermove', event => {
        if (!state || event.pointerId !== state.pointerId) {
            return;
        }
        if (!state.moved && Math.abs(event.clientY - state.startY) < 4) {
            return;
        }

        state.moved = true;

        // Scroll the list when the pointer is near its top or bottom edge.
        const listRect = list.getBoundingClientRect();
        if (event.clientY < listRect.top + 24) {
            list.scrollTop -= 10;
        } else if (event.clientY > listRect.bottom - 24) {
            list.scrollTop += 10;
        }

        const rows = [...list.querySelectorAll('.po-row')].filter(candidate => candidate !== row);
        let target = null;
        for (const candidate of rows) {
            const rect = candidate.getBoundingClientRect();
            if (event.clientY < rect.top + rect.height / 2) {
                target = candidate;
                break;
            }
        }

        clearDropIndicators(list);
        if (target) {
            target.classList.add('po-drop-before');
            state.targetId = target.getAttribute('data-id');
        } else {
            if (rows.length) {
                rows[rows.length - 1].classList.add('po-drop-after');
            }
            state.targetId = null;
        }
    });

    const endDrag = event => {
        if (!state || event.pointerId !== state.pointerId) {
            return;
        }

        const { moved, targetId } = state;
        cleanup();

        try {
            handle.releasePointerCapture(event.pointerId);
        } catch {
            // Ignore.
        }

        if (!moved || !row.isConnected || getActivePersonaKey() !== avatar) {
            return;
        }

        const rows = [...list.querySelectorAll('.po-row')].filter(candidate => candidate !== row);
        const target = targetId ? rows.find(candidate => candidate.getAttribute('data-id') === targetId) : null;
        const dropIndex = target ? rows.indexOf(target) : rows.length;
        const outfits = getPersonaOutfits(avatar);
        const currentIndex = outfits.findIndex(item => item.id === outfit.id);

        if (currentIndex < 0 || dropIndex === currentIndex) {
            return;
        }

        const [movedOutfit] = outfits.splice(currentIndex, 1);
        outfits.splice(dropIndex, 0, movedOutfit);
        saveSettings();
        renderList();
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', cleanup);
}

function addOutfit() {
    const avatar = getActivePersonaKey();
    if (!avatar) {
        toastr.warning('Select a persona first.', 'Persona Outfits');
        return;
    }

    const outfit = {
        id: uid(),
        name: '',
        description: '',
        image: '',
        thumb: '',
    };

    // Keep a new outfit as an unsaved draft until the user clicks Save.
    draftOutfit = outfit;
    settings.panelOpen = true;
    updatePanelVisibility();
    saveSettings();

    editingId = outfit.id;
    renderList();
    focusEditor();
}

function startEdit(id) {
    draftOutfit = null;
    editingId = id;
    renderList();
    focusEditor();
}

function focusEditor() {
    requestAnimationFrame(() => {
        const editor = document.querySelector('.po-editor');
        if (!editor) {
            return;
        }
        editor.scrollIntoView({ block: 'nearest' });
        editor.querySelector('.po-name-input')?.focus();
    });
}

function buildEditor(outfit) {
    const draft = {
        image: outfit.image || '',
        thumb: outfit.thumb || '',
    };

    const $editor = $('<div class="po-editor">').attr('data-id', outfit.id);

    const $nameField = $('<label class="po-field"><span>Name</span></label>');
    const $name = $('<input type="text" class="text_pole po-name-input" placeholder="e.g. Gym">')
        .val(outfit.name || '');
    $nameField.append($name);

    const $descField = $('<label class="po-field"><span>Description (goes into the persona)</span></label>');
    const $desc = $('<textarea class="text_pole po-textarea" rows="3" placeholder="e.g. black leggings, oversized hoodie and trainers">')
        .val(outfit.description || '');
    $descField.append($desc);

    const $imageRow = $('<div class="po-editor-image">');

    const $drop = $('<div class="po-drop" title="Click or drop an image">');
    const $preview = $('<img class="po-preview" alt="Outfit preview">');
    const $empty = $('<div class="po-drop-empty"><i class="fa-solid fa-image"></i><span>Click or drop image</span></div>');
    $drop.append($preview, $empty);

    const $tools = $('<div class="po-image-tools">');
    const $file = $('<input type="file" class="po-file" accept="image/*" hidden>');
    const $pick = $('<button class="menu_button po-pick-image">Choose image…</button>');
    const $url = $('<input type="text" class="text_pole po-image-url" placeholder="…or paste an image URL">');
    const $remove = $('<button class="menu_button po-remove-image">Remove</button>');
    $tools.append($pick, $file, $url, $remove);

    $imageRow.append($drop, $tools);

    const $actions = $('<div class="po-editor-actions">');
    const $cancel = $('<button class="menu_button po-cancel">Cancel</button>');
    const $save = $('<button class="menu_button po-save">Save</button>');
    $actions.append($cancel, $save);

    $editor.append($nameField, $descField, $imageRow, $actions);

    const renderPreview = () => {
        if (isSafeImage(draft.image)) {
            $preview.attr('src', draft.image).removeClass('po-hidden');
            $empty.addClass('po-hidden');
        } else {
            $preview.attr('src', '').addClass('po-hidden');
            $empty.removeClass('po-hidden');
        }
    };

    const applyImage = (image, thumb) => {
        draft.image = image || '';
        draft.thumb = thumb || image || '';
        $url.val(/^https?:/i.test(draft.image) ? draft.image : '');
        renderPreview();
    };

    const readFile = async file => {
        if (!file) {
            return;
        }
        if (!String(file.type || '').startsWith('image/')) {
            toastr.warning('That file is not an image.', 'Persona Outfits');
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            toastr.warning('That image is too large (max 20 MB).', 'Persona Outfits');
            return;
        }

        $save.prop('disabled', true);
        try {
            const images = await fileToOutfitImages(file);
            if (!isSafeImage(images.image) || !isSafeImage(images.thumb)) {
                toastr.warning('That image could not be reduced to a safe size.', 'Persona Outfits');
                return;
            }
            applyImage(images.image, images.thumb);
        } catch (error) {
            console.error('[Persona Outfits] Failed to process image', error);
            toastr.error('Could not read that image.', 'Persona Outfits');
        } finally {
            $save.prop('disabled', false);
        }
    };

    $drop.on('click', () => $file.trigger('click'));
    $pick.on('click', () => $file.trigger('click'));
    $file.on('change', async function () {
        await readFile(this.files?.[0]);
        $(this).val('');
    });

    $drop.on('dragover', event => {
        event.preventDefault();
        $drop.addClass('po-drop-hover');
    });
    $drop.on('dragleave drop', () => $drop.removeClass('po-drop-hover'));
    $drop.on('drop', async event => {
        event.preventDefault();
        await readFile(event.originalEvent?.dataTransfer?.files?.[0]);
    });

    $url.on('change', function () {
        const value = String($(this).val() || '').trim();
        if (!value) {
            applyImage('', '');
            return;
        }
        if (!isSafeImage(value)) {
            toastr.warning('Use an http(s) or data image URL.', 'Persona Outfits');
            $(this).val('');
            return;
        }
        applyImage(value, value);
    });
    $url.on('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            $(this).trigger('change');
        }
    });

    $remove.on('click', () => applyImage('', ''));

    const discardDraft = () => {
        if (draftOutfit && draftOutfit.id === outfit.id) {
            draftOutfit = null;
        }
        editingId = null;
        renderList();
    };

    $cancel.on('click', discardDraft);

    $save.on('click', () => {
        const isDraft = draftOutfit && draftOutfit.id === outfit.id;
        const wasActive = !isDraft && getActiveOutfit()?.id === outfit.id;

        outfit.name = String($name.val() || '').trim() || 'Untitled outfit';
        outfit.description = String($desc.val() || '').trim();
        outfit.image = draft.image || '';
        outfit.thumb = draft.thumb || outfit.image || '';

        if (isDraft) {
            const outfits = ensurePersonaOutfits(getActivePersonaKey());
            if (!outfits) {
                toastr.warning('Select a persona first.', 'Persona Outfits');
                return;
            }
            outfits.push(outfit);
            draftOutfit = null;
        }

        editingId = null;
        saveSettings();
        renderList();

        // Keep the persona in sync if this outfit is the one currently worn.
        if (wasActive) {
            applyOutfit(outfit.id, { silent: true });
            toastr.success('Outfit updated and re-applied.', 'Persona Outfits');
        }
    });

    $editor.on('keydown', event => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            discardDraft();
        }
    });

    renderPreview();

    if (/^https?:/i.test(draft.image)) {
        $url.val(draft.image);
    }

    return $editor;
}

async function deleteOutfit(id) {
    // Capture the persona so a switch while the confirmation is open cannot
    // delete an identically-keyed row from a different persona.
    const avatar = getActivePersonaKey();
    const outfits = getPersonaOutfits(avatar);
    const outfit = outfits.find(item => item.id === id);
    if (!outfit) {
        return;
    }

    const wasActive = getActiveOutfit()?.id === id;
    const wasDisplayed = displayedOutfitId === id;
    const plainName = outfit.name || 'Untitled outfit';

    const confirmed = await confirmDialog(
        'Delete outfit',
        `Delete “${escapeHtml(plainName)}”? This does not change the outfit currently written into your persona.`,
        `Delete “${plainName}”? This does not change the outfit currently written into your persona.`,
    );
    if (!confirmed) {
        return;
    }

    const index = outfits.findIndex(item => item.id === id);
    if (index >= 0) {
        outfits.splice(index, 1);
    }
    if (outfits.length === 0) {
        delete settings.outfitsByPersona[avatar];
    }
    if (editingId === id) {
        editingId = null;
    }
    if (wasActive || wasDisplayed) {
        hideOutfitWindows();
    }
    saveSettings();
    renderList();
}

async function confirmDialog(title, htmlMessage, plainMessage = htmlMessage) {
    if (ctx.Popup?.show?.confirm) {
        try {
            return !!(await ctx.Popup.show.confirm(title, htmlMessage));
        } catch (error) {
            console.warn('[Persona Outfits] Popup failed, falling back to confirm()', error);
        }
    }
    return window.confirm(`${title}\n\n${plainMessage}`);
}

/* ------------------------------------------------------------------ */
/* Wearing an outfit                                                   */
/* ------------------------------------------------------------------ */

function applyOutfit(id, { silent = false } = {}) {
    const outfit = getPersonaOutfits().find(item => item.id === id);
    if (!outfit) {
        return;
    }

    const description = (outfit.description || '').trim() || (outfit.name || '').trim();
    if (!description) {
        toastr.warning('Give this outfit a description first.', 'Persona Outfits');
        return;
    }

    if (!user_avatar) {
        toastr.warning('Select a persona first.', 'Persona Outfits');
        return;
    }

    if (!power_user.personas?.[user_avatar]) {
        toastr.warning('Your current persona is not set up yet. Create or select one in Persona Management.', 'Persona Outfits');
        return;
    }

    const descriptor = getOrCreateDescriptor(user_avatar);
    // power_user.persona_description mirrors the active persona and is what the
    // persona editor writes to; prefer it in case the descriptor is stale.
    let text = String(power_user.persona_description ?? descriptor.description ?? '');
    const replacement = `[outfit: ${description}]`;

    OUTFIT_RE.lastIndex = 0;
    if (OUTFIT_RE.test(text)) {
        OUTFIT_RE.lastIndex = 0;
        // Use a function replacement so "$" in the description is not treated as a replacement pattern.
        text = text.replace(OUTFIT_RE, () => replacement);
    } else if (settings.appendIfMissing) {
        const trimmed = text.replace(/\s+$/, '');
        text = trimmed ? `${trimmed}\n${replacement}` : replacement;
    } else {
        toastr.warning(`Add ${PLACEHOLDER} to your persona description first.`, 'Persona Outfits');
        return;
    }

    descriptor.description = text;
    power_user.persona_description = text;

    saveSettings();

    try {
        setPersonaDescription();
    } catch (error) {
        console.warn('[Persona Outfits] Could not refresh the persona description UI', error);
    }

    try {
        if (ctx.eventTypes?.PERSONA_UPDATED) {
            ctx.eventSource.emit(ctx.eventTypes.PERSONA_UPDATED, user_avatar);
        }
    } catch (error) {
        console.warn('[Persona Outfits] Could not emit persona update event', error);
    }

    renderList();

    showOutfitWindows(outfit);

    if (!silent) {
        toastr.success(`Now wearing ${outfit.name || 'your outfit'}.`, 'Persona Outfits', { escapeHtml: true });
    }
}

function clearOutfit() {
    if (!user_avatar) {
        return;
    }

    const descriptor = power_user.persona_descriptions?.[user_avatar];
    if (!descriptor) {
        toastr.info('There is no outfit written into this persona.', 'Persona Outfits');
        return;
    }

    let text = String(power_user.persona_description ?? descriptor.description ?? '');
    OUTFIT_RE.lastIndex = 0;
    if (!OUTFIT_RE.test(text)) {
        toastr.info(`No [outfit: ] placeholder found in the persona description.`, 'Persona Outfits');
        return;
    }

    OUTFIT_RE.lastIndex = 0;
    text = text.replace(OUTFIT_RE, PLACEHOLDER);

    descriptor.description = text;
    power_user.persona_description = text;
    saveSettings();

    try {
        setPersonaDescription();
    } catch (error) {
        console.warn('[Persona Outfits] Could not refresh the persona description UI', error);
    }

    renderList();
    hideOutfitWindows();
    toastr.info('Outfit cleared.', 'Persona Outfits');
}

function getOrCreateDescriptor(avatar) {
    if (!power_user.persona_descriptions[avatar]) {
        power_user.persona_descriptions[avatar] = {
            description: power_user.persona_description ?? '',
            position: power_user.persona_description_position,
            depth: power_user.persona_description_depth,
            role: power_user.persona_description_role,
            lorebook: '',
            title: '',
        };
    }

    const descriptor = power_user.persona_descriptions[avatar];
    if (typeof descriptor.description !== 'string') {
        descriptor.description = '';
    }
    return descriptor;
}

function currentOutfitText() {
    const descriptor = power_user.persona_descriptions?.[user_avatar];
    const text = String(power_user.persona_description ?? descriptor?.description ?? '');
    const match = text.match(/\[outfit\s*:\s*([^\]]*)\]/i);
    return match ? match[1].trim() : '';
}

function getActiveOutfit() {
    const text = currentOutfitText();
    if (!text) {
        return null;
    }

    return [...getPersonaOutfits()].reverse().find(outfit => {
        const description = (outfit.description || '').trim() || (outfit.name || '').trim();
        return description === text;
    }) ?? null;
}

/* ------------------------------------------------------------------ */
/* Image panel                                                         */
/* ------------------------------------------------------------------ */

function showOutfitWindows(outfit) {
    displayedOutfitId = (settings.showImagePanel || settings.showTextPanel) ? outfit.id : null;

    if (settings.showImagePanel && isSafeImage(outfit.image)) {
        showOutfitImage(outfit);
    } else {
        hideImagePanel();
    }

    if (settings.showTextPanel) {
        showOutfitText(outfit);
    } else {
        hideTextPanel();
    }
}

function showOutfitImage(outfit) {
    if (!isSafeImage(outfit.image)) {
        hideImagePanel();
        return;
    }

    const panel = document.getElementById('po-image-panel');
    if (!panel) {
        return;
    }

    $('#po-image').attr('src', outfit.image);
    $('#po-image-title').text(outfit.name || 'Outfit');
    panel.classList.remove('po-hidden');

    applyImagePanelSize();

    panel.style.visibility = 'hidden';
    if (hasSavedPosition(settings.imagePanel)) {
        restorePosition(panel, settings.imagePanel);
    } else {
        placeDefault(panel, 'image');
    }
    clampIntoView(panel);
    panel.style.visibility = '';
}

function showOutfitText(outfit) {
    const text = String(outfit.description || '').trim();
    if (!text) {
        hideTextPanel();
        return;
    }

    const panel = document.getElementById('po-text-panel');
    if (!panel) {
        return;
    }

    $('#po-text-title').text(outfit.name || 'Description');
    $('#po-text-body').text(text);
    panel.classList.remove('po-hidden');

    applyTextPanelSize();

    panel.style.visibility = 'hidden';
    if (hasSavedPosition(settings.textPanel)) {
        restorePosition(panel, settings.textPanel);
    } else {
        placeTextDefault();
    }
    clampIntoView(panel);
    panel.style.visibility = '';
}

function hideImagePanel() {
    const panel = document.getElementById('po-image-panel');
    if (panel) {
        panel.classList.add('po-hidden');
    }

    // Drop the data URL from the DOM so a deleted outfit's image is not kept
    // alive in memory by the hidden <img> element.
    const image = document.getElementById('po-image');
    if (image) {
        image.removeAttribute('src');
    }
    $('#po-image-title').text('');
}

function hideTextPanel() {
    const panel = document.getElementById('po-text-panel');
    if (panel) {
        panel.classList.add('po-hidden');
    }
    $('#po-text-title').text('');
    $('#po-text-body').text('');
}

function hideOutfitWindows() {
    displayedOutfitId = null;
    hideImagePanel();
    hideTextPanel();
}

/* ------------------------------------------------------------------ */
/* Image helpers                                                       */
/* ------------------------------------------------------------------ */

function isSafeImage(source) {
    if (!source || typeof source !== 'string' || source.length > MAX_IMAGE_SOURCE_LENGTH) {
        return false;
    }
    if (/^\s*javascript:/i.test(source)) {
        return false;
    }
    if (/^data:/i.test(source)) {
        // Only raster data URLs produced by the canvas path. SVG data URLs are
        // not needed and are a larger attack surface.
        return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(source);
    }
    try {
        const url = new URL(source, window.location.href);
        return ['http:', 'https:'].includes(url.protocol);
    } catch {
        return false;
    }
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
        reader.readAsDataURL(file);
    });
}

function loadImage(source) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Image could not be decoded'));
        image.src = source;
    });
}

async function fileToOutfitImages(file) {
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(dataUrl);

    return {
        image: drawScaledImage(image, IMAGE_MAX_EDGE, 0.86),
        thumb: drawScaledImage(image, THUMB_MAX_EDGE, 0.72),
    };
}

function drawScaledImage(image, maxEdge, quality) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);

    const webp = canvas.toDataURL('image/webp', quality);
    if (webp.startsWith('data:image/webp')) {
        return webp;
    }
    return canvas.toDataURL('image/jpeg', quality);
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function snippet(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * SillyTavern's Popup renders string content as HTML. Escape any user text
 * before putting it into a popup message.
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function onPersonaContextChanged() {
    const avatar = getActivePersonaKey();

    // Keep an in-progress editor when a chat reloads with the same persona.
    if (avatar === lastPersonaKey && editingId) {
        return;
    }
    if (avatar !== lastPersonaKey) {
        editingId = null;
        draftOutfit = null;
    }

    hideOutfitWindows();
    renderList();
}

function registerCommands() {
    if (typeof ctx.registerSlashCommand !== 'function') {
        return;
    }
    ctx.registerSlashCommand(
        'outfits',
        () => setPanelOpen(!settings.panelOpen),
        [],
        'Open or close the persona outfit panel.',
    );
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

jQuery(async () => {
    if (document.getElementById('po-toggle')) {
        console.warn('[Persona Outfits] Already initialized; skipping duplicate UI.');
        return;
    }

    loadSettings();
    buildUi();
    renderList();
    updatePanelVisibility();
    positionToggle();
    registerCommands();

    window.addEventListener('resize', onWindowResize);

    if (ctx.eventTypes?.PERSONA_CHANGED) {
        ctx.eventSource.on(ctx.eventTypes.PERSONA_CHANGED, onPersonaContextChanged);
    }
    if (ctx.eventTypes?.CHAT_CHANGED) {
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onPersonaContextChanged);
    }
    if (ctx.eventTypes?.PERSONA_RENAMED) {
        ctx.eventSource.on(ctx.eventTypes.PERSONA_RENAMED, () => updatePersonaHeader());
    }

    console.log('[Persona Outfits] Loaded');
});
