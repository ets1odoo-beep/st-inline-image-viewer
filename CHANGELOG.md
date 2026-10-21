# Changelog

## 1.3.0 (2026-10-21)

### Rerender fidelity

- Rerenders now go through the same pipeline Image Auto Generation uses for a fresh picture: the FF4 VIR look lock (stored identity rows pasted into the identity sentence), then auto-gen's effective-prompt builder (cleaner, LoRA triggers, people count, character SD prefix, the Krea2 "no text" closer by profile). Without auto-gen installed the old prefix-only path is used.
- `/sd` is called with the same arguments auto-gen sends: `processing: minimal`, `extend: false`, the negative prompt, and width/height. The resolution fallback is auto-gen's default type (portrait, not square) and its default presets; a size is always sent.
- Optional seed per rerender (**Rerender seed** setting: new random seed, or leave it to the backend). Only matters when the ComfyUI workflow uses the `%seed%` placeholder.
- The result is dropped with a warning if the message was deleted, renumbered, swiped or the chat switched while SD was rendering; a per-image in-flight lock stops a held ArrowRight from starting several renders.
- Rerender is offered only for generated images (a stored prompt or type from auto-gen, or a prompt-like alt text), and reading the prompt no longer writes to the message as a side effect.

### Fixes

- Four of the five event hooks used names SillyTavern never emits (`messageFormatting`, `messageRendered`, `chatChanged`, `characterSelected`) and never ran. The extension now subscribes to the real events: chat change, character/user message rendered, message swiped/updated.
- The `<pic>` prompt regex uses a backreference, so an apostrophe inside a double-quoted prompt no longer truncates it.
- Variant slots are matched by image URL first and by DOM position only for a new image, so a failed earlier `<pic>` or an edited message does not shift prompts between images.
- One debounced chat save for swipes, prompt edits and link rewrites (every swipe used to save immediately); the current swipe text is kept in step and `MESSAGE_UPDATED` is emitted after a link rewrite.
- Touch and mouse: presses on the toolbar, panels or title no longer start a drag or get swallowed; a pan that ends on the background no longer closes the viewer; pinch zoom uses the same limits as the wheel and zooms around the pinch midpoint; Ctrl/Cmd shortcuts (browser zoom, Ctrl+0, Cmd+I) are left alone.
- Markdown links written by a rerender escape quotes, brackets, parentheses and `#` like auto-gen does; error toasts show the error message.

### Settings and cleanup

- New settings block (Extensions panel): rerender seed mode, zoom step, inline image max height (vh), debug logs.
- Removed unused CSS (`.iiv-inline-img-swipes*`, the global `.img_enlarged_*` overrides), the unused markdown sanitizer, and duplicated URL helpers (now shared module-level functions, also exported as `window.iivApi` for the node harness).

## 1.2.1 (2026-10-21)

- Viewer keyboard shortcuts (Escape, arrows, zoom keys) no longer fire while typing in an input, textarea or contenteditable field, so editing a prompt inside the viewer does not close it or change the image.

## 1.2.0

- Added full-screen custom image viewer controls.
- Added pan, zoom, touch, pinch, and keyboard navigation.
- Added actual-size/fit toggle.
- Added inline image variant stacks.
- Added Stable Diffusion rerender support through `/imagine` or `/sd`.
- Added per-image prompt persistence.
- Added prompt copy and prompt edit rerender.
- Added current variant delete with confirmation.
- Added previous/next image navigation inside the same message.
- Added robust markdown image parsing.
- Added safer DOM processing to avoid hidden panels, code blocks, reasoning blocks, and non-chat UI.
- Added debounced mutation processing.
- Added clean minimal character avatar viewer mode.
- Added original avatar upload helper.

## 1.1.0

- Added custom popup viewer.
- Added keyboard controls.
- Added loading and error states.
- Improved mobile controls.
- Improved listener cleanup.

## 1.0.0

- Initial inline image controls.
