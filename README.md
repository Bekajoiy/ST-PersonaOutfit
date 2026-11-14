# Persona Outfits

A wardrobe for each SillyTavern persona. Save outfits with a description and an optional image, then equip them from a floating panel.

**Version 1.10.0** · Tested with SillyTavern 1.19.0 · [Project site](https://bekajoiy.github.io/ST-PersonaOutfit/)

## Install or update

- **Install** via **Extensions → Install Extension**. Paste `https://github.com/Bekajoiy/ST-PersonaOutfit`, confirm, and reload SillyTavern.
- **Update** an existing installation via **Extensions → Manage Extensions**, then reload. Saved outfits and preferences carry over.
- **Manual install**. Copy the repository folder into `data/<your-user>/extensions/` and reload.

## Use your wardrobe

1. Add `[outfit: ]` to the active persona’s description.
2. Click the shirt button or run `/outfits`.
3. Choose **New outfit**, enter a name and description, optionally add an image, and save.
4. Click an outfit to equip it. The description updates in place and the outfit is highlighted.

## Customize the panel

- **List, Compact, and Gallery** share one saved order per persona. Drag the List grip, a Compact entry, or a Gallery image. On touch screens, use the tile’s grip. Use the ellipsis or right-click to edit or delete a Compact or Gallery entry.
- **Gallery Settings** opens from the sliders icon. Choose **2–6 columns** and **65, 85, 110, or 140 px** square thumbnails. The panel resizes to fit, with horizontal scrolling on narrow screens.
- **Crop a thumbnail** by clicking the image preview in the outfit editor. Drag or use the arrow keys to frame it, then zoom with the slider or mouse wheel. **Apply** updates the draft. **Save** commits the crop and preserves the full image. Remote images can be cropped when the host permits canvas access.
- **Floating image and description windows** can be toggled, dragged, and resized independently. Find their settings under **Extensions → Persona Outfits**.

## Dynamic Chat Avatar

Enable **Dynamic Chat Avatar** under **Extensions → Persona Outfits** to show the equipped thumbnail beside messages attributed to the active persona. The setting is off by default. Older messages without saved persona attribution keep their native avatar. Original persona files and chat history remain intact.

Outfits and uploaded images are stored in SillyTavern’s settings. External image URLs are loaded in the browser. Deleting an outfit removes its stored images, and deleting a persona removes its outfit collection.

## License

[CC0 1.0 Universal](LICENSE)
