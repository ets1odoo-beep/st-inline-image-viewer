/**
 * Inline Image Viewer Extension for SillyTavern
 *
 * Adds the same controls (Expand/Zoom, Open in New Tab, Copy URL)
 * to inline images inside chat messages that attached images already have.
 *
 * Uses SillyTavern's native Popup system for zoom/enlarge behavior.
 */

import { Popup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { power_user } from '../../../power-user.js';

// ── Pure helpers (no DOM) ────────────────────────────────────────────────────
// Kept outside the jQuery-ready callback so they can be unit-tested under node
// (tools/profile-harness) and reused by the rerender path.
const IIV_SETTINGS_KEY = 'st-inline-image-viewer';
const IIV_DEFAULTS = Object.freeze({
    debug: false,
    zoomStep: 1.2,          // wheel / keyboard / button zoom factor
    inlineMaxHeightVh: 40,  // inline image max height in the chat, in vh
    seedMode: 'random',     // 'random' = new seed per rerender; 'keep' = leave seed to the backend
});
const IIV_GENERIC_ALT_RE = /^(?:generated )?images?$/i;
// Same fallback presets as st-image-auto-generation's defaults.
const IIV_DEFAULT_PRESETS = Object.freeze({
    portrait: { width: 512, height: 768 },
    landscape: { width: 768, height: 512 },
    closeup: { width: 512, height: 640 },
    scene: { width: 768, height: 448 },
    square: { width: 512, height: 512 },
});
// Backreference so an apostrophe inside a double-quoted prompt ("girl's dress") is kept.
const IIV_PIC_TAG_RE = /<pic\b[^>]*?\sprompt=(['"])([\s\S]*?)\1[^>]*\/?>/gi;

function iivOrigin() {
    return (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost';
}

// Markdown-safe URL: quotes end the URL and start a title, ) ends it, [ ] end
// the image syntax, < > form an autolink, # starts a fragment. Mirrors the
// encoder in st-image-auto-generation so both write the same links.
function iivEncodeMarkdownUrl(url) {
    return String(url || '')
        .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
        .replace(/ /g, '%20')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/"/g, '%22')
        .replace(/'/g, '%27')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E')
        .replace(/\[/g, '%5B')
        .replace(/\]/g, '%5D')
        .replace(/\|/g, '%7C')
        .replace(/#/g, '%23');
}

// Pathname without origin, decoded and lower-cased, for comparing the same
// image written as "http://host/foo%20bar.png", "/foo bar.png" or "foo bar.png".
function iivNormalizeUrl(url) {
    const raw = String(url || '');
    try {
        const parsed = new URL(raw, iivOrigin());
        const value = parsed.origin === iivOrigin() ? parsed.pathname : parsed.href;
        return decodeURIComponent(value).replace(/^\/+/, '').toLowerCase();
    } catch {
        try { return decodeURIComponent(raw).replace(/^\/+/, '').toLowerCase(); }
        catch { return raw.toLowerCase(); }
    }
}

// Relative, markdown-encoded path for storing in the chat (works across
// localhost / LAN hostnames).
function iivToRelativePath(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url, iivOrigin());
        const path = parsed.origin === iivOrigin() ? parsed.pathname.replace(/^\/+/, '') : parsed.href;
        return iivEncodeMarkdownUrl(path);
    } catch {
        return iivEncodeMarkdownUrl(url);
    }
}

// Variant slot: the stack that already holds this URL wins, so a failed
// earlier <pic> or an edited message does not shift prompts between images;
// an unseen image falls back to its DOM position (the key auto-gen writes).
function iivResolveSlotKey(variants, src, index) {
    const norm = iivNormalizeUrl(src);
    if (variants && typeof variants === 'object' && norm) {
        for (const [key, stack] of Object.entries(variants)) {
            if (Array.isArray(stack) && stack.some(entry => iivNormalizeUrl(entry) === norm)) return key;
        }
    }
    return 'inline_img_' + Math.max(0, Number(index) || 0);
}

function iivPicPromptAt(mes, index) {
    const re = new RegExp(IIV_PIC_TAG_RE.source, 'gi');
    let m, i = 0;
    while ((m = re.exec(String(mes || ''))) !== null) {
        if (i === index) return String(m[2] || '').trim();
        i++;
    }
    return '';
}

// Prompt for a rerender, in priority order; read-only.
function iivResolvePrompt({ stored = '', alt = '', mes = '', index = 0, title = '' } = {}) {
    if (stored && String(stored).trim()) return String(stored).trim();
    const cleanAlt = String(alt || '').trim();
    if (cleanAlt && !IIV_GENERIC_ALT_RE.test(cleanAlt)) return cleanAlt;
    const fromTag = iivPicPromptAt(mes, index);
    if (fromTag) return fromTag;
    const cleanTitle = String(title || '').trim();
    if (cleanTitle) return cleanTitle;
    return cleanAlt;
}

// Only generated images get a rerender control: a stored prompt or type from
// auto-gen, or a non-generic alt text (the prompt auto-gen writes as alt).
function iivIsGeneratedImage({ stored = '', storedType = '', alt = '' } = {}) {
    if (stored && String(stored).trim()) return true;
    if (storedType) return true;
    const cleanAlt = String(alt || '').trim();
    return Boolean(cleanAlt && !IIV_GENERIC_ALT_RE.test(cleanAlt));
}

// The same /sd arguments auto-gen sends, plus an optional seed.
function iivBuildRerenderArgs({ storedType = '', imgSettings = null, seedMode = 'random' } = {}) {
    const presets = imgSettings?.resolutionPresets && typeof imgSettings.resolutionPresets === 'object'
        ? imgSettings.resolutionPresets : IIV_DEFAULT_PRESETS;
    const defaultType = imgSettings?.defaultType || 'portrait';
    const type = storedType && presets[storedType] ? storedType : (presets[defaultType] ? defaultType : 'portrait');
    const dims = presets[type] || IIV_DEFAULT_PRESETS[type] || IIV_DEFAULT_PRESETS.portrait;
    const args = {
        quiet: 'true',
        processing: 'minimal',
        extend: 'false',
        width: String(dims.width),
        height: String(dims.height),
    };
    const negative = String(imgSettings?.negativePrompt || '').trim();
    if (negative) args.negative = negative;
    if (seedMode === 'random') args.seed = String(Math.floor(Math.random() * 2147483647));
    return args;
}

// True when the message an image belonged to is gone, renumbered or swapped
// while a rerender was in flight.
function iivIsStale({ imgConnected = true, liveMesId = null, mesId = null, liveMsg = null, msgRef = null } = {}) {
    if (!imgConnected) return true;
    if (String(liveMesId ?? '') !== String(mesId ?? '')) return true;
    if (msgRef && liveMsg !== msgRef) return true;
    return false;
}

if (typeof window !== 'undefined') {
    window.iivApi = {
        IIV_DEFAULTS, IIV_DEFAULT_PRESETS, IIV_PIC_TAG_RE,
        encodeMarkdownUrl: iivEncodeMarkdownUrl, normalizeUrl: iivNormalizeUrl, toRelativePath: iivToRelativePath,
        resolveSlotKey: iivResolveSlotKey, picPromptAt: iivPicPromptAt, resolvePrompt: iivResolvePrompt,
        isGeneratedImage: iivIsGeneratedImage, buildRerenderArgs: iivBuildRerenderArgs, isStale: iivIsStale,
    };
}

jQuery(async function () {
    const extensionName = IIV_SETTINGS_KEY;
    const logPrefix = `[${extensionName}]`;
    const PROCESSED_ATTR = 'data-iiv-processed';
    const LOADING_ATTR = 'data-iiv-load-listener';
    const imageNavRegistry = new WeakMap();
    const pendingContainers = new Set();
    let processTimer = null;

    // Settings live in extension_settings[IIV_SETTINGS_KEY]; defaults fill in place.
    function viewerSettings() {
        const store = getContextSafe()?.extensionSettings;
        if (!store) return { ...IIV_DEFAULTS };
        const st = store[IIV_SETTINGS_KEY] || (store[IIV_SETTINGS_KEY] = {});
        for (const [key, value] of Object.entries(IIV_DEFAULTS)) if (st[key] === undefined) st[key] = value;
        return st;
    }
    function zoomStep() {
        const v = Number(viewerSettings().zoomStep);
        return Number.isFinite(v) && v > 1 && v < 4 ? v : IIV_DEFAULTS.zoomStep;
    }
    function applyInlineMaxHeight() {
        const v = Number(viewerSettings().inlineMaxHeightVh);
        const vh = Number.isFinite(v) && v >= 10 && v <= 100 ? v : IIV_DEFAULTS.inlineMaxHeightVh;
        document.documentElement.style.setProperty('--iiv-inline-max-h', `${vh}vh`);
    }

    function debugLog(...args) {
        if (viewerSettings().debug) console.log(logPrefix, ...args);
    }

    debugLog('Initializing...');

    /**
     * Returns the current character's SD positive prompt prefix, or '' if none / in a group.
     * Mirrors how stable-diffusion/index.js resolves it via getCharaFilename(this_chid).
     */
    function getCharacterSDPrefix() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx || ctx.groupId) return '';
        const sdSettings = ctx.extensionSettings?.sd;
        if (!sdSettings?.character_prompts) return '';
        const char = ctx.characters?.[ctx.characterId];
        if (!char?.avatar) return '';
        // getCharaFilename equivalent: strip file extension from avatar filename
        const key = char.avatar.replace(/\.[^/.]+$/, '');
        return (sdSettings.character_prompts[key] || '').trim();
    }

    function getContextSafe() {
        return typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    }

    // One debounced save for variant swipes, prompt edits and link rewrites;
    // every swipe used to call the immediate saveChat.
    let saveTimer = null;
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const ctx = getContextSafe();
            const saveFn = ctx?.saveChat || ctx?.saveChatDebounced || (typeof window !== 'undefined' ? window.saveChatDebounced : null);
            if (typeof saveFn === 'function') {
                try { saveFn(); } catch (err) { console.error(logPrefix, 'saveChat failed:', err); }
            }
        }, 500);
    }
    function safeSaveChat() { scheduleSave(); }

    function emitMessageUpdated(mesId) {
        const ctx = getContextSafe();
        const types = ctx?.eventTypes || ctx?.event_types;
        const type = types?.MESSAGE_UPDATED;
        if (ctx?.eventSource && type !== undefined && mesId !== null && mesId !== undefined) {
            try { ctx.eventSource.emit(type, Number(mesId)); } catch (err) { debugLog('MESSAGE_UPDATED emit failed', err?.message); }
        }
    }

    async function copyText(text, successMessage) {
        try {
            await navigator.clipboard.writeText(text || '');
            if (typeof toastr !== 'undefined') toastr.info(successMessage, '', { timeOut: 2000 });
            return true;
        } catch (err) {
            console.error(logPrefix, 'Failed to copy text:', err);
            if (typeof toastr !== 'undefined') toastr.error('Failed to copy to clipboard.');
            return false;
        }
    }

    function confirmVariantDelete(navContext) {
        const label = navContext?.getText?.() || 'this variant';
        return window.confirm(`Delete image variant ${label} from this message?\n\nThis only removes the selected inline variant reference.`);
    }

    function encodeMarkdownUrl(url) {
        return iivEncodeMarkdownUrl(url);
    }

    function unescapeMarkdownText(text) {
        return String(text || '').replace(/\\([\\[\]()])/g, '$1');
    }

    function splitMarkdownImageDestination(raw) {
        const value = String(raw || '').trim();
        if (!value) return { url: '', title: '' };
        if (value.startsWith('<')) {
            const end = value.indexOf('>');
            if (end !== -1) {
                return { url: value.slice(1, end).trim(), title: value.slice(end + 1).trim().replace(/^["']|["']$/g, '') };
            }
        }

        let quote = '';
        let depth = 0;
        for (let i = 0; i < value.length; i++) {
            const char = value[i];
            const prev = value[i - 1];
            if ((char === '"' || char === "'") && prev !== '\\') {
                quote = quote === char ? '' : (!quote ? char : quote);
            }
            if (!quote) {
                if (char === '(' && prev !== '\\') depth++;
                if (char === ')' && prev !== '\\' && depth > 0) depth--;
                if (/\s/.test(char) && depth === 0) {
                    return {
                        url: value.slice(0, i).trim(),
                        title: value.slice(i).trim().replace(/^["']|["']$/g, ''),
                    };
                }
            }
        }
        return { url: value, title: '' };
    }

    function parseMarkdownImages(text) {
        const source = String(text || '');
        const images = [];
        let i = 0;

        while (i < source.length) {
            const start = source.indexOf('![', i);
            if (start === -1) break;
            if (start > 0 && source[start - 1] === '\\') {
                i = start + 2;
                continue;
            }

            let altEnd = -1;
            let altDepth = 0;
            let escaped = false;
            for (let j = start + 2; j < source.length; j++) {
                const char = source[j];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if (char === '[') {
                    altDepth++;
                    continue;
                }
                if (char === ']') {
                    if (altDepth > 0) {
                        altDepth--;
                    } else {
                        altEnd = j;
                        break;
                    }
                }
            }

            if (altEnd === -1 || source[altEnd + 1] !== '(') {
                i = start + 2;
                continue;
            }

            let depth = 1;
            let quote = '';
            let destEnd = -1;
            escaped = false;
            for (let j = altEnd + 2; j < source.length; j++) {
                const char = source[j];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if ((char === '"' || char === "'") && !escaped) {
                    quote = quote === char ? '' : (!quote ? char : quote);
                    continue;
                }
                if (!quote && char === '(') {
                    depth++;
                    continue;
                }
                if (!quote && char === ')') {
                    depth--;
                    if (depth === 0) {
                        destEnd = j;
                        break;
                    }
                }
            }

            if (destEnd === -1) {
                i = altEnd + 2;
                continue;
            }

            const rawAlt = source.slice(start + 2, altEnd);
            const rawDestination = source.slice(altEnd + 2, destEnd);
            const destination = splitMarkdownImageDestination(rawDestination);
            images.push({
                start,
                end: destEnd + 1,
                raw: source.slice(start, destEnd + 1),
                alt: unescapeMarkdownText(rawAlt).trim(),
                rawAlt,
                url: destination.url,
                title: destination.title,
            });
            i = destEnd + 1;
        }

        return images;
    }

    function replaceMarkdownImages(text, replacer) {
        const entries = parseMarkdownImages(text);
        if (!entries.length) return text;
        let result = '';
        let cursor = 0;
        for (const entry of entries) {
            result += text.slice(cursor, entry.start);
            result += replacer(entry);
            cursor = entry.end;
        }
        return result + text.slice(cursor);
    }

    function isExternalImageBlocked(src) {
        try {
            const parsed = new URL(src, window.location.href);
            return parsed.origin !== window.location.origin && power_user?.forbid_external_media;
        } catch {
            return false;
        }
    }

    function shouldProcessInlineImage(imgEl) {
        if (!(imgEl instanceof HTMLImageElement)) return false;
        if (imgEl.hasAttribute(PROCESSED_ATTR)) return false;
        if (imgEl.classList.contains('mes_img')) return false;
        if (imgEl.classList.contains('avatar')) return false;
        if (imgEl.classList.contains('icon-svg')) return false;
        if (imgEl.closest('.mes_media_wrapper')) return false;
        if (imgEl.closest('.iiv-inline-img-container')) return false;
        if (imgEl.closest('.mes_reasoning, pre, code, template, .template_element, .popup, .drawer-content, .inline-drawer, .extension_container')) return false;
        if (!imgEl.closest('.mes_text')) return false;
        if (!imgEl.src || imgEl.src === 'about:blank' || imgEl.src.startsWith('data:image/svg')) return false;
        if (isExternalImageBlocked(imgEl.src)) return false;
        return true;
    }

    function scheduleImageWrap(img) {
        if (!(img instanceof HTMLImageElement) || img.hasAttribute(PROCESSED_ATTR) || img.hasAttribute(LOADING_ATTR)) return;
        if (img.complete && img.naturalWidth > 0) {
            wrapInlineImage(img);
            return;
        }
        img.setAttribute(LOADING_ATTR, 'true');
        img.addEventListener('load', () => {
            img.removeAttribute(LOADING_ATTR);
            wrapInlineImage(img);
        }, { once: true });
        img.addEventListener('error', () => {
            img.removeAttribute(LOADING_ATTR);
            img.setAttribute(PROCESSED_ATTR, 'true');
            img.classList.add('iiv-inline-img-error');
        }, { once: true });
    }

    function createViewerButton(icon, title, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('iiv-viewer-btn', 'fa-solid', icon);
        button.title = title;
        button.setAttribute('aria-label', title);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick?.(event);
        });
        return button;
    }

    function createViewerPopup({ src, title = '', navContext = null, minimal = false }) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = title || '';
        img.classList.add('iiv-viewer-img');

        const mediaContainer = document.createElement('div');
        mediaContainer.classList.add('iiv-viewer');
        mediaContainer.append(img);

        let scale = 1;
        let pannedX = 0;
        let pannedY = 0;
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialPinchDistance = null;
        let initialScale = 1;
        let popup = null;
        let isClosed = false;
        let activeNavContext = navContext;
        let activeTitle = title || '';
        let titleBox = null;
        let metaPanel = null;
        let promptPanel = null;
        let actualSizeMode = false;
        let actualSizeBtn = null;
        let deleteBtn = null;
        let imageLeftBtn = null;
        let imageRightBtn = null;

        function updateTransform() {
            img.classList.toggle('iiv-viewer-img-zoomed', scale !== 1 || pannedX !== 0 || pannedY !== 0);
            actualSizeBtn?.classList.toggle('iiv-active', actualSizeMode);
            img.style.transform = `translate(${pannedX}px, ${pannedY}px) scale(${scale})`;
        }

        function resetZoom() {
            actualSizeMode = false;
            scale = 1;
            pannedX = 0;
            pannedY = 0;
            updateTransform();
        }

        function toggleActualSize() {
            if (actualSizeMode) {
                resetZoom();
                return;
            }
            const renderedWidth = img.getBoundingClientRect().width || img.clientWidth || 1;
            const nativeWidth = img.naturalWidth || renderedWidth;
            actualSizeMode = true;
            scale = Math.max(1, Math.min(nativeWidth / renderedWidth, 20));
            pannedX = 0;
            pannedY = 0;
            updateTransform();
        }

        function zoomBy(factor, originX = window.innerWidth / 2, originY = window.innerHeight / 2) {
            const xs = (originX - pannedX) / scale;
            const ys = (originY - pannedY) / scale;
            actualSizeMode = false;
            scale = Math.max(0.1, Math.min(scale * factor, 20));
            pannedX = originX - xs * scale;
            pannedY = originY - ys * scale;
            updateTransform();
        }

        function setImageSrc(newSrc, newTitle = null, newNavContext = null) {
            if (!newSrc) return;
            if (newNavContext) activeNavContext = newNavContext;
            if (newTitle !== null) {
                activeTitle = newTitle || '';
                img.alt = activeTitle;
                if (!titleBox && activeTitle) {
                    titleBox = document.createElement('div');
                    titleBox.classList.add('iiv-viewer-title', 'txt');
                    mediaContainer.append(titleBox);
                }
                if (titleBox) {
                    titleBox.textContent = activeTitle;
                    titleBox.hidden = !activeTitle;
                }
            }
            img.src = newSrc;
            resetZoom();
            updateNavUI();
            updateMetaPanel();
        }

        function cleanupPopupListeners() {
            window.removeEventListener('mousemove', onPointerMove);
            window.removeEventListener('mouseup', onPointerUp);
            window.removeEventListener('touchmove', onPointerMove);
            window.removeEventListener('touchend', onPointerUp);
            window.removeEventListener('keydown', onKeyDown, true);
        }

        function closePopup() {
            if (isClosed) return;
            isClosed = true;
            cleanupPopupListeners();
            popup?.completeCancelled();
        }

        // Drag/pinch bookkeeping. A press that starts on the toolbar, a panel
        // or the title is left to those controls (taps on touch screens were
        // swallowed by preventDefault); a background click only closes the
        // viewer when the pointer did not travel (DRAG_CLOSE_PX).
        const DRAG_CLOSE_PX = 6;
        let dragStartClientX = 0;
        let dragStartClientY = 0;
        let dragDistance = 0;
        const isControlTarget = (target) => target instanceof Element && Boolean(target.closest('.iiv-viewer-toolbar, .iiv-viewer-panel, .iiv-viewer-title'));

        const onPointerDown = (e) => {
            if (isControlTarget(e.target)) return;
            if (e.touches && e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initialPinchDistance = Math.hypot(dx, dy);
                initialScale = scale;
                e.preventDefault();
                return;
            }
            isDragging = true;
            img.classList.add('iiv-viewer-img-dragging');
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            startX = clientX - pannedX;
            startY = clientY - pannedY;
            dragStartClientX = clientX;
            dragStartClientY = clientY;
            dragDistance = 0;
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            if (e.touches && e.touches.length === 2 && initialPinchDistance !== null) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                // Same limits as the wheel and buttons, zoomed around the pinch midpoint.
                const target = Math.max(0.1, Math.min(initialScale * (dist / initialPinchDistance), 20));
                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                if (scale > 0) zoomBy(target / scale, midX, midY);
                e.preventDefault();
                return;
            }
            if (!isDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            dragDistance = Math.max(dragDistance, Math.hypot(clientX - dragStartClientX, clientY - dragStartClientY));
            pannedX = clientX - startX;
            pannedY = clientY - startY;
            updateTransform();
        };

        const onPointerUp = () => {
            isDragging = false;
            initialPinchDistance = null;
            img.classList.remove('iiv-viewer-img-dragging');
        };

        const onWheel = (e) => {
            e.preventDefault();
            const delta = (e.deltaY || -e.wheelDelta || e.detail) > 0 ? -1 : 1;
            const step = zoomStep();
            zoomBy(delta > 0 ? step : 1 / step, e.clientX, e.clientY);
        };

        mediaContainer.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        
        mediaContainer.addEventListener('touchstart', onPointerDown, { passive: false });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);

        mediaContainer.addEventListener('wheel', onWheel, { passive: false });
        img.addEventListener('load', updateMetaPanel);

        const toolbar = document.createElement('div');
        toolbar.classList.add('iiv-viewer-toolbar');

        let leftBtn = null;
        let rightBtn = null;
        let counterEl = null;

        function updateMetaPanel() {
            if (!metaPanel) return;
            const prompt = activeNavContext?.getPrompt?.() || '';
            const lines = [];
            if (img.naturalWidth && img.naturalHeight) lines.push(`Size: ${img.naturalWidth} x ${img.naturalHeight}`);
            if (activeNavContext?.getText) lines.push(`Variant: ${activeNavContext.getText()}`);
            if (activeNavContext?.getImageText) lines.push(`Image: ${activeNavContext.getImageText()}`);
            if (activeTitle) lines.push(`Title: ${activeTitle}`);
            if (prompt) lines.push(`Prompt: ${prompt}`);
            lines.push(`URL: ${img.currentSrc || img.src}`);
            metaPanel.textContent = lines.join('\n');
        }

        function togglePanel(panel) {
            if (!panel) return;
            const shouldShow = panel.hidden;
            if (metaPanel && metaPanel !== panel) metaPanel.hidden = true;
            if (promptPanel && promptPanel !== panel) promptPanel.hidden = true;
            panel.hidden = !shouldShow;
            if (shouldShow && panel === metaPanel) updateMetaPanel();
        }

        const updateNavUI = () => {
            if (activeNavContext && leftBtn && rightBtn && counterEl) {
                counterEl.textContent = activeNavContext.getText();
                leftBtn.disabled = !activeNavContext.canSwipeLeft();
                rightBtn.disabled = !activeNavContext.canSwipeRight();
                rightBtn.className = `iiv-viewer-btn fa-solid ${activeNavContext.isRightRerender() ? 'fa-rotate-right' : 'fa-chevron-right'}`;
                rightBtn.title = activeNavContext.isRightRerender() ? 'Rerender variant' : 'Next variant';
                rightBtn.setAttribute('aria-label', rightBtn.title);
            }
            if (deleteBtn && activeNavContext?.canDeleteCurrentVariant) {
                deleteBtn.disabled = !activeNavContext.canDeleteCurrentVariant();
            }
            if (imageLeftBtn && activeNavContext?.canMessageImageLeft) {
                imageLeftBtn.disabled = !activeNavContext.canMessageImageLeft();
            }
            if (imageRightBtn && activeNavContext?.canMessageImageRight) {
                imageRightBtn.disabled = !activeNavContext.canMessageImageRight();
            }
            updateMetaPanel();
        };

        if (!minimal && activeNavContext) {
            imageLeftBtn = createViewerButton('fa-backward-step', 'Previous image in message', async () => {
                const state = await activeNavContext.onMessageImageLeft?.();
                if (state) setImageSrc(state.src, state.title, state.navContext);
            });

            leftBtn = createViewerButton('fa-chevron-left', 'Previous variant', async () => {
                setImageSrc(await activeNavContext.onSwipeLeft());
            });

            counterEl = document.createElement('div');
            counterEl.classList.add('iiv-viewer-counter');

            rightBtn = createViewerButton('fa-chevron-right', 'Next variant', async () => {
                rightBtn.classList.add('iiv-loading');
                try {
                    setImageSrc(await activeNavContext.onSwipeRight());
                } finally {
                    rightBtn.classList.remove('iiv-loading');
                }
            });

            imageRightBtn = createViewerButton('fa-forward-step', 'Next image in message', async () => {
                const state = await activeNavContext.onMessageImageRight?.();
                if (state) setImageSrc(state.src, state.title, state.navContext);
            });

            toolbar.append(imageLeftBtn, leftBtn, counterEl, rightBtn, imageRightBtn);
        }

        if (!minimal) {
            actualSizeBtn = createViewerButton('fa-up-right-and-down-left-from-center', 'Toggle actual size / fit', toggleActualSize);
            const infoBtn = createViewerButton('fa-circle-info', 'Show image details', () => togglePanel(metaPanel));
            const promptCopyBtn = createViewerButton('fa-clipboard', 'Copy image prompt', async () => {
                const prompt = activeNavContext?.getPrompt?.() || activeTitle || '';
                if (!prompt.trim()) {
                    if (typeof toastr !== 'undefined') toastr.warning('No prompt found for this image.', 'Inline Image Viewer');
                    return;
                }
                await copyText(prompt, 'Image prompt copied!');
            });
            const promptEditBtn = createViewerButton('fa-pen-to-square', 'Edit prompt and rerender', () => {
                if (!activeNavContext?.onRerenderWithPrompt) {
                    if (typeof toastr !== 'undefined') toastr.warning('Rerender is not available for this image.', 'Inline Image Viewer');
                    return;
                }
                togglePanel(promptPanel);
                const textarea = promptPanel?.querySelector('textarea');
                if (textarea) {
                    textarea.value = activeNavContext.getPrompt?.() || activeTitle || '';
                    textarea.focus();
                }
            });
            deleteBtn = createViewerButton('fa-trash-can', 'Delete current variant', async () => {
                if (!confirmVariantDelete(activeNavContext)) return;
                const state = await activeNavContext?.deleteCurrentVariant?.();
                if (state) setImageSrc(state.src, state.title, state.navContext);
            });

            toolbar.append(
                createViewerButton('fa-magnifying-glass-minus', 'Zoom out', () => zoomBy(1 / zoomStep())),
                createViewerButton('fa-rotate-left', 'Reset zoom', resetZoom),
                actualSizeBtn,
                createViewerButton('fa-magnifying-glass-plus', 'Zoom in', () => zoomBy(zoomStep())),
                createViewerButton('fa-up-right-from-square', 'Open in new tab', () => window.open(img.src, '_blank')),
                createViewerButton('fa-copy', 'Copy image URL', async () => copyText(img.src, 'Image URL copied!')),
                promptCopyBtn,
                promptEditBtn,
                deleteBtn,
                infoBtn,
                createViewerButton('fa-download', 'Download image', () => downloadImage(img.src)),
                createViewerButton('fa-xmark', 'Close', closePopup),
            );
        }

        if (!minimal && title && title.trim().length > 0) {
            titleBox = document.createElement('div');
            titleBox.classList.add('iiv-viewer-title', 'txt');
            titleBox.textContent = title;
            mediaContainer.append(titleBox);
        }

        if (!minimal) {
            metaPanel = document.createElement('pre');
            metaPanel.classList.add('iiv-viewer-panel', 'iiv-viewer-meta');
            metaPanel.hidden = true;
            mediaContainer.append(metaPanel);

            promptPanel = document.createElement('div');
            promptPanel.classList.add('iiv-viewer-panel', 'iiv-viewer-prompt');
            promptPanel.hidden = true;
            const promptTextarea = document.createElement('textarea');
            promptTextarea.rows = 5;
            promptTextarea.placeholder = 'Image prompt';
            const promptActions = document.createElement('div');
            promptActions.classList.add('iiv-viewer-panel-actions');
            const promptGenerateBtn = document.createElement('button');
            promptGenerateBtn.type = 'button';
            promptGenerateBtn.classList.add('menu_button');
            promptGenerateBtn.textContent = 'Rerender';
            promptGenerateBtn.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                promptGenerateBtn.disabled = true;
                promptGenerateBtn.classList.add('iiv-loading');
                try {
                    const state = await activeNavContext?.onRerenderWithPrompt?.(promptTextarea.value);
                    if (state) {
                        setImageSrc(state.src, state.title, state.navContext);
                        promptPanel.hidden = true;
                    }
                } finally {
                    promptGenerateBtn.disabled = false;
                    promptGenerateBtn.classList.remove('iiv-loading');
                }
            });
            const promptCancelBtn = document.createElement('button');
            promptCancelBtn.type = 'button';
            promptCancelBtn.classList.add('menu_button');
            promptCancelBtn.textContent = 'Cancel';
            promptCancelBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                promptPanel.hidden = true;
            });
            promptActions.append(promptGenerateBtn, promptCancelBtn);
            promptPanel.append(promptTextarea, promptActions);
            mediaContainer.append(promptPanel);
        }

        if (!minimal) mediaContainer.append(toolbar);

        popup = new Popup(mediaContainer, POPUP_TYPE.DISPLAY, '', {
            large: true,
            transparent: true,
        });

        popup.dlg.classList.add('iiv-viewer-popup');
        const originalCompleteCancelled = popup.completeCancelled?.bind(popup);
        if (originalCompleteCancelled) {
            popup.completeCancelled = (...args) => {
                cleanupPopupListeners();
                return originalCompleteCancelled(...args);
            };
        }

        const onKeyDown = async (e) => {
            if (e.defaultPrevented) return;

            const target = e.target;
            const isEditing = target instanceof Element && (
                target.matches('input, textarea, select') ||
                target.isContentEditable ||
                target.closest('[contenteditable="true"]')
            );
            if (isEditing) return;
            // Leave browser shortcuts alone (Ctrl+Plus zoom, Ctrl+0, Cmd+I ...);
            // Alt is only a modifier for the Alt+Arrow image navigation below.
            if (e.ctrlKey || e.metaKey) return;
            if (e.altKey && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

            if (e.key === 'Escape') {
                e.preventDefault();
                closePopup();
            } else if (e.key === '0') {
                e.preventDefault();
                resetZoom();
            } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                zoomBy(zoomStep());
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                zoomBy(1 / zoomStep());
            } else if (!minimal && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                togglePanel(metaPanel);
            } else if (activeNavContext && e.key === 'ArrowLeft' && e.shiftKey) {
                e.preventDefault();
                setImageSrc(await activeNavContext.onSwipeFirst?.());
            } else if (activeNavContext && e.key === 'ArrowRight' && e.shiftKey) {
                e.preventDefault();
                setImageSrc(await activeNavContext.onSwipeLast?.());
            } else if (activeNavContext && e.key === 'ArrowLeft' && e.altKey) {
                e.preventDefault();
                const state = await activeNavContext.onMessageImageLeft?.();
                if (state) setImageSrc(state.src, state.title, state.navContext);
            } else if (activeNavContext && e.key === 'ArrowRight' && e.altKey) {
                e.preventDefault();
                const state = await activeNavContext.onMessageImageRight?.();
                if (state) setImageSrc(state.src, state.title, state.navContext);
            } else if (activeNavContext && e.key === 'ArrowLeft') {
                e.preventDefault();
                setImageSrc(await activeNavContext.onSwipeLeft());
            } else if (activeNavContext && e.key === 'ArrowRight') {
                e.preventDefault();
                setImageSrc(await activeNavContext.onSwipeRight());
            }
        };

        window.addEventListener('keydown', onKeyDown, true);

        let lastClick = 0;
        mediaContainer.addEventListener('click', (e) => {
            // A pan that ends on the background is not a click to close.
            if (dragDistance > DRAG_CLOSE_PX) { dragDistance = 0; return; }
            if (e.target !== img && !isControlTarget(e.target)) {
                closePopup();
            } else {
                const now = Date.now();
                if (now - lastClick < 300) {
                    resetZoom();
                }
                lastClick = now;
            }
        });

        updateNavUI();
        popup.show();
    }

    /**
     * Opens an adaptive pan/zoom image popup.
     * @param {string} src - Image source URL
     * @param {string} title - Optional title/alt text
     */
    function openImagePopup(src, title, navContext = null, options = {}) {
        createViewerPopup({ src, title, navContext, minimal: Boolean(options.minimal) });
    }

    function downloadImage(src) {
        const a = document.createElement('a');
        a.href = src;
        const urlParts = String(src || '').split('/');
        a.download = decodeURIComponent(urlParts[urlParts.length - 1] || 'image');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /**
     * Creates the control overlay for an inline image.
     * @param {HTMLImageElement} imgEl - The inline image element
     * @returns {HTMLDivElement} The controls overlay div
     */
    function createControls(imgEl, navContext) {
        const controls = document.createElement('div');
        controls.classList.add('iiv-inline-img-controls');

        const title = imgEl.alt || imgEl.title || '';

        // --- Left Arrow ---
        const leftBtn = document.createElement('div');
        leftBtn.title = 'Previous Variant';
        leftBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-chevron-left');
        leftBtn.tabIndex = 0;
        leftBtn.addEventListener('click', async (e) => {
            e.stopPropagation(); e.preventDefault();
            const newSrc = await navContext.onSwipeLeft();
            if (newSrc) updateControlsState();
        });

        const counterText = document.createElement('div');
        counterText.classList.add('iiv-inline-img-counter');

        // --- Right Arrow ---
        const rightBtn = document.createElement('div');
        rightBtn.title = 'Next Variant / Generate New';
        rightBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-chevron-right');
        rightBtn.tabIndex = 0;
        rightBtn.addEventListener('click', async (e) => {
            e.stopPropagation(); e.preventDefault();
            const oldOp = rightBtn.style.opacity;
            rightBtn.style.opacity = '0.5';
            rightBtn.classList.add('iiv-loading');
            try {
                const newSrc = await navContext.onSwipeRight();
                if (newSrc) updateControlsState();
            } finally {
                rightBtn.style.opacity = oldOp;
                rightBtn.classList.remove('iiv-loading');
            }
        });

        function updateControlsState() {
            counterText.textContent = navContext.getText();
            leftBtn.style.display = navContext.canSwipeLeft() ? 'inline-block' : 'none';
            rightBtn.className = 'right_menu_button fa-lg fa-solid ' + (navContext.isRightRerender() ? 'fa-rotate-right' : 'fa-chevron-right');
            rightBtn.title = navContext.isRightRerender() ? 'Rerender variant' : 'Next Variant';
            if (deleteBtn) deleteBtn.style.display = navContext.canDeleteCurrentVariant?.() ? 'inline-block' : 'none';
            
            if (!navContext.canSwipeLeft() && !navContext.canSwipeRight()) {
                leftBtn.style.display = 'none';
                rightBtn.style.display = 'none';
                counterText.style.display = 'none';
            } else {
                counterText.style.display = 'inline-block';
                rightBtn.style.display = 'inline-block';
            }
        }

        // --- Expand / Zoom Button ---
        const expandBtn = document.createElement('div');
        expandBtn.title = 'Expand and zoom';
        expandBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-magnifying-glass');
        expandBtn.tabIndex = 0;
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const src = imgEl.src;
            openImagePopup(src, imgEl.alt || imgEl.title || title, navContext);
        });

        // --- Open in New Tab Button ---
        const newTabBtn = document.createElement('div');
        newTabBtn.title = 'Open in new tab';
        newTabBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-up-right-from-square');
        newTabBtn.tabIndex = 0;
        newTabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            window.open(imgEl.src, '_blank');
        });

        // --- Copy Prompt Button ---
        const promptBtn = document.createElement('div');
        promptBtn.title = 'Copy image prompt';
        promptBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-clipboard');
        promptBtn.tabIndex = 0;
        promptBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            const prompt = navContext.getPrompt?.() || title || '';
            if (!prompt.trim()) {
                if (typeof toastr !== 'undefined') toastr.warning('No prompt found for this inline image.', 'Inline Image Viewer');
                return;
            }
            await copyText(prompt, 'Image prompt copied!');
        });

        // --- Copy URL Button ---
        const copyBtn = document.createElement('div');
        copyBtn.title = 'Copy image URL';
        copyBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-copy');
        copyBtn.tabIndex = 0;
        copyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await copyText(imgEl.src, 'Image URL copied!');
        });

        // --- Delete Current Variant Button ---
        const deleteBtn = document.createElement('div');
        deleteBtn.title = 'Delete current variant';
        deleteBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-trash-can');
        deleteBtn.tabIndex = 0;
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (!confirmVariantDelete(navContext)) return;
            const state = await navContext.deleteCurrentVariant?.();
            if (state) updateControlsState();
        });

        // --- Download Button ---
        const downloadBtn = document.createElement('div');
        downloadBtn.title = 'Download image';
        downloadBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-download');
        downloadBtn.tabIndex = 0;
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            downloadImage(imgEl.src);
        });

        controls.append(leftBtn, counterText, rightBtn, expandBtn, newTabBtn, promptBtn, copyBtn, deleteBtn, downloadBtn);
        updateControlsState();
        return controls;
    }

    /**
     * Wraps an inline image with a container and injects controls.
     * @param {HTMLImageElement} imgEl - The inline <img> element
     */
    function wrapInlineImage(imgEl) {
        // Skip if already processed or if it's a SillyTavern system image
        if (!shouldProcessInlineImage(imgEl)) return;

        imgEl.setAttribute(PROCESSED_ATTR, 'true');
        imgEl.removeAttribute(LOADING_ATTR);

        // Create wrapper
        const wrapper = document.createElement('span');
        wrapper.classList.add('iiv-inline-img-container');

        // Insert wrapper before img, then move img inside
        imgEl.parentNode.insertBefore(wrapper, imgEl);
        wrapper.appendChild(imgEl);

        const mesEl = imgEl.closest('.mes');
        const mesId = mesEl ? mesEl.getAttribute('mesid') : null;
        const altText = imgEl.alt || imgEl.title || '';
        let currentSrcKey = 'inline_img_0';

        // Compute image index among siblings — hoisted so getRegenerationPrompt() can use it
        const siblingImages = Array.from((mesEl || document).querySelectorAll('.mes_text img:not(.mes_img):not(.avatar):not(.icon-svg)'));
        const imageIndex = Math.max(0, siblingImages.indexOf(imgEl));

        const ctx = getContextSafe();
        const stChat = ctx ? ctx.chat : null;

        // Shared URL helpers (module level); kept under their old local names.
        const toRelativePath = iivToRelativePath;
        const normalizeUrlForCompare = iivNormalizeUrl;

        // Always store relative paths to avoid cross-origin issues
        let imageStack = [toRelativePath(imgEl.src)];
        let currentIndex = 0;
        let rerenderInFlight = false;

        /**
         * Find index in imageStack that matches the given src, using normalized comparison.
         */
        function findNormalizedIndex(stack, src) {
            const normSrc = normalizeUrlForCompare(src);
            return stack.findIndex(entry => normalizeUrlForCompare(entry) === normSrc);
        }

        /**
         * Deduplicate imageStack by normalized URL, keeping the first occurrence.
         * Also converts all entries to relative paths.
         */
        function deduplicateStack(stack) {
            const seen = new Set();
            const result = [];
            for (const entry of stack) {
                const rel = toRelativePath(entry);
                const norm = normalizeUrlForCompare(rel);
                if (!seen.has(norm)) {
                    seen.add(norm);
                    result.push(rel);
                }
            }
            return result;
        }

        if (mesId && stChat && stChat[mesId]) {
            const msg = stChat[mesId];
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.inlineImageVariants) msg.extra.inlineImageVariants = {};
            if (!msg.extra.inlineImagePrompts) msg.extra.inlineImagePrompts = {};

            // The variant stack that already holds this URL wins; a new image
            // takes its DOM-position key (the key auto-gen writes prompts to).
            currentSrcKey = iivResolveSlotKey(msg.extra.inlineImageVariants, imgEl.src, imageIndex);

            if (Array.isArray(msg.extra.inlineImageVariants[currentSrcKey])) {
                // Load persisted stack, convert to relative paths, and deduplicate
                imageStack = deduplicateStack(msg.extra.inlineImageVariants[currentSrcKey]);
                msg.extra.inlineImageVariants[currentSrcKey] = imageStack;
            } else {
                msg.extra.inlineImageVariants[currentSrcKey] = imageStack;
            }
            
            // Use normalized URL comparison to find the current image in the stack
            let matchIndex = findNormalizedIndex(imageStack, imgEl.src);
            currentIndex = Math.max(0, matchIndex);

            if (matchIndex === -1) {
                // Only add if it's genuinely a new URL (not a format variant of an existing one)
                imageStack.push(toRelativePath(imgEl.src));
                currentIndex = imageStack.length - 1;
                msg.extra.inlineImageVariants[currentSrcKey] = imageStack;
            }

            // --- EAGER PROMPT EXTRACTION ---
            // If we don't already have a stored prompt for this image slot, parse msg.mes NOW
            // to find the ![alt](url) entry that belongs to THIS specific image (by URL match
            // first, positional index fallback). This guarantees getRegenerationPrompt()
            // always returns the correct per-image prompt even on the very first rerender click,
            // without ever falling through to the message-scoped msg.extra.title.
            if (!msg.extra.inlineImagePrompts[currentSrcKey]) {
                const mdEntries = parseMarkdownImages(msg.mes);

                // 1. Try URL match: find the entry whose url normalizes to this image's src
                const normThisSrc = normalizeUrlForCompare(imgEl.src);
                let foundEntry = mdEntries.find(e => normalizeUrlForCompare(e.url) === normThisSrc);

                // 2. Positional fallback: use imageIndex if URL match failed
                if (!foundEntry && imageIndex < mdEntries.length) {
                    foundEntry = mdEntries[imageIndex];
                }

                if (foundEntry && foundEntry.alt && !IIV_GENERIC_ALT_RE.test(foundEntry.alt)) {
                    msg.extra.inlineImagePrompts[currentSrcKey] = foundEntry.alt;
                }
            }
        }
        
        function updateSourceMessage(oldSrc, newSrc) {
            const currentMesEl = imgEl.closest('.mes');
            const dynamicMesId = currentMesEl ? currentMesEl.getAttribute('mesid') : mesId;
            if (!dynamicMesId || !stChat || !stChat[dynamicMesId]) return;
            const msg = stChat[dynamicMesId];

            const relNewSrc = toRelativePath(newSrc);
            const normOld = normalizeUrlForCompare(oldSrc);

            // Find all ![alt](url) in msg.mes and replace the one matching oldSrc
            let replaced = false;
            msg.mes = replaceMarkdownImages(msg.mes, (entry) => {
                if (replaced) return entry.raw; // Only replace first match
                if (normalizeUrlForCompare(entry.url) === normOld) {
                    replaced = true;
                    const titleSuffix = entry.title ? ` "${entry.title.replace(/"/g, '\\"')}"` : '';
                    return `![${entry.rawAlt}](${relNewSrc}${titleSuffix})`;
                }
                return entry.raw;
            });

            if (replaced) {
                // Keep the current swipe in step with mes, tell ST, and save (debounced).
                if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipes[msg.swipe_id] !== undefined) {
                    msg.swipes[msg.swipe_id] = msg.mes;
                }
                emitMessageUpdated(dynamicMesId);
                scheduleSave();
            }
        }


        // The message this image belongs to right now (ST renumbers mesid on deletes).
        function liveMessage() {
            const currentMesEl = imgEl.closest('.mes');
            const dynamicMesId = currentMesEl ? currentMesEl.getAttribute('mesid') : mesId;
            const msg = dynamicMesId !== null && stChat ? stChat[dynamicMesId] : null;
            return { mesId: dynamicMesId, msg };
        }

        // Recover the SD prompt for regeneration (read-only; the eager block
        // above is the only place that persists an alt text).
        // Priority: (1) persisted per-image prompt, (2) non-generic alt text, (3) N-th <pic> tag, (4) msg.extra.title
        function getRegenerationPrompt() {
            const { msg } = liveMessage();
            return iivResolvePrompt({
                stored: msg?.extra?.inlineImagePrompts?.[currentSrcKey] || '',
                alt: imgEl.alt || imgEl.title || '',
                mes: msg?.mes || '',
                index: imageIndex,
                title: typeof msg?.extra?.title === 'string' ? msg.extra.title : '',
            });
        }

        function isGeneratedImage() {
            const { msg } = liveMessage();
            return iivIsGeneratedImage({
                stored: msg?.extra?.inlineImagePrompts?.[currentSrcKey] || '',
                storedType: msg?.extra?.inlineImageTypes?.[currentSrcKey] || '',
                alt: imgEl.alt || imgEl.title || '',
            });
        }

        function getMessageImageContexts() {
            const currentMesEl = imgEl.closest('.mes');
            const images = Array.from((currentMesEl || document).querySelectorAll('.iiv-inline-img-container > img'))
                .filter(image => image instanceof HTMLImageElement && imageNavRegistry.has(image));
            return images.map(image => imageNavRegistry.get(image)).filter(Boolean);
        }

        function persistVariantState(msg = liveMessage().msg) {
            if (!msg) return;
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.inlineImageVariants) msg.extra.inlineImageVariants = {};
            msg.extra.inlineImageVariants[currentSrcKey] = imageStack;
            scheduleSave();
        }

        function persistPrompt(prompt, msg = liveMessage().msg) {
            if (!msg) return;
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.inlineImagePrompts) msg.extra.inlineImagePrompts = {};
            msg.extra.inlineImagePrompts[currentSrcKey] = prompt;
            scheduleSave();
        }

        // Rerender through the same pipeline auto-gen uses for a fresh picture:
        // VIR look lock (stored identity rows) -> auto-gen's effective-prompt
        // builder (cleaner, LoRA triggers, people count, character SD prefix,
        // Krea2 closer) -> /sd with the same arguments. Falls back to the plain
        // prefix path when auto-gen is not installed.
        async function rerenderInlineImage(promptOverride = null) {
            if (rerenderInFlight) {
                if (typeof toastr !== 'undefined') toastr.info('A rerender is already running for this image.', 'Inline Image Viewer');
                return null;
            }
            const promptToUse = String(promptOverride ?? getRegenerationPrompt() ?? '').trim();
            if (!promptToUse) {
                if (typeof toastr !== 'undefined') toastr.warning('No image prompt found for this inline image.', 'Inline Image Viewer');
                return null;
            }
            const sdCmd = SlashCommandParser.commands['sd'] || SlashCommandParser.commands['imagine'];
            if (!sdCmd || typeof sdCmd.callback !== 'function') {
                if (typeof toastr !== 'undefined') toastr.warning('Stable Diffusion slash command is not available.', 'Inline Image Viewer');
                return null;
            }
            rerenderInFlight = true;
            if (typeof toastr !== 'undefined') toastr.info('Rerendering inline image...', 'Stable Diffusion');
            try {
                const start = liveMessage();
                const msgRef = start.msg;
                const startMesId = start.mesId;
                const imgSettings = getContextSafe()?.extensionSettings?.['st-image-auto-generation'] || null;
                const storedType = msgRef?.extra?.inlineImageTypes?.[currentSrcKey] || '';
                const args = iivBuildRerenderArgs({ storedType, imgSettings, seedMode: viewerSettings().seedMode });

                let prompt = promptToUse;
                const lock = window.stImageAutoGenLockLookSentences;
                const copiesFn = window.ff4VirGetPicCopies;
                if (typeof lock === 'function' && typeof copiesFn === 'function') {
                    try { prompt = lock(prompt, await copiesFn()); } catch (err) { debugLog('look lock skipped:', err?.message); }
                }
                const build = window.stImageAutoGenBuildEffectivePrompt;
                let effectivePrompt;
                if (typeof build === 'function') {
                    effectivePrompt = build(prompt);
                } else {
                    const charPrefix = getCharacterSDPrefix();
                    effectivePrompt = charPrefix ? `${charPrefix}, ${prompt}` : prompt;
                }
                debugLog('rerender args', args, 'prompt', effectivePrompt);

                const newUrlRaw = await sdCmd.callback(args, effectivePrompt);
                if (!newUrlRaw) {
                    if (typeof toastr !== 'undefined') toastr.error('Stable Diffusion did not return an image URL (check the ComfyUI/SD log).', 'Inline Image Viewer');
                    return null;
                }

                // The chat may have changed while SD was rendering: a deleted or
                // swiped message, a renumbered mesid, or a chat switch.
                const live = liveMessage();
                const stale = iivIsStale({
                    imgConnected: imgEl.isConnected,
                    liveMesId: live.mesId,
                    mesId: startMesId,
                    liveMsg: live.msg,
                    msgRef,
                });
                if (stale) {
                    if (typeof toastr !== 'undefined') toastr.warning('The message changed while the image was rendering; the new image was not inserted.', 'Inline Image Viewer');
                    return null;
                }

                const newUrl = toRelativePath(newUrlRaw);
                const oldSrcMD = imageStack[currentIndex];
                imageStack.push(newUrl);
                currentIndex = imageStack.length - 1;
                persistVariantState(msgRef);
                persistPrompt(promptToUse, msgRef);
                imgEl.src = newUrl;
                updateSourceMessage(oldSrcMD, newUrl);
                if (typeof toastr !== 'undefined') toastr.success('Inline image rerendered.', 'Stable Diffusion');
                return { src: imgEl.src, title: imgEl.alt || imgEl.title || '', navContext };
            } catch (err) {
                console.error(logPrefix, 'Rerender error:', err);
                if (typeof toastr !== 'undefined') toastr.error(`Failed to rerender image: ${err?.message || err}`, 'Inline Image Viewer');
                return null;
            } finally {
                rerenderInFlight = false;
            }
        }

        const navContext = {
            getText: () => `${currentIndex + 1}/${imageStack.length}`,
            getImageText: () => `${imageIndex + 1}/${getMessageImageContexts().length || 1}`,
            getPrompt: getRegenerationPrompt,
            getState: () => ({ src: imgEl.src, title: imgEl.alt || imgEl.title || '', navContext }),
            canSwipeLeft: () => currentIndex > 0,
            canSwipeRight: () => currentIndex < imageStack.length - 1 || (isGeneratedImage() && !rerenderInFlight),
            isRightRerender: () => currentIndex >= imageStack.length - 1,
            canDeleteCurrentVariant: () => imageStack.length > 1,
            canMessageImageLeft: () => {
                const contexts = getMessageImageContexts();
                return contexts.indexOf(navContext) > 0;
            },
            canMessageImageRight: () => {
                const contexts = getMessageImageContexts();
                const index = contexts.indexOf(navContext);
                return index !== -1 && index < contexts.length - 1;
            },
            onMessageImageLeft: async () => {
                const contexts = getMessageImageContexts();
                const index = contexts.indexOf(navContext);
                return index > 0 ? contexts[index - 1].getState() : null;
            },
            onMessageImageRight: async () => {
                const contexts = getMessageImageContexts();
                const index = contexts.indexOf(navContext);
                return index !== -1 && index < contexts.length - 1 ? contexts[index + 1].getState() : null;
            },
            onSwipeFirst: async () => {
                if (currentIndex <= 0) return null;
                const oldSrcMD = imageStack[currentIndex];
                currentIndex = 0;
                imgEl.src = imageStack[currentIndex];
                updateSourceMessage(oldSrcMD, imageStack[currentIndex]);
                return imgEl.src;
            },
            onSwipeLast: async () => {
                if (currentIndex >= imageStack.length - 1) return null;
                const oldSrcMD = imageStack[currentIndex];
                currentIndex = imageStack.length - 1;
                imgEl.src = imageStack[currentIndex];
                updateSourceMessage(oldSrcMD, imageStack[currentIndex]);
                return imgEl.src;
            },
            onSwipeLeft: async () => {
                if (currentIndex > 0) {
                    const oldSrcMD = imageStack[currentIndex];
                    currentIndex--;
                    imgEl.src = imageStack[currentIndex];
                    updateSourceMessage(oldSrcMD, imageStack[currentIndex]);
                    return imgEl.src;
                }
                return null;
            },
            onSwipeRight: async () => {
                if (currentIndex < imageStack.length - 1) {
                    const oldSrcMD = imageStack[currentIndex];
                    currentIndex++;
                    imgEl.src = imageStack[currentIndex];
                    updateSourceMessage(oldSrcMD, imageStack[currentIndex]);
                    return imgEl.src;
                }
                if (!isGeneratedImage() || rerenderInFlight) return null;
                const state = await rerenderInlineImage();
                return state?.src || null;
            },
            onRerenderWithPrompt: rerenderInlineImage,
            deleteCurrentVariant: async () => {
                if (imageStack.length <= 1) return null;
                const oldSrcMD = imageStack[currentIndex];
                imageStack.splice(currentIndex, 1);
                currentIndex = Math.min(currentIndex, imageStack.length - 1);
                persistVariantState();
                imgEl.src = imageStack[currentIndex];
                updateSourceMessage(oldSrcMD, imageStack[currentIndex]);
                return { src: imgEl.src, title: imgEl.alt || imgEl.title || '', navContext };
            },
        };
        imageNavRegistry.set(imgEl, navContext);

        // Add controls overlay
        const controls = createControls(imgEl, navContext);
        wrapper.appendChild(controls);

        // Click on the image itself opens the zoom popup
        imgEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            openImagePopup(imgEl.src, imgEl.alt || imgEl.title || altText, navContext);
        });
    }

    /**
     * Injects a native rerender button into attached media controls.
     * @param {Element} controlsNode The `.mes_img_controls` node
     */
    function processMediaControls(controlsNode) {
        if (controlsNode.hasAttribute(PROCESSED_ATTR) || controlsNode.querySelector('.mes_media_rerender')) return;
        controlsNode.setAttribute(PROCESSED_ATTR, 'true');

        const rerenderBtn = document.createElement('div');
        rerenderBtn.classList.add('right_menu_button', 'fa-lg', 'fa-solid', 'fa-rotate-right', 'mes_media_rerender');
        rerenderBtn.title = 'Rerender current image (SD)';
        
        const deleteBtn = controlsNode.querySelector('.mes_media_delete');
        if (deleteBtn) {
            controlsNode.insertBefore(rerenderBtn, deleteBtn);
        } else {
            controlsNode.appendChild(rerenderBtn);
        }
    }

    /**
     * Scans a container element for inline images and wraps them.
     * @param {HTMLElement} container - Element to scan
     */
    function processContainer(container) {
        const images = container.querySelectorAll(`.mes_text img:not([${PROCESSED_ATTR}]):not(.mes_img)`);
        images.forEach(img => {
            scheduleImageWrap(img);
        });

        // Also process any attached image controls we find
        const imgControls = container.querySelectorAll('.mes_img_controls');
        imgControls.forEach(processMediaControls);
    }

    function queueProcessContainer(container) {
        if (!(container instanceof Element)) return;
        pendingContainers.add(container);
        clearTimeout(processTimer);
        processTimer = setTimeout(() => {
            const containers = Array.from(pendingContainers);
            pendingContainers.clear();
            for (const item of containers) {
                if (item.isConnected) processContainer(item);
            }
        }, 75);
    }

    /**
     * Full scan of all messages in the chat.
     */
    function processAllMessages() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return;
        processContainer(chatEl);
    }

    // --- MutationObserver to catch new messages and dynamic content ---
    function setupObserver() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) {
            // Retry after a short delay if chat element isn't ready
            setTimeout(setupObserver, 500);
            return;
        }

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                // Handle added nodes
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    // If the added node is a message or contains messages
                    if (node.classList?.contains('mes') || node.querySelector?.('.mes')) {
                        queueProcessContainer(node.closest('.mes') || node);
                    }

                    // If the added node is an image inside mes_text
                    if (node.tagName === 'IMG' && node.closest('.mes_text')) {
                        scheduleImageWrap(node);
                    }

                    // If the added node contains images
                    if (node instanceof Element) {
                        const imgs = node.querySelectorAll('.mes_text img:not([data-iiv-processed]):not(.mes_img)');
                        imgs.forEach(img => {
                            scheduleImageWrap(img);
                        });
                        
                        const controlNodes = node.querySelectorAll('.mes_img_controls');
                        controlNodes.forEach(processMediaControls);
                    }
                    
                    if (node instanceof Element && node.classList && node.classList.contains('mes_img_controls')) {
                        processMediaControls(node);
                    }
                }

                // Handle attribute changes on images (e.g., src updates)
                if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
                    const img = mutation.target;
                    if (img.closest('.mes_text') && !img.hasAttribute(PROCESSED_ATTR) && !img.classList.contains('mes_img')) {
                        scheduleImageWrap(img);
                    }
                }
            }
        });

        observer.observe(chatEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src'],
        });

        // --- Intercept attached image clicks to provide smooth zooming ---
        chatEl.addEventListener('click', (e) => {
            if (!(e.target instanceof Element)) return;
            
            // 1. Attached Image Rerender Interception
            const clickedRerender = e.target.closest('.mes_media_rerender');
            if (clickedRerender) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                const mesEl = clickedRerender.closest('.mes');
                if (mesEl) {
                    const sdBtn = mesEl.querySelector('.sd_message_gen');
                    if (sdBtn instanceof HTMLElement) {
                        sdBtn.click(); // Fires native SD regeneration of the message's current attached image
                        if (typeof toastr !== 'undefined') toastr.info("Regenerating this message's current attached image with SillyTavern's own prompt...", 'Stable Diffusion');
                    } else {
                        if (typeof toastr !== 'undefined') toastr.warning('Stable Diffusion button not found on this message. Ensure SD is active.', 'Stable Diffusion');
                    }
                }
                return;
            }
            
            // Determine if we clicked an attached image or its enlarge button
            const clickedImg = e.target.closest('.mes_media_container .mes_img');
            const clickedEnlarge = e.target.closest('.mes_media_container .mes_media_enlarge');
            
            if (clickedImg || clickedEnlarge) {
                // Prevent SillyTavern's native expandMessageMedia from firing
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                const mediaContainer = (clickedImg || clickedEnlarge).closest('.mes_media_container');
                if (!mediaContainer) return;
                
                const imgEl = mediaContainer.querySelector('.mes_img');
                if (imgEl instanceof HTMLImageElement && imgEl.src) {
                    const title = imgEl.alt || imgEl.title || '';
                    openImagePopup(imgEl.src, title);
                }
            }
        }, true); // Use capture phase to intercept before jQuery delegated events bubble up

        debugLog('MutationObserver active on #chat');
    }

    // --- Character Card Avatar: Click-to-View + Separate Upload Button ---
    const AVATAR_VIEWER_ATTR = 'data-iiv-avatar-viewer';

    function isDefaultCharacterAvatar(src) {
        if (!src) return true;

        try {
            return new URL(src, window.location.href).pathname.endsWith('/img/ai4.png');
        } catch {
            return src.endsWith('img/ai4.png');
        }
    }

    function getCharacterAvatarPopupTitle() {
        const nameInput = document.getElementById('character_name_pole');
        const name = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '';
        return name || 'Character Avatar';
    }

    function getCharacterAvatarFullSrc(previewImg) {
        if (!(previewImg instanceof HTMLImageElement) || !previewImg.src || isDefaultCharacterAvatar(previewImg.src)) {
            return '';
        }

        // Unsaved uploads should open exactly what is currently previewed.
        if (previewImg.src.startsWith('data:') || previewImg.src.startsWith('blob:')) {
            return previewImg.src;
        }

        const avatarKeyInput = document.getElementById('avatar_url_pole');
        const avatarKey = avatarKeyInput instanceof HTMLInputElement ? avatarKeyInput.value.trim() : '';

        if (!avatarKey || avatarKey === 'none') {
            return previewImg.src;
        }

        return `/characters/${encodeURIComponent(avatarKey)}`;
    }

    function setupCharacterAvatarViewer() {
        const avatarLabel = document.getElementById('avatar_div_div');
        const previewImg = document.getElementById('avatar_load_preview');
        const fileInput = document.getElementById('add_avatar_button');
        if (!avatarLabel || !previewImg || !fileInput || avatarLabel.hasAttribute(AVATAR_VIEWER_ATTR)) return;
        avatarLabel.setAttribute(AVATAR_VIEWER_ATTR, 'true');

        // The file input lives inside the label, so move it out before converting the label into a viewer trigger.
        if (fileInput.parentElement === avatarLabel && avatarLabel.parentElement) {
            avatarLabel.parentElement.insertBefore(fileInput, avatarLabel.nextSibling);
        }

        // Remove the `for` attribute so clicking the avatar opens the viewer instead of the upload picker.
        avatarLabel.removeAttribute('for');
        avatarLabel.title = 'Click to view full image';
        avatarLabel.style.cursor = 'pointer';

        // Intercept clicks on the avatar to open the original character image instead of the thumbnail preview.
        avatarLabel.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const fullSrc = getCharacterAvatarFullSrc(previewImg);
            if (fullSrc) {
                openImagePopup(fullSrc, getCharacterAvatarPopupTitle(), null, { minimal: true });
            }
        }, true);

        // Inject an upload button into the character controls area.
        const controlsBlock = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
        if (controlsBlock && !controlsBlock.querySelector('.iiv-avatar-upload-btn')) {
            const uploadBtn = document.createElement('label');
            uploadBtn.className = 'menu_button fa-solid fa-camera iiv-avatar-upload-btn';
            uploadBtn.setAttribute('for', 'add_avatar_button');
            uploadBtn.setAttribute('aria-label', 'Upload new avatar image');
            uploadBtn.title = 'Upload new avatar image';
            // Insert at the beginning of controls, before the back button.
            controlsBlock.insertBefore(uploadBtn, controlsBlock.firstChild);
        }

        if (avatarLabel.parentElement && !document.getElementById('add_avatar_button_as_is')) {
            const originalInput = document.createElement('input');
            originalInput.hidden = true;
            originalInput.type = 'file';
            originalInput.id = 'add_avatar_button_as_is';
            originalInput.accept = 'image/*';
            originalInput.addEventListener('change', () => {
                const currentFileInput = document.getElementById('add_avatar_button');
                if (!originalInput.files?.length || !(currentFileInput instanceof HTMLInputElement)) return;

                const previousNeverResize = power_user.never_resize_avatars;
                const dataTransfer = new DataTransfer();
                for (const file of Array.from(originalInput.files)) {
                    dataTransfer.items.add(file);
                }

                currentFileInput.files = dataTransfer.files;
                power_user.never_resize_avatars = true;

                let restored = false;
                const restoreSetting = () => {
                    if (restored) return;
                    restored = true;
                    power_user.never_resize_avatars = previousNeverResize;
                    observer.disconnect();
                    clearTimeout(timeout);
                };
                const observer = new MutationObserver(restoreSetting);
                const timeout = setTimeout(restoreSetting, 15000);
                observer.observe(previewImg, { attributes: true, attributeFilter: ['src'] });

                currentFileInput.dispatchEvent(new Event('change', { bubbles: true }));
                originalInput.value = '';
            });
            avatarLabel.parentElement.insertBefore(originalInput, fileInput.nextSibling);
        }

        if (controlsBlock && !controlsBlock.querySelector('.iiv-avatar-upload-original-btn')) {
            const uploadOriginalBtn = document.createElement('label');
            uploadOriginalBtn.className = 'menu_button fa-solid fa-file-image iiv-avatar-upload-original-btn';
            uploadOriginalBtn.setAttribute('for', 'add_avatar_button_as_is');
            uploadOriginalBtn.setAttribute('aria-label', 'Upload original avatar image without crop or resize');
            uploadOriginalBtn.title = 'Upload original image as-is, without crop or resize';
            const insertAfter = controlsBlock.querySelector('.iiv-avatar-upload-btn');
            if (insertAfter?.nextSibling) {
                controlsBlock.insertBefore(uploadOriginalBtn, insertAfter.nextSibling);
            } else {
                controlsBlock.insertBefore(uploadOriginalBtn, controlsBlock.firstChild);
            }
        }

        debugLog('Character avatar viewer initialized.');
    }

    // --- Event-based hooks (real SillyTavern event names) ---
    // The old hooks used names ST never emits ('messageRendered', 'chatChanged',
    // 'characterSelected'), so they never fired; the MutationObserver did all
    // the work. These are the actual events.
    function processMessageById(mesId) {
        const id = Number(mesId);
        if (!Number.isInteger(id)) { processAllMessages(); return; }
        const mesEl = document.querySelector(`#chat .mes[mesid="${id}"]`);
        if (mesEl) queueProcessContainer(mesEl); else processAllMessages();
    }
    {
        const ctx = getContextSafe();
        const types = ctx?.eventTypes || ctx?.event_types;
        if (ctx?.eventSource && types) {
            const on = (type, fn) => { if (type !== undefined) ctx.eventSource.on(type, fn); };
            on(types.CHAT_CHANGED, () => {
                debugLog('Chat changed, processing inline images...');
                setTimeout(processAllMessages, 300);
                setTimeout(setupCharacterAvatarViewer, 300);
            });
            on(types.CHARACTER_MESSAGE_RENDERED, (mesId) => setTimeout(() => processMessageById(mesId), 50));
            on(types.USER_MESSAGE_RENDERED, (mesId) => setTimeout(() => processMessageById(mesId), 50));
            // A swipe or edit re-renders the message with new <img> elements.
            on(types.MESSAGE_SWIPED, (mesId) => setTimeout(() => processMessageById(mesId), 150));
            on(types.MESSAGE_UPDATED, (mesId) => setTimeout(() => processMessageById(mesId), 150));
            on(types.SETTINGS_UPDATED, () => applyInlineMaxHeight());
        }
    }

    // --- Settings panel ---
    function renderSettingsPanel() {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host || document.getElementById('iiv_settings')) return;
        const st = viewerSettings();
        const wrap = document.createElement('div');
        wrap.id = 'iiv_settings';
        wrap.className = 'extension_container';
        wrap.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Inline Image Viewer</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="flex-container flexnowrap" title="New seed per rerender, or leave the seed to the image backend. Only matters when the ComfyUI workflow uses the %seed% placeholder; a workflow with a hard-coded seed ignores it.">
                        <label for="iiv_seed_mode" class="flex1">Rerender seed</label>
                        <select id="iiv_seed_mode" class="text_pole widthNatural margin0">
                            <option value="random">New random seed</option>
                            <option value="keep">Leave to backend</option>
                        </select>
                    </div>
                    <div class="flex-container flexnowrap" title="Zoom factor per wheel notch, key press or button (1.05 to 3).">
                        <label for="iiv_zoom_step" class="flex1">Zoom step</label>
                        <input id="iiv_zoom_step" type="number" class="text_pole widthUnset" style="width:80px" min="1.05" max="3" step="0.05">
                    </div>
                    <div class="flex-container flexnowrap" title="Maximum height of inline images in the chat, as a percentage of the window height.">
                        <label for="iiv_inline_max_h" class="flex1">Inline image max height (vh)</label>
                        <input id="iiv_inline_max_h" type="number" class="text_pole widthUnset" style="width:80px" min="10" max="100" step="5">
                    </div>
                    <label class="checkbox_label" for="iiv_debug"><input id="iiv_debug" type="checkbox"><span>Debug logs</span></label>
                    <div style="opacity:0.72;font-size:0.86em;margin-top:4px">Rerenders go through Image Auto Generation's prompt pipeline (VIR look lock, cleaner, profile closer) when that extension is installed, with the same /sd arguments it uses.</div>
                </div>
            </div>`;
        host.appendChild(wrap);
        const seed = wrap.querySelector('#iiv_seed_mode');
        const zoom = wrap.querySelector('#iiv_zoom_step');
        const maxH = wrap.querySelector('#iiv_inline_max_h');
        const dbg = wrap.querySelector('#iiv_debug');
        seed.value = st.seedMode === 'keep' ? 'keep' : 'random';
        zoom.value = String(st.zoomStep);
        maxH.value = String(st.inlineMaxHeightVh);
        dbg.checked = Boolean(st.debug);
        const save = () => { const ctx = getContextSafe(); ctx?.saveSettingsDebounced?.(); };
        seed.addEventListener('change', () => { viewerSettings().seedMode = seed.value === 'keep' ? 'keep' : 'random'; save(); });
        zoom.addEventListener('change', () => { const v = Number(zoom.value); viewerSettings().zoomStep = Number.isFinite(v) && v > 1 && v < 4 ? v : IIV_DEFAULTS.zoomStep; zoom.value = String(viewerSettings().zoomStep); save(); });
        maxH.addEventListener('change', () => { const v = Number(maxH.value); viewerSettings().inlineMaxHeightVh = Number.isFinite(v) && v >= 10 && v <= 100 ? v : IIV_DEFAULTS.inlineMaxHeightVh; maxH.value = String(viewerSettings().inlineMaxHeightVh); applyInlineMaxHeight(); save(); });
        dbg.addEventListener('change', () => { viewerSettings().debug = dbg.checked; save(); });
    }

    // --- Initial setup ---
    applyInlineMaxHeight();
    renderSettingsPanel();
    setupObserver();
    setupCharacterAvatarViewer();

    // Process existing messages on load (with delay). Using two passes to handle
    // images loaded by DOM settled and or late-loaded images from cache.
    setTimeout(processAllMessages, 500);
    setTimeout(processAllMessages, 2000);
    setTimeout(setupCharacterAvatarViewer, 1000);

    debugLog('Extension loaded successfully.');
});
