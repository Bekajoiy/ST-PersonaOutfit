# Persona Outfits — Agent Handoff

## One-line description

A client-side SillyTavern third-party extension that gives every persona its own outfit list. Clicking an outfit writes its description into the active persona's `[outfit: ]` placeholder and optionally opens the outfit image and description in two separate floating windows.

## Project facts

- **Name:** Persona Outfits
- **Version:** 1.10.0 (see `manifest.json`)
- **Author:** Bekajoiy
- **Repository:** <https://github.com/Bekajoiy/ST-PersonaOutfit>
- **Landing page:** <https://bekajoiy.github.io/ST-PersonaOutfit/>
- **License:** CC0 1.0 Universal
- **Tested with:** SillyTavern 1.19.0 "staging" (`ad29cbda6`)
- **Install location used here:** `data/default-user/extensions/Persona-Outfits/`
- **Runtime files:** `manifest.json`, `index.js`, `style.css`, `thumbnail-crop.js`
- **Repository-only files:** `README.md`, `LICENSE`, `index.html` (landing page), `docs/`, `.gitignore` — not loaded by SillyTavern

`manifest.json` has `loading_order: 25`, `requires: []`, `optional: []`, and loads `index.js` + `style.css`.

## Core concepts

- **Persona key:** the active persona's avatar filename, `user_avatar` (e.g. `1717280519738-Sam.png`), not the persona display name. Renaming a persona does not break its outfits.
- **Outfits are per persona:** stored in `extension_settings.persona_outfits.outfitsByPersona[avatarId]`. Switching persona switches the list.
- **Placeholder:** the active persona's description contains `[outfit: ]` (or `[outfit:]`, any case/spacing). Wearing an outfit replaces every `[outfit: ...]` occurrence with the outfit description and leaves the rest of the description untouched.
- **Floating UI:** one outfit panel, an optional image window, and an optional description window. All are draggable; image and description windows are independently resizable. A draggable shirt button and `/outfits` open/close the list.

## Outfit object

```json
{
  "id": "uuid-or-generated-string",
  "name": "Gym",
  "description": "black leggings, an oversized hoodie and trainers",
  "image": "data:image/webp;base64,...",
  "thumb": "data:image/webp;base64,...",
  "crop": { "x": 0.5, "y": 0.5, "zoom": 2 }
}
```

- `image` and `thumb` may be empty strings.
- File uploads produce two distinct data URLs: a full image (max 1024 px edge, WebP quality 0.86, JPEG fallback) and a default thumbnail with a 160 px maximum edge. Applying a crop creates a 256 × 256 square thumbnail.
- Optional `crop` contains normalized center coordinates and a zoom between 1 and 5. Outfits without metadata open centered. Replacing or removing the image resets the crop.
- For an uncropped image URL, `image` and `thumb` may both contain the same URL string. That is a reused string, not a duplicated image file.
- The first `[outfit: ...]` marker is the source of truth. A per-persona selection records the exact marker and outfit ID after equip, so identical descriptions can still distinguish outfits. Legacy settings and changed markers fall back to the original description match.

## Settings data

Namespace: `extension_settings.persona_outfits`.

```json
{
  "outfitsByPersona": {
    "<avatar-id>": [ /* outfit objects */ ]
  },
  "outfits": [],
  "outfitSelections": {
    "<avatar-id>": { "id": "outfit-id", "marker": "[outfit: saved description]" }
  },
  "displayMode": "list",
  "galleryColumns": 3,
  "galleryImageSize": "medium",
  "dynamicChatAvatar": false,
  "appendIfMissing": true,
  "showImagePanel": true,
  "showTextPanel": true,
  "panelOpen": true,
  "panel": { "left": 138, "top": 522 },
  "imagePanel": { "left": 138, "top": 96 },
  "imagePanelSize": { "width": null, "height": null },
  "textPanel": { "left": null, "top": null },
  "textPanelSize": { "width": null, "height": null },
  "toggle": { "left": null, "top": null }
}
```

- `outfits` is the legacy global list. On first access to a valid persona, its entries are merged into that persona's list and the legacy array is cleared. This migration is one-time/heuristic: it assigns old global outfits to whichever persona is active when migration runs.
- The obsolete `syncPersonaAvatar` setting is removed on load and saved through the native settings debounce. `dynamicChatAvatar` defaults to false independently.
- `galleryColumns` is a global integer preference from 2–6 and defaults to 3. `galleryImageSize` accepts `small`, `medium`, `large` and `extraLarge`, corresponding to 65, 85, 110 and 140 px. Existing valid column preferences carry over and the size defaults to Medium.
- `null` positions/sizes mean “use the default placement/size”.
- Empty persona lists are pruned on load; deleting the last outfit removes that persona's key. The in-memory `outfitsByPersona` object has a null prototype.
- `activeOutfitId` is an obsolete field and is deleted on load. The new optional `outfitSelections` map uses the original avatar keys. Deleting a worn outfit can record a null ID for the existing marker while other outfits remain, so an outfit with identical text is not selected by accident.

## User-facing behavior

- **Toggle button:** fixed, draggable; a click toggles the outfit panel, a drag moves it. Position is remembered.
- **`/outfits`:** slash command toggles the outfit panel.
- **Panel header:** `Outfits · <persona name>`. If no persona is active, the name area shows “No persona”.
- **List:** left drag grip, thumbnail, name, description snippet, “Wearing” badge, edit and delete buttons.
- **Compact:** responsive grid of small thumbnail/name buttons.
- **Gallery:** square image buttons with tooltips and placeholders. The Gallery Settings popover adjusts the fixed grid immediately, remains open across selections and dismisses on Escape or outside click. The gallery scrolls horizontally when its preferred grid is wider than the viewport.
- **Display switch:** header buttons save the selected mode and keep the inline editor mounted through redraws. Compact and Gallery share Edit/Delete popovers with ellipsis, context-click, keyboard and touch access.
- **Click a row:** wears the outfit and highlights it without a success toast. `Enter`/`Space` on the focused row does the same.
- **Drag to reorder:** use the left grip in List, the entry/image in Compact/Gallery, or the tile grip on touch screens. The source dims, an insertion line shows the target gap, and hovering near an edge scrolls the list. Dropping saves the persona’s array in the new order across all three views.
- **New outfit:** opens an inline editor as an unsaved draft. The draft is not written to settings until **Save**. Cancel or Escape discards the draft and any image picked for it. The draft editor appears even when the persona currently has no outfits.
- **Editor fields:** name, description, image file picker, image URL, preview, remove image, Save, Cancel.
- **Crop thumbnail:** click the image preview to open a square crop in a modal. The slider, wheel and pointer/arrow controls move the image. Apply updates the editor draft only.
- **Edit existing outfit:** edits in place; Save updates the object. If the edited outfit is currently worn, it is re-applied automatically.
- **Delete:** confirmation popup; removes only that outfit from the captured persona's list; does not edit the persona description. The image window is closed/cleared if the deleted outfit was displayed.
- **Clear:** replaces every `[outfit: ...]` in the description with `[outfit: ]`; it does not delete other text. If no placeholder exists, it only warns.
- **Image window:** image only, title in the header, close button, draggable, resizable from the bottom-right grip. Position/size remembered.
- **Description window:** outfit name in the header and the description in the body (line breaks preserved), close button, draggable, resizable. Position/size remembered.
- **Independent visibility:** `showImagePanel` and `showTextPanel` settings independently control whether applying an outfit opens each window.
- **Reset:** “Reset floating windows” in extension settings resets positions and sizes of the list/image/text/toggle UI.

## Persona integration

Imports:

```js
import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { user_avatar, setPersonaDescription } from '../../../personas.js';
```

### Applying an outfit

1. Resolve the outfit from the current persona's list.
2. Use its description; if empty, fall back to its name.
3. Require `user_avatar` and `power_user.personas[user_avatar]`.
4. Read the live `power_user.persona_description` (preferred over a possibly stale descriptor).
5. Replace every match of `/\[outfit\s*:[^\]]*\]/gi` using a function replacement (so `$` in descriptions is preserved).
6. If no placeholder exists and `appendIfMissing` is true, append `[outfit: description]` at the end; otherwise warn and abort.
7. Write both `power_user.persona_descriptions[avatar].description` and `power_user.persona_description`.
8. `saveSettingsDebounced()`, call `setPersonaDescription()`, emit `PERSONA_UPDATED`, re-render the list, and show windows according to the two visibility settings.

The extension never truncates or rewrites the rest of the persona description.

### Persona events

- `PERSONA_CHANGED` / `CHAT_CHANGED`: if the avatar key changed, discard the editor/draft, hide the image/description windows, update the header, and re-render the new persona's list.
- `PERSONA_RENAMED`: refresh the persona name in the header.
- `PERSONA_DELETED` (v1.5.0): delete only the deleted persona's `outfitsByPersona` key and images, provided the avatar key no longer exists in `power_user.personas`; clear displayed/editing state and save. Other personas are untouched. This is guarded so a re-created or still-existing persona cannot lose its outfits.
- `PERSONA_UPDATED` checks the current marker and refreshes the selection and chat avatar when needed. The listener never emits another persona event.

### Dynamic Chat Avatar

SillyTavern 1.19 sends user messages with a saved `force_avatar` persona thumbnail URL. Each rendered `.mes` uses `mesid` to index the live `chat` array. The extension checks the user and system flags and matches the active avatar filename against both the saved reference and the native image’s source. It accepts same-origin persona thumbnails (including cache-busted URLs) and native `User Avatars/` paths. A message without a saved reference is ambiguous because the native renderer defaults its displayed image to the current persona, so it is left alone. Author names never participate in matching.

The selected outfit still comes from `getActiveOutfit()`. The extension loads the outfit thumbnail first and falls back to the full image. After it loads, a CSS class on matching message images and a single custom property on `#chat` change the drawn image while retaining the native `src` and image box. On clear, persona change, deletion, invalid image, or disabling the option, removing the display override reveals the native avatar. An outdated image load cannot repaint after a newer outfit or persona selection. The feature operates on chat DOM only, so avatar files, persona cards, locks, and saved message data remain intact.

One `MutationObserver` on `#chat` handles direct message insertions (including old history and batch redraws) and in-place changes to message attribution or avatar elements. It deduplicates affected rows per batch. It ignores the class and style attributes it writes and is disconnected when there is no usable override. Existing persona/chat events drive outfit state and the initial render resolves it again on reload.

## Code map (`index.js`)

- `defaultSettings()` / `loadSettings()` — defaults, legacy migration/normalization, pruning, null-prototype persona map.
- `getActivePersonaKey()`, `getPersonaName()`, `getPersonaOutfits()`, `ensurePersonaOutfits()`, `migrateLegacyOutfits()` — persona keying and migration.
- `buildUi()` — injects the toggle, outfit panel, image panel, description panel, and settings block into `#extensions_settings2`; binds close buttons, drag/resize handlers, image load handling.
- `renderList()`, `buildListRow()`, `buildOutfitTile()` — shared per-persona view and editor, List rows and Compact/Gallery tiles.
- `updateChatAvatar()` / `clearChatAvatar()` — load and release a chat-only image override. `markChatAvatar()` / `observeChatAvatars()` — attribute and update newly added or changed message rows.
- `bindGallerySettings()` — saves Gallery preferences and updates the CSS sizing variables. The panel width is the fixed tracks plus gaps, padding, the native scrollbar gutter and borders. The outer panel is viewport-capped and the popover is positioned within the viewport.
- `bindReorder()` — one delegated pointer controller for all views. It starts after 5 px, groups measured tiles by row, scrolls at the list edges on both axes, and moves the existing array item on drop. It suppresses the click following a drag, clears frame/capture state on cancellation, and remounts the current inline editor with its draft intact.
- `addOutfit()` — creates an unsaved draft and opens the editor.
- `buildEditor()` — inline editor; handles file/URL images, preview, downscaling, Save/Cancel/Escape, and draft-vs-existing semantics.
- `applyOutfit()` — placeholder rewrite and window display.
- `clearOutfit()` — replaces placeholders with `[outfit: ]`.
- `deleteOutfit()` — confirmation, captured-persona deletion, image/window cleanup.
- `showOutfitWindows()`, `showOutfitImage()`, `showOutfitText()`, `hideImagePanel()`, `hideTextPanel()`, `hideOutfitWindows()` — floating-window lifecycle.
- `isSafeImage()`, `readFileAsDataUrl()`, `loadImage()`, `fileToOutfitImages()`, `drawScaledImage()` — image validation and processing.
- `makeDraggable()`, `makeToggleDraggable()`, `makeResizable()`, `placeDefault()`, `restorePosition()`, `clampIntoView()` — floating UI positioning.
- `onPersonaContextChanged()`, `onPersonaDeleted()`, `updatePersonaHeader()` — event handling.
- `registerCommands()` — `/outfits`.
- `escapeHtml()` — escape helper for SillyTavern popup strings.

Key DOM IDs/classes: `#po-toggle`, `#po-panel`, `#po-list`, `#po-add`, `#po-clear`, `.po-row`, `.po-drag-handle`, `.po-editor`, `#po-image-panel`, `#po-image`, `#po-image-resize`, `#po-text-panel`, `#po-text-body`, `#po-text-resize`, `#po-close`, `#po-image-close`, `#po-text-close`.

Settings controls: `#po-gallery-settings-button`, `#po-setting-append`, `#po-setting-show-image`, `#po-setting-show-text`, `#po-setting-chat-avatar`, `#po-reset-positions`.

## Thumbnail crop editor

`thumbnail-crop.js` owns the dialog, crop bounds, image transforms, and shared canvas encoder. The dialog maps the fixed square to source-image pixels and clamps the crop inside the source. Dragging and zooming update transforms. Apply uses the same bounds to encode a 256 × 256 thumbnail in WebP with a JPEG fallback. The inline editor stores the new `thumb` and optional `crop` only on Save. Gallery, Compact and List all prefer `thumb` and the floating image window reads `image`.

The modal loads an anonymous CORS image for canvas access. URL images remain usable via the original URL if cropping is unavailable. The crop dialog disconnects its resize observer and releases its image on close. It also closes if its parent outfit editor is discarded or the outfit panel is closed.

## Image handling and safety

- **Uploads:** capped at 20 MB; files must have an `image/*` MIME type; rasterized through canvas, never uploaded to a server.
- **URL sources:** `http(s)` or a base64 raster data URL.
- **Accepted data URL types:** PNG, JPEG, WebP, GIF, AVIF, BMP.
- **Rejected:** `javascript:`, `blob:`, `file:`, SVG data URLs, non-image data URLs, and strings over ~4 MB.
- **No server/upload/telemetry:** images are base64 in SillyTavern's `settings.json`. External image URLs are loaded by the browser, so the remote host sees a request.
- **Deletion:** deleting an outfit removes its `image` and `thumb` from settings and clears the displayed `<img>` `src`; if the deleted outfit is currently displayed, both floating windows are hidden.
- **Draft cancel:** an image selected for an unsaved new outfit never reaches settings; the draft and its image are discarded.
- **No duplication:** file uploads store one full image and one smaller thumbnail (intentional derivative). Uncropped URL images reuse their URL for both fields. Cropping stores a thumbnail while retaining the source URL.
- **Memory:** hiding/closing a window removes the image `src` and clears the text body. Browser-decoded image memory may persist until garbage collection; the plugin keeps no reference.

## Security and data-lifecycle notes

- User names/descriptions are rendered with `.text()` or attribute setters. SillyTavern popups render HTML, so the delete confirmation escapes the outfit name before passing it to `Popup.show.confirm()`. Toastr messages use escaping.
- Persona keys `__proto__`, `constructor`, and `prototype` are rejected; the persona map uses a null prototype.
- New outfits are drafts until Save; Cancel/Escape leaves no settings entry or image.
- Empty persona lists are pruned; deleting the last outfit removes the key.
- Duplicate initialization guard checks for an existing `#po-toggle` before building the UI.
- No `fetch`/XHR, `eval`, `new Function`, `document.write`, `localStorage`, cookies, intervals, or user-content `innerHTML` in the extension.
- The only timer is a window-resize debounce, cleared on each resize; there are no intervals.
- Deleting a persona deletes its outfit key/images via `PERSONA_DELETED` (v1.5.0), with guards described above.
- Multiple SillyTavern tabs use last-writer-wins settings; refresh/close stale tabs after changing the extension.
- SillyTavern backups may retain older `settings.json` copies; the extension cannot purge external backups.

## SillyTavern-specific gotchas

- SillyTavern 1.19 gives `<html>` an identity transform, so a fixed-position element's containing block can be zero-height. Do **not** position floating panels with `bottom:` alone; the extension computes `top/left` from `window.innerHeight`/`innerWidth` and re-clamps on open/resize.
- `setPersonaDescription()` is imported from `personas.js` and is needed to refresh the persona editor after changing `power_user.persona_description`.
- `user_avatar` is a live ES-module binding; use it through `getActivePersonaKey()`, not a captured copy.
- The extension is loaded as a third-party ES module; its relative imports resolve from `/scripts/extensions/third-party/Persona-Outfits/`.

## Known limitations

- Images are base64 in `settings.json`; many/large outfits can make that file large and settings saves heavier. There is no separate file storage.
- External image URLs cause browser requests to third-party hosts.
- Drag reorder is pointer-only; no keyboard reorder and no undo.
- New outfit drafts are lost if the page reloads before Save.
- An open editor/draft is discarded if the persona changes (by design).
- There is no cross-persona “move/copy outfit” UI. Outfits are deliberately scoped to one persona.
- Deleting a persona removes its outfits (v1.5.0), but if the `PERSONA_DELETED` event is missed (e.g. external/manual data edits), an orphan key may remain.
- Persona deletion is destructive for that persona's outfits; SillyTavern backups are the only recovery path.
- The extension depends on SillyTavern 1.19-era APIs and chat message markup. The Compact and Gallery action menus use the browser Popover API.

## Testing status

Verified in SillyTavern 1.19.0: per-persona switching and header names, apply/clear behavior, edit/save, delete with confirmation, drag reorder and persistence, independent image/text window toggles, dragging/resizing panels and toggle, image downscaling and thumbnail generation, draft cancel with no settings persistence, image/thumb removal from settings on delete, XSS escaping with a hostile outfit name, rejection of `javascript:`/SVG image sources, and no console errors from the extension. The test data was removed and the user's descriptions/outfits were restored.

The v1.6.0 browser regression used an isolated SillyTavern 1.19.0 data directory and Chromium. It exercised all three views, mode and equipped-outfit persistence after reload, keyboard and pointer actions, per-persona switching, native rename and deletion, avatar fallback, and original-file checksums. It also checked for browser exceptions, extension warnings, and repeated persona events.

The v1.7.0 browser regression used a separate SillyTavern 1.19.0 instance with two personas sharing the same name and a 289-message history. It exercised native sends, loading earlier messages, redraws, chat and persona switches, reloads, outfit editing and deletion, setting persistence, image fallback, and unchanged persona cards and avatar file hashes.

The v1.8.0 regression ran in Chromium against isolated SillyTavern 1.19.0 data. It exercised a 33-outfit collection, cross-row reordering, held-pointer autoscroll in both directions, click and touch activation, the 2–6 column options, narrow and resized panels, inline editor state, context actions, and persona-independent order after reload. It also checked that reordering retained the equipped outfit for legacy duplicate descriptions and preserved Dynamic Chat Avatar.

The v1.9.0 browser regression used isolated SillyTavern 1.19.0 data in Chromium. It checked portrait/landscape pixel output, zoom bounds and wheel control, cancel paths, matching thumbnails across views, preservation of the full image, allowed and blocked CORS, reload persistence, and dialog cleanup on persona switch.

The v1.10.0 Chromium regression on isolated SillyTavern 1.19.0 data checked all 20 Gallery combinations, viewport clamping and horizontal drag autoscroll, popover input and dismissal, silent equip and the missing-placeholder warning, settled sizing, mode isolation, and restored preferences and order after reload.

## Guidance for a modifying agent

- Preserve the settings namespace and keys for backward compatibility; migrate rather than drop existing `outfitsByPersona` data.
- Keep outfit lists keyed by avatar filename and keep the delete guard/event behavior.
- Continue escaping any user text passed to `Popup` (which uses `innerHTML`); use `.text()` elsewhere.
- Keep new-outfit drafts out of settings until Save, and preserve image validation/size caps.
- Do not change persona fields other than the `[outfit: ]` placeholder without explicit user intent.
- Re-test persona switching, persona deletion, image deletion, draft cancel, and popup escaping after any change.
