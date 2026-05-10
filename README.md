# SillyTavern Inline Image Viewer

Inline Image Viewer improves image handling inside SillyTavern chat messages. It adds native-style controls to inline markdown images, a custom pan/zoom viewer, inline image variant support, Stable Diffusion rerender shortcuts, and a clean full-size character avatar viewer.

## Features

- Adds controls to inline markdown images in chat messages.
- Opens inline and attached images in a custom full-screen viewer.
- Supports mouse wheel zoom, drag pan, touch drag, and pinch zoom.
- Keyboard controls:
  - `Esc`: close viewer
  - `0`: reset zoom
  - `+` / `-`: zoom in or out
  - `ArrowLeft` / `ArrowRight`: previous or next variant
  - `Shift + ArrowLeft` / `Shift + ArrowRight`: first or last variant
  - `Alt + ArrowLeft` / `Alt + ArrowRight`: previous or next image in the same message
  - `I`: show or hide image details
- Viewer toolbar:
  - previous/next image in message
  - previous/next variant
  - reset zoom
  - actual-size/fit toggle
  - open in new tab
  - copy image URL
  - copy image prompt
  - edit prompt and rerender
  - delete current variant with confirmation
  - download image
- Inline controls:
  - previous/next variant
  - expand
  - open in new tab
  - copy prompt
  - copy URL
  - delete current variant with confirmation
  - download image
- Stable Diffusion rerender support through SillyTavern slash commands:
  - uses `/imagine` when available
  - falls back to `/sd`
  - preserves per-image variant stacks in message metadata
  - stores per-image prompts in message metadata
- Robust markdown image parsing:
  - handles URLs with parentheses
  - handles quoted titles
  - handles escaped brackets
  - handles multiline alt text
- Avoids wrapping images inside code blocks, reasoning blocks, hidden templates, extension panels, and non-chat UI.
- Adds click-to-view for character avatars.
- Adds separate avatar upload buttons, including an "upload original as-is" flow that temporarily preserves the original image without changing your normal resize setting.
- Uses a minimal avatar viewer mode without chat-image toolbar clutter.

## Installation

### Install From SillyTavern's Extension Installer

After this extension is published to GitHub, you can install it directly from SillyTavern:

1. Open SillyTavern.
2. Open **Extensions**.
3. Choose **Install extension** or **Install from Git URL**.
4. Paste the GitHub repository URL:

   ```text
   https://github.com/ets1odoo-beep/st-inline-image-viewer
   ```

5. Leave **Branch or tag name** empty to use the default branch, or enter a branch/tag such as:

   ```text
   main
   v1.2.0
   ```

6. Choose **Install for all users** or **Install just for me**.
7. Reload SillyTavern and enable **Inline Image Viewer** if it is not enabled automatically.

### Manual Install

1. Download or clone this repository.
2. Copy the folder `st-inline-image-viewer` into:

   ```text
   SillyTavern/public/scripts/extensions/third-party/
   ```

3. Restart SillyTavern or reload the browser page.
4. Open SillyTavern Extensions.
5. Enable **Inline Image Viewer**.

The final folder should look like:

```text
SillyTavern/
  public/
    scripts/
      extensions/
        third-party/
          st-inline-image-viewer/
            index.js
            style.css
            manifest.json
            README.md
```

## Usage

Inline markdown images in chat messages automatically receive controls when they render.

Example markdown image:

```markdown
![masterpiece, cinematic portrait, red dress](user/images/example.png)
```

Click the image or the magnifying glass button to open the full viewer.

## Variant And Rerender Behavior

The extension stores inline image variants in:

```text
msg.extra.inlineImageVariants
```

It stores per-image prompts in:

```text
msg.extra.inlineImagePrompts
```

When you rerender an inline image, the new image is added as a variant. Swiping variants updates the visible markdown image for that message. Deleting a variant removes only the selected inline variant reference after confirmation.

## Stable Diffusion Notes

Rerender requires a working SillyTavern image generation command:

- `/imagine`, or
- `/sd`

If neither command is available, the extension will show a warning and leave the image unchanged.

When available, the extension also reuses dimensions stored by `st-image-auto-generation`.

## Avatar Viewer

Character avatar click-to-view uses a minimal viewer mode:

- no toolbar
- no prompt panel
- no variant controls
- no delete controls

This keeps avatar inspection clean while preserving pan, zoom, reset, and close behavior.

## Compatibility

Designed for SillyTavern third-party extension loading.

No external libraries are required.

## Privacy And Data

The extension runs locally in the SillyTavern browser page. It does not add a server component and does not upload data by itself.

It may update the current chat message metadata when you use variant actions or rerender an inline image.

## Troubleshooting

If controls do not appear:

- Make sure the extension is enabled.
- Reload the browser page.
- Confirm the image is inside a chat message, not inside a code block, reasoning block, extension panel, or hidden template.

If rerender does not work:

- Confirm your SillyTavern image generation extension is enabled.
- Confirm `/imagine` or `/sd` works manually.
- Check the browser console for extension warnings.

If external images do not load:

- Check SillyTavern's external media policy.
- The extension respects `forbid_external_media`.

## License

MIT License. See [LICENSE](LICENSE).
