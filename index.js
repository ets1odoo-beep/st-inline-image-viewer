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

jQuery(async function () {
    const extensionName = 'st-inline-image-viewer';
    const logPrefix = `[${extensionName}]`;
    const PROCESSED_ATTR = 'data-iiv-processed';
    const LOADING_ATTR = 'data-iiv-load-listener';
    const DEBUG = false;
    const imageNavRegistry = new WeakMap();
    const pendingContainers = new Set();
    let processTimer = null;

    function debugLog(...args) {
        if (DEBUG) console.log(logPrefix, ...args);
    }

    debugLog('Initializing...');

    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const ctx = SillyTavern.getContext();
        if (ctx && ctx.eventSource) {
            ctx.eventSource.on('messageFormatting', (args) => {
                if (args && typeof args.text === 'string') {
                    args.text = sanitizeRenderedImageMarkdown(args.text);
                }
            });
        }
    }

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

    function safeSaveChat() {
        const ctx = getContextSafe();
        const saveFn = ctx?.saveChat || ctx?.saveChatDebounced || (typeof window !== 'undefined' ? window.saveChatDebounced : null);
        if (typeof saveFn === 'function') {
            saveFn();
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
        return String(url || '')
            .replace(/%20/g, ' ').replace(/ /g, '%20')
            .replace(/%28/g, '(').replace(/\(/g, '%28')
            .replace(/%29/g, ')').replace(/\)/g, '%29');
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

    function sanitizeRenderedImageMarkdown(text) {
        return replaceMarkdownImages(text, (entry) => {
            const alt = entry.alt.replace(/\r?\n/g, ' ').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
            const titleSuffix = entry.title ? ` "${entry.title.replace(/"/g, '\\"')}"` : '';
            return `![${alt}](${entry.url}${titleSuffix})`;
        });
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

        const onPointerDown = (e) => {
            if (e.touches && e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initialPinchDistance = Math.hypot(dx, dy);
                initialScale = scale;
                return;
            }
            isDragging = true;
            img.classList.add('iiv-viewer-img-dragging');
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            startX = clientX - pannedX;
            startY = clientY - pannedY;
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            if (e.touches && e.touches.length === 2 && initialPinchDistance !== null) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                scale = Math.max(0.5, Math.min(initialScale * (dist / initialPinchDistance), 10));
                updateTransform();
                return;
            }
            if (!isDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
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
            zoomBy(delta > 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
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
                createViewerButton('fa-magnifying-glass-minus', 'Zoom out', () => zoomBy(1 / 1.2)),
                createViewerButton('fa-rotate-left', 'Reset zoom', resetZoom),
                actualSizeBtn,
                createViewerButton('fa-magnifying-glass-plus', 'Zoom in', () => zoomBy(1.2)),
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
            if (e.key === 'Escape') {
                e.preventDefault();
                closePopup();
            } else if (e.key === '0') {
                e.preventDefault();
                resetZoom();
            } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                zoomBy(1.2);
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                zoomBy(1 / 1.2);
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
            if (e.target !== img && !e.target.closest?.('.iiv-viewer-toolbar') && !e.target.closest?.('.iiv-viewer-title') && !e.target.closest?.('.iiv-viewer-panel')) {
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

        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const stChat = ctx ? ctx.chat : (typeof chat !== 'undefined' ? chat : null);

        /**
         * Convert any URL to a relative path, stripping the origin.
         * This prevents cross-origin errors when the user accesses ST
         * via different hostnames (localhost vs LAN IP).
         */
        function toRelativePath(url) {
            if (!url) return url;
            try {
                const parsed = new URL(url, window.location.origin);
                const path = parsed.origin === window.location.origin ? parsed.pathname.replace(/^\/+/, '') : parsed.href;
                return encodeMarkdownUrl(path);
            } catch {
                return encodeMarkdownUrl(url);
            }
        }

        // Always store relative paths to avoid cross-origin issues
        let imageStack = [toRelativePath(imgEl.src)];
        let currentIndex = 0;

        /**
         * Normalize a URL to just its pathname for robust comparison.
         * Strips origin/protocol and decodes percent-encoding so that
         * e.g. "http://localhost:8000/foo%20bar.png" matches "/foo bar.png".
         */
        function normalizeUrlForCompare(url) {
            try {
                const parsed = new URL(url, window.location.origin);
                const value = parsed.origin === window.location.origin ? parsed.pathname : parsed.href;
                return decodeURIComponent(value).replace(/^\/+/, '').toLowerCase();
            } catch {
                // Fallback: just decode and lowercase
                try { return decodeURIComponent(url).replace(/^\/+/, '').toLowerCase(); }
                catch { return url.toLowerCase(); }
            }
        }

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
            
            // Generate a completely stable key based on DOM index, surviving markdown URL changes!
            currentSrcKey = 'inline_img_' + imageIndex;
            
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

                if (foundEntry && foundEntry.alt && !/^images?$/i.test(foundEntry.alt) && !/^generated images?$/i.test(foundEntry.alt)) {
                    msg.extra.inlineImagePrompts[currentSrcKey] = foundEntry.alt;
                }
            }
        }
        
        function updateSourceMessage(oldSrc, newSrc) {
            const currentMesEl = imgEl.closest('.mes');
            const dynamicMesId = currentMesEl ? currentMesEl.getAttribute('mesid') : mesId;
            if (!dynamicMesId || !stChat || !stChat[dynamicMesId]) return;
            const msg = stChat[dynamicMesId];
            
            // Normalize a URL for comparison: decode percent-encoding, strip origin, lowercase
            function normForMatch(url) {
                try {
                    let u = url;
                    // Strip origin if present
                    if (u.startsWith('http')) {
                        try { u = new URL(u).pathname; } catch {}
                    }
                    if (u.startsWith('/')) u = u.substring(1);
                    return decodeURIComponent(u).toLowerCase();
                } catch {
                    return url.toLowerCase();
                }
            }

            // Build the relative new URL to write into markdown
            let relNewSrc = newSrc;
            try {
                const parsed = new URL(newSrc, window.location.origin);
                relNewSrc = parsed.origin === window.location.origin ? parsed.pathname.replace(/^\/+/, '') : parsed.href;
            } catch {
                relNewSrc = String(newSrc || '').replace(/^\/+/, '');
            }
            relNewSrc = encodeMarkdownUrl(relNewSrc);

            const normOld = normForMatch(oldSrc);

            // Find all ![alt](url) in msg.mes and replace the one matching oldSrc
            let replaced = false;
            msg.mes = replaceMarkdownImages(msg.mes, (entry) => {
                if (replaced) return entry.raw; // Only replace first match
                const normUrl = normForMatch(entry.url);
                if (normUrl === normOld) {
                    replaced = true;
                    const titleSuffix = entry.title ? ` "${entry.title.replace(/"/g, '\\"')}"` : '';
                    return `![${entry.rawAlt}](${relNewSrc}${titleSuffix})`;
                }
                return entry.raw;
            });
            
            if (replaced) {
                safeSaveChat();
            }
        }


        // Recover the actual SD prompt for regeneration.
        // Priority: (1) persisted per-image prompt, (2) non-generic alt text, (3) N-th <pic> tag, (4) msg.extra.title
        function getRegenerationPrompt() {
            const currentAlt = (imgEl.alt || imgEl.title || '').trim();
            const currentMesEl = imgEl.closest('.mes');
            const dynamicMesId = currentMesEl ? currentMesEl.getAttribute('mesid') : mesId;

            // 1. Check persisted per-image prompt first (most reliable for rerenders)
            if (dynamicMesId && stChat && stChat[dynamicMesId]) {
                const msg = stChat[dynamicMesId];
                if (msg.extra && msg.extra.inlineImagePrompts && msg.extra.inlineImagePrompts[currentSrcKey]) {
                    return msg.extra.inlineImagePrompts[currentSrcKey];
                }
            }

            // 2. If alt text exists and isn't generic, it's the most accurate per-image prompt
            if (currentAlt && !/^images?$/i.test(currentAlt) && !/^generated images?$/i.test(currentAlt)) {
                // Persist it for future rerenders
                if (dynamicMesId && stChat && stChat[dynamicMesId]) {
                    const msg = stChat[dynamicMesId];
                    if (!msg.extra) msg.extra = {};
                    if (!msg.extra.inlineImagePrompts) msg.extra.inlineImagePrompts = {};
                    msg.extra.inlineImagePrompts[currentSrcKey] = currentAlt;
                }
                return currentAlt;
            }

            if (dynamicMesId && stChat && stChat[dynamicMesId]) {
                const msg = stChat[dynamicMesId];
                // 3. Try to parse the N-th <pic prompt="..."> tag matching this image's index
                const picRegex = /<pic[^>]*\sprompt=['"]([\s\S]*?)['"]\s*\/?>/gi;
                let picMatch;
                let picIndex = 0;
                while ((picMatch = picRegex.exec(msg.mes)) !== null) {
                    if (picIndex === imageIndex && picMatch[1] && picMatch[1].trim()) {
                        return picMatch[1].trim();
                    }
                    picIndex++;
                }

                // 4. Fallback to msg.extra.title (message-scoped, may be wrong for multi-image)
                if (msg.extra && msg.extra.title && typeof msg.extra.title === 'string' && msg.extra.title.trim()) {
                    return msg.extra.title.trim();
                }
            }
            // Last resort
            return currentAlt;
        }

        function getMessageImageContexts() {
            const currentMesEl = imgEl.closest('.mes');
            const images = Array.from((currentMesEl || document).querySelectorAll('.iiv-inline-img-container > img'))
                .filter(image => image instanceof HTMLImageElement && imageNavRegistry.has(image));
            return images.map(image => imageNavRegistry.get(image)).filter(Boolean);
        }

        function persistVariantState() {
            if (mesId && stChat && stChat[mesId]) {
                if (!stChat[mesId].extra) stChat[mesId].extra = {};
                if (!stChat[mesId].extra.inlineImageVariants) stChat[mesId].extra.inlineImageVariants = {};
                stChat[mesId].extra.inlineImageVariants[currentSrcKey] = imageStack;
            }
        }

        function persistPrompt(prompt) {
            if (mesId && stChat && stChat[mesId]) {
                if (!stChat[mesId].extra) stChat[mesId].extra = {};
                if (!stChat[mesId].extra.inlineImagePrompts) stChat[mesId].extra.inlineImagePrompts = {};
                stChat[mesId].extra.inlineImagePrompts[currentSrcKey] = prompt;
            }
        }

        async function rerenderInlineImage(promptOverride = null) {
            const promptToUse = String(promptOverride ?? getRegenerationPrompt() ?? '').trim();
            if (!promptToUse) {
                if (typeof toastr !== 'undefined') toastr.warning('No image prompt found for this inline image.', 'Inline Image Viewer');
                return null;
            }
            if (typeof toastr !== 'undefined') toastr.info('Rerendering inline image...', 'Stable Diffusion');
            try {
                const sdCmd = SlashCommandParser.commands['imagine'] || SlashCommandParser.commands['sd'];
                if (!sdCmd || typeof sdCmd.callback !== 'function') {
                    if (typeof toastr !== 'undefined') toastr.warning('Stable Diffusion slash command is not available.', 'Inline Image Viewer');
                    throw new Error('Stable Diffusion command not found');
                }
                const rerenderArgs = { quiet: 'true' };
                if (mesId && stChat && stChat[mesId]) {
                    const storedType = stChat[mesId].extra?.inlineImageTypes?.[currentSrcKey];
                    if (storedType) {
                        const rCtx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
                        const imgSettings = rCtx?.extensionSettings?.['st-image-auto-generation'];
                        const presets = imgSettings?.resolutionPresets;
                        const defaultType = imgSettings?.defaultType || 'square';
                        const resolvedType = (presets?.[storedType]) ? storedType : defaultType;
                        const dims = presets?.[resolvedType] || { width: 512, height: 512 };
                        rerenderArgs.width = String(dims.width);
                        rerenderArgs.height = String(dims.height);
                    }
                }
                const charPrefix = getCharacterSDPrefix();
                const effectivePrompt = charPrefix ? `${charPrefix}, ${promptToUse}` : promptToUse;
                const newUrlRaw = await sdCmd.callback(rerenderArgs, effectivePrompt);
                if (!newUrlRaw) {
                    if (typeof toastr !== 'undefined') toastr.error('Stable Diffusion did not return an image URL.', 'Inline Image Viewer');
                    return null;
                }

                const newUrl = toRelativePath(newUrlRaw);
                const oldSrcMD = imageStack[currentIndex];
                imageStack.push(newUrl);
                currentIndex = imageStack.length - 1;
                persistVariantState();
                persistPrompt(promptToUse);
                imgEl.src = newUrl;
                updateSourceMessage(oldSrcMD, newUrl);
                if (typeof toastr !== 'undefined') toastr.success('Inline image rerendered.', 'Stable Diffusion');
                return { src: imgEl.src, title: imgEl.alt || imgEl.title || '', navContext };
            } catch (err) {
                console.error('Inline Image Viewer Rerender Error:', err);
                if (typeof toastr !== 'undefined') toastr.error('Failed to rerender image.');
                return null;
            }
        }

        const navContext = {
            getText: () => `${currentIndex + 1}/${imageStack.length}`,
            getImageText: () => `${imageIndex + 1}/${getMessageImageContexts().length || 1}`,
            getPrompt: getRegenerationPrompt,
            getState: () => ({ src: imgEl.src, title: imgEl.alt || imgEl.title || '', navContext }),
            canSwipeLeft: () => currentIndex > 0,
            canSwipeRight: () => getRegenerationPrompt() || currentIndex < imageStack.length - 1,
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
                        sdBtn.click(); // Fires native SD regeneration
                        if (typeof toastr !== 'undefined') toastr.info('Rerendering from current image prompt...', 'Stable Diffusion');
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

    // --- Event-based hooks ---
    // Use SillyTavern's event system if available
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const ctx = SillyTavern.getContext();
        if (ctx && ctx.eventSource) {
            // Re-process when chat changes
            ctx.eventSource.on('chatLoaded', () => {
                debugLog('Chat loaded, processing inline images...');
                // Small delay to let DOM settle
                setTimeout(processAllMessages, 300);
                setTimeout(setupCharacterAvatarViewer, 300);
            });

            ctx.eventSource.on('messageRendered', (_messageId) => {
                setTimeout(processAllMessages, 100);
            });

            ctx.eventSource.on('chatChanged', () => {
                setTimeout(processAllMessages, 300);
                setTimeout(setupCharacterAvatarViewer, 300);
            });

            // Also listen for character selection events
            ctx.eventSource.on('characterSelected', () => {
                setTimeout(setupCharacterAvatarViewer, 300);
            });
        }
    }

    // --- Initial setup ---
    setupObserver();
    setupCharacterAvatarViewer();

    // Process existing messages on load (with delay). Using two passes to handle
    // images loaded by DOM settled and or late-loaded images from cache.
    setTimeout(processAllMessages, 500);
    setTimeout(processAllMessages, 2000);
    setTimeout(setupCharacterAvatarViewer, 1000);

    debugLog('Extension loaded successfully.');
});
