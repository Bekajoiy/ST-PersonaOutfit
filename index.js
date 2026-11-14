/*
 * Persona Outfits — a floating outfit manager for SillyTavern.
 *
 * Wearing an outfit rewrites the [outfit: ...] placeholder in the active
 * persona's description and shows the outfit's image in a draggable panel.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { chat, getThumbnailUrl, saveSettingsDebounced } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatar, user_avatar, setPersonaDescription } from '../../../personas.js';
import { encodeImage, normalizeCrop, openThumbnailCrop } from './thumbnail-crop.js';

const MODULE_NAME = 'persona_outfits';
const PLACEHOLDER = '[outfit: ]';
const OUTFIT_RE = /\[outfit\s*:[^\]]*\]/gi;
const IMAGE_MAX_EDGE = 1024;
const THUMB_MAX_EDGE = 160;
const MAX_IMAGE_SOURCE_LENGTH = 4_000_000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DISPLAY_MODES = [
    { id: 'list', label: 'List', icon: 'fa-list' },
    { id: 'compact', label: 'Compact', icon: 'fa-table-list' },
    { id: 'gallery', label: 'Gallery', icon: 'fa-border-all' },
];
const GALLERY_COLUMN_OPTIONS = [2, 3, 4, 5, 6];
const DEFAULT_GALLERY_COLUMNS = 3;
const GALLERY_IMAGE_SIZES = {
    small: { label: 'Small', short: 'S', pixels: 65 },
    medium: { label: 'Medium', short: 'M', pixels: 85 },
    large: { label: 'Large', short: 'L', pixels: 110 },
    extraLarge: { label: 'Extra Large', short: 'XL', pixels: 140 },
};
const DEFAULT_GALLERY_IMAGE_SIZE = 'medium';
const REORDER_THRESHOLD = 5;
const REORDER_SCROLL_EDGE = 32;
const RESERVED_PERSONA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CHAT_MESSAGE = '.mes';
const CHAT_AVATAR = '.mesAvatarWrapper > .avatar > img';
const CHAT_AVATAR_CLASS = 'po-dynamic-chat-avatar';
const CHAT_AVATAR_IMAGE = '--po-chat-avatar-image';

const ctx = getContext();

let settings = null;
let editingId = null;
let draftOutfit = null;
let lastPersonaKey = null;
let displayedOutfitId = null;
let resizeTimer = null;
let cancelOutfitReorder = null;
let cropSession = null;
let renderedOutfitId = null;
let chatAvatar = null;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function defaultSettings() {
    return {
        outfits: [], // Legacy global list; moved into outfitsByPersona on first use.
        outfitsByPersona: {},
        outfitSelections: {},
        displayMode: 'list',
        galleryColumns: DEFAULT_GALLERY_COLUMNS,
        galleryImageSize: DEFAULT_GALLERY_IMAGE_SIZE,
        dynamicChatAvatar: false,
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
    if (!DISPLAY_MODES.some(mode => mode.id === settings.displayMode)) {
        settings.displayMode = 'list';
    }
    if (!GALLERY_COLUMN_OPTIONS.includes(settings.galleryColumns)) {
        settings.galleryColumns = DEFAULT_GALLERY_COLUMNS;
    }
    if (typeof settings.galleryImageSize !== 'string' || !Object.hasOwn(GALLERY_IMAGE_SIZES, settings.galleryImageSize)) {
        settings.galleryImageSize = DEFAULT_GALLERY_IMAGE_SIZE;
    }
    settings.dynamicChatAvatar = settings.dynamicChatAvatar === true;
    // Retire the card setting. An old opt-in does not opt into chat avatars.
    delete settings.syncPersonaAvatar;
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

    // A selection disambiguates outfits that write the same placeholder.
    const selections = Object.create(null);
    for (const [key, selection] of Object.entries(settings.outfitSelections ?? {})) {
        if (clean[key] && typeof selection?.marker === 'string'
            && (selection.id === null || clean[key].some(outfit => outfit.id === selection.id))) {
            selections[key] = { id: selection.id, marker: selection.marker };
        }
    }
    settings.outfitSelections = selections;

    extension_settings[MODULE_NAME] = settings;
    if (Object.hasOwn(stored, 'syncPersonaAvatar')) {
        saveSettings();
    }
}

function normalizeOutfit(outfit) {
    const crop = normalizeCrop(outfit.crop);
    return {
        id: String(outfit.id || uid()),
        name: String(outfit.name ?? ''),
        description: String(outfit.description ?? ''),
        image: typeof outfit.image === 'string' ? outfit.image : '',
        thumb: typeof outfit.thumb === 'string' ? outfit.thumb : '',
        ...(crop && { crop }),
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
                <div class="po-modes" role="group" aria-label="Outfit display mode">
                    ${DISPLAY_MODES.map(({ id, label, icon }) => `
                        <button type="button" class="po-icon-btn po-mode" data-mode="${id}"
                            aria-label="${label} view" title="${label} view" aria-pressed="false">
                            <i class="fa-solid ${icon}" aria-hidden="true"></i>
                        </button>
                    `).join('')}
                </div>
                <button type="button" id="po-gallery-settings-button" class="po-icon-btn po-hidden"
                    popovertarget="po-gallery-settings" aria-label="Gallery settings" title="Gallery settings">
                    <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                </button>
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

        <div id="po-gallery-settings" popover="auto" aria-label="Gallery settings" class="po-popover">
            <div class="po-gallery-label" id="po-columns-label">Columns</div>
            <div class="po-gallery-options" role="group" aria-labelledby="po-columns-label">
                ${GALLERY_COLUMN_OPTIONS.map(columns => `
                    <button type="button" class="po-icon-btn" data-gallery-columns="${columns}"
                        aria-label="${columns} columns" aria-pressed="false">${columns}</button>
                `).join('')}
            </div>
            <div class="po-gallery-label" id="po-image-size-label">Image size</div>
            <div class="po-gallery-options" role="group" aria-labelledby="po-image-size-label">
                ${Object.entries(GALLERY_IMAGE_SIZES).map(([key, { label, short, pixels }]) => `
                    <button type="button" class="po-icon-btn" data-gallery-size="${key}"
                        aria-label="${label} (${pixels} pixels)" title="${label} · ${pixels} × ${pixels} px"
                        aria-pressed="false">${short}</button>
                `).join('')}
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
                    <label class="checkbox_label">
                        <input type="checkbox" id="po-setting-chat-avatar" aria-describedby="po-chat-avatar-help">
                        <span>Dynamic Chat Avatar</span>
                    </label>
                    <div id="po-chat-avatar-help" class="po-help">
                        Display the selected outfit image as the avatar for the active persona's chat messages.
                    </div>
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

    $('#po-setting-chat-avatar')
        .prop('checked', settings.dynamicChatAvatar)
        .on('change', function () {
            settings.dynamicChatAvatar = this.checked;
            updateChatAvatar(getActiveOutfit());
            saveSettings();
        });

    $('.po-mode').on('click', function () {
        if (settings.displayMode !== this.dataset.mode) {
            settings.displayMode = this.dataset.mode;
            renderList();
            saveSettings();
        }
    });

    const list = document.getElementById('po-list');
    cancelOutfitReorder = bindReorder(list);
    bindGallerySettings();

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
    $('#po-list').on('scroll', positionOpenOutfitMenu);
    $('#po-panel .po-header').on('pointerdown', event => {
        closeOutfitMenu();
        if (!event.target.closest('#po-gallery-settings-button')) {
            closeGallerySettings();
        }
    });
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

function bindGallerySettings() {
    const menu = document.getElementById('po-gallery-settings');
    $(menu).on('toggle', positionGallerySettings);
    $(menu).on('click', 'button', function () {
        const columns = Number(this.dataset.galleryColumns ?? settings.galleryColumns);
        const size = this.dataset.gallerySize ?? settings.galleryImageSize;
        if (!GALLERY_COLUMN_OPTIONS.includes(columns) || !Object.hasOwn(GALLERY_IMAGE_SIZES, size)
            || (columns === settings.galleryColumns && size === settings.galleryImageSize)) {
            return;
        }
        cancelOutfitReorder();
        closeOutfitMenu();
        settings.galleryColumns = columns;
        settings.galleryImageSize = size;
        updateGalleryPreferences();
        clampIntoView(document.getElementById('po-panel'));
        positionGallerySettings();
        saveSettings();
    });
    updateGalleryPreferences();
}

function updateGalleryPreferences() {
    const panel = document.getElementById('po-panel');
    panel.style.setProperty('--po-gallery-columns', settings.galleryColumns);
    panel.style.setProperty('--po-gallery-size', `${GALLERY_IMAGE_SIZES[settings.galleryImageSize].pixels}px`);
    $('#po-gallery-settings button').each((_, button) => {
        const selected = button.dataset.galleryColumns
            ? Number(button.dataset.galleryColumns) === settings.galleryColumns
            : button.dataset.gallerySize === settings.galleryImageSize;
        button.setAttribute('aria-pressed', String(selected));
    });
}

function updateGalleryMode(mode) {
    const gallery = mode === 'gallery';
    document.getElementById('po-panel').dataset.mode = mode;
    $('#po-gallery-settings-button').toggleClass('po-hidden', !gallery);
    if (gallery) {
        syncGalleryScrollbarWidth();
    } else {
        closeGallerySettings();
    }
}

function syncGalleryScrollbarWidth() {
    const panel = document.getElementById('po-panel');
    if (panel.dataset.mode !== 'gallery' || panel.classList.contains('po-hidden')) {
        return;
    }
    // A stable gutter gives the fixed grid the same space with or without vertical overflow.
    const list = document.getElementById('po-list');
    panel.style.setProperty('--po-gallery-scrollbar', `${list.offsetWidth - list.clientWidth}px`);
}

function closeGallerySettings() {
    document.querySelector('#po-gallery-settings:popover-open')?.hidePopover();
}

function positionGallerySettings() {
    const menu = document.querySelector('#po-gallery-settings:popover-open');
    if (menu) {
        placePopover(menu, document.getElementById('po-gallery-settings-button').getBoundingClientRect());
    }
}

function setPanelOpen(open) {
    if (!open) {
        closeGallerySettings();
        cropSession?.abort();
        cancelOutfitReorder();
    }
    settings.panelOpen = !!open;
    updatePanelVisibility();
    saveSettings();
}

function onWindowResize() {
    cancelOutfitReorder();
    closeOutfitMenu();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        positionToggle();
        applyImagePanelSize();
        applyTextPanelSize();

        if (settings.panelOpen) {
            const panel = document.getElementById('po-panel');
            if (hasSavedPosition(settings.panel) || settings.displayMode === 'gallery') {
                clampIntoView(panel);
            } else {
                placeDefault(panel, 'panel');
            }
            positionGallerySettings();
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
            syncGalleryScrollbarWidth();
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

    cancelOutfitReorder();

    const avatar = getActivePersonaKey();
    if (avatar !== lastPersonaKey) {
        lastPersonaKey = avatar;
        editingId = null;
        draftOutfit = null;
    }

    updatePersonaHeader(avatar);

    const outfits = getPersonaOutfits(avatar);
    const active = getActiveOutfit(avatar);
    const mode = settings.displayMode;
    const scrollTop = $list.scrollTop();
    const scrollLeft = $list.scrollLeft();
    const $editing = $list.find('.po-editor').filter((_, editor) => editor.dataset.id === editingId).detach();
    if (!$editing.length) {
        cropSession?.abort();
    }
    $list.attr('data-mode', mode).empty();
    updateGalleryMode(mode);
    $('.po-mode').each((_, button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    $('#po-add').prop('disabled', !avatar);
    renderedOutfitId = active?.id ?? null;
    updateChatAvatar(active);

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

    for (const outfit of outfits) {
        const isActive = active?.id === outfit.id;
        $list.append(mode === 'list'
            ? buildListRow(outfit, isActive)
            : buildOutfitTile(outfit, isActive, mode));

        if (editingId === outfit.id) {
            $list.append($editing.length ? $editing : buildEditor(outfit));
        }
    }

    // A new outfit is kept out of settings until Save; show its editor anyway.
    if (draftOutfit && draftOutfit.id === editingId) {
        $list.append($editing.length ? $editing : buildEditor(draftOutfit));
    }

    $list.scrollTop(scrollTop).scrollLeft(scrollLeft);

    if (settings.panelOpen) {
        const panel = document.getElementById('po-panel');
        if (hasSavedPosition(settings.panel) || mode === 'gallery') {
            clampIntoView(panel);
        } else {
            placeDefault(panel, 'panel');
        }
        positionGallerySettings();
    }
}

function buildOutfitImage(sources) {
    const $thumb = $('<span class="po-thumb" aria-hidden="true">');
    const $placeholder = $('<i class="fa-solid fa-shirt">').appendTo($thumb);
    const source = sources.find(isSafeImage);
    if (source) {
        $placeholder.addClass('po-hidden');
        $('<img alt="" draggable="false">')
            .on('error', function () {
                $(this).remove();
                $placeholder.removeClass('po-hidden');
            })
            .attr('src', source)
            .appendTo($thumb);
    }
    return $thumb;
}

function buildOutfitActions(outfit, showLabels = false) {
    const $actions = $('<div>', { class: showLabels ? 'po-menu-actions' : 'po-actions' });
    const $edit = $('<button type="button" class="po-icon-btn po-edit" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>');
    const $delete = $('<button type="button" class="po-icon-btn po-del" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>');
    if (showLabels) {
        $edit.append(' Edit');
        $delete.append(' Delete');
    }
    $edit.on('click', event => {
        event.stopPropagation();
        startEdit(outfit.id);
    });
    $delete.on('click', event => {
        event.stopPropagation();
        deleteOutfit(outfit.id);
    });
    return $actions.append($edit, $delete);
}

function equipFromEntry(id, entry) {
    const restoreFocus = entry === document.activeElement;
    if (applyOutfit(id) && restoreFocus) {
        const replacement = [...document.querySelectorAll('#po-list [data-outfit-id]')]
            .find(item => item.dataset.outfitId === id);
        replacement?.focus({ preventScroll: true });
    }
}

function buildListRow(outfit, isActive) {
    const $row = $('<div>', {
        class: `po-row${isActive ? ' po-active' : ''}`,
        'data-outfit-entry': outfit.id,
        'data-outfit-id': outfit.id,
        tabindex: '0',
        role: 'button',
        'aria-pressed': String(isActive),
        title: `Wear ${outfit.name || 'this outfit'}`,
    });

    const $handle = $('<span class="po-drag-handle" title="Drag to reorder" aria-label="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>');

    const $info = $('<div class="po-info">');
    const $name = $('<div class="po-name">').text(outfit.name || 'Untitled outfit');
    if (isActive) {
        $name.append('<span class="po-badge">Wearing</span>');
    }
    $info.append($name, $('<div class="po-sub">').text(snippet(outfit.description) || 'No description'));
    $row.append($handle, buildOutfitImage([outfit.thumb, outfit.image]), $info, buildOutfitActions(outfit));

    $row.on('click', event => {
        if (!event.target.closest('.po-drag-handle')) {
            equipFromEntry(outfit.id, $row[0]);
        }
    });
    $row.on('keydown', event => {
        if (event.target === $row[0] && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            equipFromEntry(outfit.id, $row[0]);
        }
    });
    return $row;
}

function closeOutfitMenu() {
    document.querySelector('.po-outfit-menu:popover-open')?.hidePopover();
}

function positionOpenOutfitMenu() {
    const menu = document.querySelector('.po-outfit-menu:popover-open');
    if (!menu) {
        return;
    }
    const anchor = menu.parentElement.querySelector('.po-more').getBoundingClientRect();
    const list = document.getElementById('po-list').getBoundingClientRect();
    if (anchor.top >= list.bottom || anchor.bottom <= list.top || anchor.left >= list.right || anchor.right <= list.left) {
        menu.hidePopover();
        return;
    }
    placePopover(menu, anchor);
}

function placePopover(menu, anchor) {
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${clamp(anchor.right - bounds.width, 4, window.innerWidth - bounds.width - 4)}px`;
    const top = anchor.bottom + bounds.height + 8 <= window.innerHeight || anchor.top < bounds.height + 8
        ? anchor.bottom + 4 : anchor.top - bounds.height - 4;
    menu.style.top = `${clamp(top, 4, Math.max(4, window.innerHeight - bounds.height - 4))}px`;
}

function buildOutfitTile(outfit, isActive, mode) {
    const name = outfit.name || 'Untitled outfit';
    const gallery = mode === 'gallery';
    const $tile = $('<div class="po-tile">').attr('data-outfit-entry', outfit.id).toggleClass('po-active', isActive);
    const $equip = $('<button type="button" class="po-equip">').attr({
        'data-outfit-id': outfit.id,
        'aria-label': `Wear ${name}`,
        'aria-pressed': String(isActive),
        title: name,
    }).append(buildOutfitImage([outfit.thumb, outfit.image]));
    if (!gallery) {
        $equip.append($('<span class="po-tile-name">').text(name));
    }
    $equip.on('click', () => equipFromEntry(outfit.id, $equip[0]));

    const menuId = `po-menu-${uid()}`;
    const $more = $('<button type="button" class="po-icon-btn po-more"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>')
        .attr({ 'aria-label': `Actions for ${name}`, title: `Actions for ${name}`, popovertarget: menuId });
    const $menu = $('<div class="po-outfit-menu" popover="auto">')
        .attr({ id: menuId, role: 'group', 'aria-label': `Actions for ${name}` })
        .addClass('po-popover').append(buildOutfitActions(outfit, true));
    const menu = $menu[0];

    $menu.on('toggle', positionOpenOutfitMenu);
    menu.querySelector('.po-edit').autofocus = true;
    $menu.find('button').on('click', () => {
        if (menu.matches(':popover-open')) {
            menu.hidePopover();
        }
    });
    $tile.on('contextmenu', event => {
        event.preventDefault();
        $more[0].focus({ preventScroll: true });
        menu.showPopover();
    });
    const $grip = $('<span class="po-drag-handle po-touch-grip" title="Drag to reorder" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>');
    return $tile.append($equip, $grip, $more, $menu);
}

function measureOutfitRows(list) {
    const rows = [];
    const { top, left } = list.getBoundingClientRect();
    for (const entry of list.querySelectorAll(':scope > [data-outfit-entry]')) {
        const rect = entry.getBoundingClientRect();
        const y = rect.top - top + list.scrollTop;
        const x = rect.left - left + list.scrollLeft + rect.width / 2;
        const last = rows.at(-1);
        if (last && Math.abs(last.top - y) < 1) {
            last.entries.push({ entry, x });
            last.bottom = Math.max(last.bottom, y + rect.height);
        } else {
            rows.push({ top: y, bottom: y + rect.height, entries: [{ entry, x }] });
        }
    }
    return rows;
}

function getOutfitDropTarget(state, bounds, list) {
    const y = state.y - bounds.top + list.scrollTop;
    const row = state.rows.find((row, index) => {
        const next = state.rows[index + 1];
        return !next || y < (row.bottom + next.top) / 2;
    });
    if (state.vertical || y < row.top || y > row.bottom) {
        const after = y > (row.top + row.bottom) / 2;
        return { entry: (after ? row.entries.at(-1) : row.entries[0]).entry, after };
    }
    const x = state.x - bounds.left + list.scrollLeft;
    const next = row.entries.find(item => (x - item.x) * state.direction < 0);
    return next ? { entry: next.entry, after: false } : { entry: row.entries.at(-1).entry, after: true };
}

function bindReorder(list) {
    let drag = null;
    let frame = 0;
    let suppressedPointer = null;

    function setIndicator(target) {
        const previous = drag.target;
        if (previous?.entry === target?.entry && previous?.after === target?.after) {
            return;
        }
        previous?.entry.classList.remove('po-drop-before', 'po-drop-after');
        drag.target = target;
        target?.entry.classList.add(target.after ? 'po-drop-after' : 'po-drop-before');
    }

    function cancel() {
        if (!drag) {
            return;
        }
        cancelAnimationFrame(frame);
        frame = 0;
        setIndicator(null);
        const { entry, handle, pointerId } = drag;
        drag = null;
        entry.classList.remove('po-entry-reordering');
        list.classList.remove('po-reordering');
        if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
        }
    }

    function edgeScroll(offset, length) {
        const edge = Math.min(REORDER_SCROLL_EDGE, length / 3);
        return 14 * (Math.max(0, edge - (length - offset)) - Math.max(0, edge - offset)) / edge;
    }

    function updateTarget() {
        frame = 0;
        const bounds = list.getBoundingClientRect();
        if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) {
            setIndicator(null);
            return;
        }

        const previousTop = list.scrollTop;
        const previousLeft = list.scrollLeft;
        list.scrollTop += edgeScroll(drag.y - bounds.top, list.clientHeight);
        if (list.scrollWidth > list.clientWidth) {
            list.scrollLeft += edgeScroll(drag.x - bounds.left - list.clientLeft, list.clientWidth);
        }
        setIndicator(getOutfitDropTarget(drag, bounds, list));
        if (list.scrollTop !== previousTop || list.scrollLeft !== previousLeft) {
            frame = requestAnimationFrame(updateTarget);
        }
    }

    list.addEventListener('scroll', () => {
        if (drag?.started) {
            frame ||= requestAnimationFrame(updateTarget);
        }
    });

    list.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || drag) {
            return;
        }
        suppressedPointer = null;
        const handle = event.target.closest('.po-drag-handle, .po-equip');
        const entry = handle?.closest('[data-outfit-entry]');
        if (!entry || entry.parentElement !== list) {
            return;
        }
        drag = {
            entry, handle, pointerId: event.pointerId, avatar: getActivePersonaKey(),
            touchTap: event.pointerType === 'touch' && handle.matches('.po-equip'),
            x: event.clientX, y: event.clientY, started: false, target: null,
        };
    });

    window.addEventListener('pointermove', event => {
        if (event.pointerId !== drag?.pointerId) {
            return;
        }
        if (!drag.started) {
            if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < REORDER_THRESHOLD) {
                return;
            }
            if (drag.touchTap) {
                // A swipe on the tile uses normal scrolling. The separate grip
                // is the only touch surface that can initiate a drag.
                suppressedPointer = event.pointerId;
                cancel();
                return;
            }
            const grid = getComputedStyle(list);
            drag.vertical = list.dataset.mode === 'list' || grid.gridTemplateColumns.split(' ').length === 1;
            drag.direction = grid.direction === 'rtl' ? -1 : 1;
            drag.rows = measureOutfitRows(list);
            // On touch a browser may initially capture the pointer to a child of the grip.
            drag.handle.setPointerCapture(event.pointerId);
            suppressedPointer = event.pointerId;
            drag.started = true;
            closeOutfitMenu();
            drag.entry.classList.add('po-entry-reordering');
            list.classList.add('po-reordering');
        }
        drag.x = event.clientX;
        drag.y = event.clientY;
        frame ||= requestAnimationFrame(updateTarget);
    });

    window.addEventListener('pointerup', event => {
        if (event.pointerId !== drag?.pointerId) {
            return;
        }
        const { entry, avatar, handle, started, touchTap } = drag;
        if (touchTap) {
            cancel();
            if (handle.contains(document.elementFromPoint(event.clientX, event.clientY))) {
                suppressedPointer = event.pointerId;
                handle.click();
            }
            return;
        }
        let target = null;
        if (started) {
            const bounds = list.getBoundingClientRect();
            if (event.clientX >= bounds.left && event.clientX <= bounds.right
                && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
                drag.x = event.clientX;
                drag.y = event.clientY;
                target = getOutfitDropTarget(drag, bounds, list);
            }
        }
        cancel();
        if (!target || target.entry === entry || !entry.isConnected || avatar !== getActivePersonaKey()) {
            return;
        }

        const outfits = getPersonaOutfits(avatar);
        const from = outfits.findIndex(outfit => outfit.id === entry.dataset.outfitEntry);
        const to = outfits.findIndex(outfit => outfit.id === target.entry.dataset.outfitEntry);
        const gap = to + Number(target.after);
        const index = gap > from ? gap - 1 : gap;
        if (from < 0 || to < 0 || index === from) {
            return;
        }
        const active = getActiveOutfit(avatar);
        const [outfit] = outfits.splice(from, 1);
        outfits.splice(index, 0, outfit);
        if (active && getActiveOutfit(avatar)?.id !== active.id) {
            // A legacy marker can match multiple outfits. Reordering should
            // keep wearing the same one even when its position changes.
            settings.outfitSelections[avatar] = { id: active.id, marker: getOutfitMarker(avatar)[0] };
        }
        saveSettings();
        renderList();
    });

    window.addEventListener('pointercancel', event => {
        if (event.pointerId === drag?.pointerId) {
            cancel();
        }
    });
    list.addEventListener('lostpointercapture', event => {
        if (event.pointerId === drag?.pointerId && event.target === drag.handle) {
            cancel();
        }
    });
    window.addEventListener('blur', cancel);
    list.addEventListener('click', event => {
        if (suppressedPointer !== null && event.detail > 0
            && (event.pointerId === undefined || event.pointerId === suppressedPointer)) {
            suppressedPointer = null;
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    return cancel;
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
        crop: outfit.crop ?? null,
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

    const $drop = $('<button type="button" class="po-drop">');
    const $preview = $('<img class="po-preview" alt="" draggable="false">');
    const $cropBadge = $('<span class="po-crop-badge po-hidden" aria-hidden="true"><i class="fa-solid fa-crop-simple"></i></span>');
    const $empty = $('<div class="po-drop-empty"><i class="fa-solid fa-image"></i><span>Click or drop image</span></div>');
    $drop.append($preview, $empty, $cropBadge);

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
        const source = [draft.thumb, draft.image].find(isSafeImage);
        const hasImage = isSafeImage(draft.image);
        const label = hasImage ? 'Crop outfit thumbnail' : 'Choose or drop an image';
        $drop.attr({ title: label, 'aria-label': label });
        if (source) {
            $preview.attr('src', source);
        } else {
            $preview.removeAttr('src');
        }
        $preview.toggleClass('po-hidden', !source);
        $empty.toggleClass('po-hidden', !!source);
        $cropBadge.toggleClass('po-hidden', !hasImage);
    };

    const applyImage = (image, thumb) => {
        if (image !== draft.image) {
            cropSession?.abort();
            draft.image = image;
            draft.thumb = thumb;
            draft.crop = null;
        }
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

    $drop.on('click', () => {
        if ($save.prop('disabled')) {
            return;
        }
        if (!isSafeImage(draft.image)) {
            $file.trigger('click');
            return;
        }
        cancelOutfitReorder();
        cropSession?.abort();
        cropSession = new AbortController();
        openThumbnailCrop(draft.image, draft.crop, cropSession.signal, (thumb, crop) => {
            if (!isSafeImage(thumb)) {
                return false;
            }
            draft.thumb = thumb;
            draft.crop = crop;
            renderPreview();
            return true;
        });
    });
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
        if (draft.crop) {
            outfit.crop = draft.crop;
        } else {
            delete outfit.crop;
        }

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
            applyOutfit(outfit.id);
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

    const plainName = outfit.name || 'Untitled outfit';

    const confirmed = await confirmDialog(
        'Delete outfit',
        `Delete “${escapeHtml(plainName)}”? This does not change the outfit currently written into your persona.`,
        `Delete “${plainName}”? This does not change the outfit currently written into your persona.`,
    );
    if (!confirmed) {
        return;
    }

    const currentList = personaOutfitsList(avatar);
    const index = currentList?.indexOf(outfit) ?? -1;
    if (index < 0) {
        return;
    }

    const wasActive = getActiveOutfit(avatar)?.id === id;
    currentList.splice(index, 1);
    if (!currentList.length) {
        delete settings.outfitsByPersona[avatar];
        delete settings.outfitSelections[avatar];
    } else if (wasActive) {
        // Keep the existing description without mistaking another outfit with
        // the same description for the one just deleted.
        settings.outfitSelections[avatar] = { id: null, marker: getOutfitMarker(avatar)[0] };
    }

    if (avatar === getActivePersonaKey()) {
        if (editingId === id) {
            editingId = null;
        }
        if (wasActive || displayedOutfitId === id) {
            hideOutfitWindows();
        }
        renderList();
    }
    saveSettings();
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

function applyOutfit(id) {
    const outfit = getPersonaOutfits().find(item => item.id === id);
    if (!outfit) {
        return false;
    }

    const description = (outfit.description || '').trim() || (outfit.name || '').trim();
    if (!description) {
        toastr.warning('Give this outfit a description first.', 'Persona Outfits');
        return false;
    }

    if (!user_avatar) {
        toastr.warning('Select a persona first.', 'Persona Outfits');
        return false;
    }

    if (!power_user.personas?.[user_avatar]) {
        toastr.warning('Your current persona is not set up yet. Create or select one in Persona Management.', 'Persona Outfits');
        return false;
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
        return false;
    }

    descriptor.description = text;
    power_user.persona_description = text;

    settings.outfitSelections[user_avatar] = { id, marker: getOutfitMarker(user_avatar)[0] };
    saveSettings();

    try {
        setPersonaDescription();
    } catch (error) {
        console.warn('[Persona Outfits] Could not refresh the persona description UI', error);
    }

    renderList();

    if (ctx.eventTypes?.PERSONA_UPDATED) {
        void ctx.eventSource.emit(ctx.eventTypes.PERSONA_UPDATED, user_avatar).catch(error => {
            console.warn('[Persona Outfits] Could not emit persona update event', error);
        });
    }

    showOutfitWindows(outfit);

    return true;
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
    delete settings.outfitSelections[user_avatar];
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

function getOutfitMarker(avatar) {
    const description = power_user.persona_descriptions?.[avatar]?.description;
    const text = avatar === getActivePersonaKey() ? power_user.persona_description ?? description : description;
    return String(text ?? '').match(/\[outfit\s*:\s*([^\]]*)\]/i);
}

function getActiveOutfit(avatar = getActivePersonaKey()) {
    const marker = getOutfitMarker(avatar);
    if (!marker) {
        return null;
    }

    const outfits = getPersonaOutfits(avatar);
    const selection = settings.outfitSelections[avatar];
    if (selection?.marker === marker[0]) {
        return outfits.find(outfit => outfit.id === selection.id) ?? null;
    }

    const text = marker[1].trim();
    if (!text) {
        return null;
    }
    // Older settings and manually edited descriptions still resolve by text.
    return outfits.findLast(outfit => ((outfit.description || '').trim() || (outfit.name || '').trim()) === text) ?? null;
}

/* ------------------------------------------------------------------ */
/* Dynamic chat avatar                                                 */
/* ------------------------------------------------------------------ */

function hasPersonaAvatar(source, { avatar, thumbnail, nativePath }) {
    if (typeof source !== 'string' || !source) {
        return false;
    }

    if (source === thumbnail) {
        return true;
    }

    // Also accept cache-busted thumbnails and older native User Avatars/ paths.
    try {
        const url = new URL(source, window.location.href);
        if (url.origin !== window.location.origin) {
            return false;
        }
        if (url.pathname === '/thumbnail') {
            return url.searchParams.get('type') === 'persona' && url.searchParams.get('file') === avatar;
        }
        return decodeURIComponent(url.pathname) === nativePath;
    } catch {
        return false;
    }
}

function markChatAvatar(message, state) {
    const img = message.querySelector(`:scope > ${CHAT_AVATAR}`);
    if (!img) {
        return;
    }
    // mesid is the message's current index in SillyTavern's live chat array.
    const id = message.getAttribute('mesid');
    const data = /^\d+$/.test(id) ? chat[Number(id)] : null;
    const matches = message.matches('[is_user="true"][is_system="false"][force_avatar="true"]')
        && data?.is_user === true && !data.is_system
        && hasPersonaAvatar(data.force_avatar, state)
        && hasPersonaAvatar(img.getAttribute('src'), state);
    img.classList.toggle(CHAT_AVATAR_CLASS, matches);
}

function observeChatAvatars(state) {
    const { container } = state;
    const messages = new Set();

    const addMessage = node => {
        if (node instanceof Element && node.parentElement === container && node.matches(CHAT_MESSAGE)) {
            messages.add(node);
        }
    };

    const observer = new MutationObserver(records => {
        for (const record of records) {
            const target = record.target;
            if (target === container) {
                record.addedNodes.forEach(addMessage);
            } else if (target.matches(CHAT_MESSAGE)) {
                addMessage(target);
            } else if (target.matches(CHAT_AVATAR) || target.matches('.mesAvatarWrapper, .mesAvatarWrapper > .avatar')) {
                addMessage(target.closest(CHAT_MESSAGE));
            }
        }
        for (const message of messages) {
            markChatAvatar(message, state);
        }
        messages.clear();
    });
    observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'mesid', 'is_user', 'is_system', 'force_avatar'],
    });
    return observer;
}

function clearChatAvatar() {
    if (!chatAvatar) {
        return;
    }
    const { observer, container } = chatAvatar;
    chatAvatar = null;
    observer?.disconnect();
    container.style.removeProperty(CHAT_AVATAR_IMAGE);
    container.querySelectorAll(`.${CHAT_AVATAR_CLASS}`).forEach(img => img.classList.remove(CHAT_AVATAR_CLASS));
}

function updateChatAvatar(outfit) {
    const avatar = getActivePersonaKey();
    const container = document.getElementById('chat');
    if (!settings.dynamicChatAvatar || !container || !getPersonaName(avatar) || !isSafeImage(outfit?.image)) {
        clearChatAvatar();
        return;
    }

    const thumb = isSafeImage(outfit.thumb) ? outfit.thumb : outfit.image;
    if (chatAvatar?.container === container && chatAvatar.avatar === avatar
        && chatAvatar.image === outfit.image && chatAvatar.thumb === thumb) {
        return;
    }

    clearChatAvatar();
    const nativePath = new URL(getUserAvatar(''), window.location.href).pathname;
    const state = {
        container,
        avatar,
        image: outfit.image,
        thumb,
        thumbnail: getThumbnailUrl('persona', avatar),
        nativePath: decodeURIComponent(nativePath) + avatar,
        observer: null,
    };
    chatAvatar = state;

    void (async () => {
        // Prefer the existing small image. Leave the native src alone so a
        // failed outfit image never invokes SillyTavern's missing-avatar handler.
        for (const source of new Set([thumb, state.image])) {
            let image;
            try {
                image = await loadImage(new URL(source, window.location.href).href);
            } catch {
                if (chatAvatar !== state) {
                    return;
                }
                continue;
            }
            if (chatAvatar !== state || avatar !== getActivePersonaKey()) {
                return;
            }
            container.style.setProperty(CHAT_AVATAR_IMAGE, `url(${JSON.stringify(image.src)})`);
            for (const message of container.querySelectorAll(`:scope > ${CHAT_MESSAGE}`)) {
                markChatAvatar(message, state);
            }
            state.observer = observeChatAvatars(state);
            return;
        }
    })();
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

    return encodeImage(image, width, height, quality);
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
        onPersonaUpdated(avatar);
        return;
    }
    if (avatar !== lastPersonaKey) {
        editingId = null;
        draftOutfit = null;
    }

    hideOutfitWindows();
    renderList();
}

function onPersonaUpdated(avatar) {
    if (avatar === getActivePersonaKey()) {
        const outfit = getActiveOutfit(avatar);
        if ((outfit?.id ?? null) !== renderedOutfitId) {
            renderList();
        } else {
            updateChatAvatar(outfit);
        }
    }
}

function onPersonaDeleted(payload) {
    const avatarId = typeof payload === 'string' ? payload : payload?.avatarId;
    if (!isSafePersonaKey(avatarId)) {
        return;
    }

    // PERSONA_DELETED is emitted after SillyTavern removes the persona. If the
    // key still belongs to an existing persona, never touch its outfits.
    if (power_user.personas?.[avatarId]) {
        return;
    }

    const count = personaOutfitsList(avatarId)?.length ?? 0;
    const name = String(payload?.name || 'the deleted persona').trim() || 'the deleted persona';

    delete settings.outfitsByPersona[avatarId];
    delete settings.outfitSelections[avatarId];
    if (getActivePersonaKey() === avatarId) {
        editingId = null;
        draftOutfit = null;
        hideOutfitWindows();
        renderList();
    }
    saveSettings();

    if (count > 0) {
        toastr.info(`Deleted ${count} outfit${count === 1 ? '' : 's'} for ${name}.`, 'Persona Outfits', { escapeHtml: true });
    }
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
    if (ctx.eventTypes?.PERSONA_UPDATED) {
        ctx.eventSource.on(ctx.eventTypes.PERSONA_UPDATED, onPersonaUpdated);
    }
    if (ctx.eventTypes?.PERSONA_DELETED) {
        ctx.eventSource.on(ctx.eventTypes.PERSONA_DELETED, onPersonaDeleted);
    }

    console.log('[Persona Outfits] Loaded');
});
