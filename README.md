# Persona Outfits

A SillyTavern extension that gives every persona its own outfit list.

Save outfits with a name, description and optional image. Click an outfit to write it into the active persona's description, then browse its image and description in their own floating windows.

- **Repository:** <https://github.com/Bekajoiy/ST-PersonaOutfit>
- **Landing page:** <https://bekajoiy.github.io/ST-PersonaOutfit/>

## Features

- **Per-persona lists.** Switching persona switches the outfit list; the panel header shows whose wardrobe it is.
- **One-click wear.** Replaces `[outfit: ]` in the persona description, leaving the rest of the text untouched.
- **Optional image and description windows.** Separate floating windows, draggable and resizable, each with its own on/off toggle.
- **Drag to reorder.** Grab the left grip on a row; the order is saved per persona.
- **Local images.** Downscaled and stored in SillyTavern's settings. No upload service and no telemetry.
- **Theme-aware UI.** Matching floating panels and a shirt button you can drag out of the way.

## Installation

### From Git (recommended)

1. Open **Extensions → Install Extension** in SillyTavern.
2. Paste:

   ```
   https://github.com/Bekajoiy/ST-PersonaOutfit
   ```

3. Confirm, then reload SillyTavern.

### Manually

Copy the project folder into `data/<your-user>/extensions/` (for the default user: `data/default-user/extensions/`), then reload SillyTavern.

## Usage

1. Put `[outfit: ]` anywhere in the active persona's description.
2. Click the shirt button in the corner, or run `/outfits`.
3. Click **New outfit**, add a name, description and optional image, then **Save**.
4. Click a row to wear the outfit. The placeholder becomes `[outfit: your description]`.
5. Drag the grip on the left of a row to reorder outfits. The order is saved per persona.
6. Use **Extensions → Persona Outfits** to toggle the image and description windows, or reset their positions and sizes.

## Notes

- Tested with SillyTavern 1.19.0.
- Deleting an outfit removes its full image and thumbnail from settings, and clears the displayed image.
- New outfits are unsaved drafts until **Save**; Cancel/Escape discards them and any picked image.
- Accepted image sources are raster data URLs (PNG, JPEG, WebP, GIF, AVIF, BMP) or `http(s)` URLs. `javascript:`, SVG data URLs, `blob:` and local-file URLs are rejected. Uploads are capped at 20 MB.
- Deleting a persona also removes that persona's outfit list and images from settings. Only that persona's key is removed; outfits for other personas are untouched.
- External image URLs are loaded by the browser, so the remote host will see the request.

## License

Released under [CC0 1.0 Universal](LICENSE).
