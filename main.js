'use strict';

const obsidian = require('obsidian');

// Platform detection: on mobile, Node APIs (fs/path/child_process/os) are NOT available.
const IS_MOBILE = !!(obsidian.Platform && obsidian.Platform.isMobile);

let execFile = null;
let path = null;
let fs = null;
let os = null;
if (!IS_MOBILE) {
    try {
        execFile = require('child_process').execFile;
        path = require('path');
        fs = require('fs');
        os = require('os');
    } catch (e) {
        console.warn('[Export Fidelity] Node modules unavailable, falling back to mobile mode');
    }
}

const THEMES = [
    { id: 'minimal-dark', label: 'Minimal — Dark' },
    { id: 'minimal-light', label: 'Minimal — Light' },
    { id: 'dark-kanagawa', label: 'Dark — Kanagawa' },
    { id: 'dark-dracula', label: 'Dark — Dracula' },
    { id: 'dark-nord', label: 'Dark — Nord' },
    { id: 'light-paper', label: 'Light — Paper' },
    { id: 'light-solarized', label: 'Light — Solarized' },
    { id: 'light-gruvbox', label: 'Light — Gruvbox' },
];

const MINIMAL_THEMES = new Set(['minimal-dark', 'minimal-light']);

const DEFAULT_SETTINGS = {
    pythonPath: '',
    outputFolder: 'exports',
    openAfterExport: 'pdf',
    defaultTheme: 'minimal-dark',
    accentColor: '',
    useObsidianAccent: true,
    fontSize: 14,
    bgColor: '',
    useThemeBg: true,
    showProperties: true,
    showTitle: true,
    format: 'pdf',
    previewMode: 'pdf',  // 'pdf' = paginated with break editor; 'html' = continuous
    showPageNumbers: false,
    marginH: 2.2,  // cm
    marginV: 1.6,  // cm
};

// Helper: inject the page-break editor + visual sheet pagination.
// Renders the preview as visually separated A4 sheets — by inserting gap dividers
// between blocks where the PDF will naturally paginate, simulating sheet edges.
function injectPreviewEditor(htmlString, breaksArray, previewMode, marginVcm) {
    const isPdf = previewMode === 'pdf';
    if (!isPdf) return htmlString;
    const css = `
        html { background: #2a2a2e !important; overflow-x: hidden !important; }
        body { background: #2a2a2e !important; margin: 0 !important; padding: 24px 0 !important; overflow-x: hidden !important; }
        .view-content {
            width: 794px !important;
            max-width: 794px !important;
            margin: 0 auto !important;
            background: var(--bg) !important;
            box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4);
            position: relative;
            overflow: visible;
            border-radius: 2px;
        }
        .markdown-preview-sizer { max-width: 100% !important; }
        .markdown-preview-view, .markdown-reading-view { width: 100% !important; }
        /* IMPORTANT: do not override .document-body padding here — the Python-generated
           CSS already has the correct user-configured margin-h / margin-v values. */
        /* Visual gap between simulated A4 sheets — high contrast */
        .ef-page-gap {
            display: block;
            height: 56px;  /* default; overridden inline for snap-to-page */
            min-height: 32px;
            margin: 0 -200px;
            background:
                /* dim band on top representing rest of current page */
                linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.65) calc(100% - 32px), transparent calc(100% - 32px)),
                /* visible separator strip at the bottom 32px */
                repeating-linear-gradient(45deg, #1a1a1d, #1a1a1d 10px, #2a2a2e 10px, #2a2a2e 20px);
            box-shadow:
                inset 0 -8px 14px -4px rgba(0,0,0,0.8),
                0 10px 24px rgba(0,0,0,0.5);
            position: relative;
        }
        .ef-page-gap-label {
            position: absolute; left: 50%; bottom: 0; transform: translate(-50%, 50%);
            background: var(--accent, #7f6df2); color: white;
            padding: 6px 20px; font-size: 12px; font-weight: 700;
            letter-spacing: 3px; border-radius: 4px;
            font-family: sans-serif;
            box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            z-index: 10;
        }
        /* Toggle controls */
/* break toggle buttons removed — use Edit text + whitespace instead */
    `;
    const breaksJson = JSON.stringify(breaksArray || []);
    const script = `
        (function(){
            const breaks = new Set(${breaksJson});
            // A4 height at 96 DPI = 1123px. WeasyPrint reserves margin-v (cm) at top
            // AND bottom of each page for whitespace + page numbers. We need to subtract
            // 2*marginVpx so the preview matches the actual PDF content area.
            const MARGIN_V_CM = ${marginVcm == null ? 1.6 : Number(marginVcm)};
            const MARGIN_V_PX = MARGIN_V_CM * 37.795;
            // Add a small safety margin (12px) to account for line-height differences
            // between Chromium and WeasyPrint, so the preview tends to break slightly
            // before WeasyPrint would, matching better in practice.
            const PAGE_HEIGHT = Math.max(400, 1123 - 2 * MARGIN_V_PX - 12);

            const viewContent = document.querySelector('.view-content');
            const docBody = document.querySelector('.document-body');
            if (!viewContent || !docBody) return;

            // (Toggle controls between blocks removed — use Edit text mode + whitespace
            // for manual line breaks; natural pagination handles page boundaries.)
            const children = Array.from(docBody.children);
            children.forEach((child, i) => {
                child.dataset.efBlock = i;
            });

            // 2) Simulate page break gaps by inserting .ef-page-gap dividers
            //    Walks all "leaf" blocks under .view-content and tracks running height
            function paginate() {
                document.querySelectorAll('.ef-page-gap').forEach(el => el.remove());

                // Since fit-to-width applies body.style.zoom (e.g. 0.71 in narrow modal),
                // getBoundingClientRect returns SCALED pixel heights. We must scale
                // PAGE_HEIGHT by the same factor so the comparison is apples-to-apples.
                const zoomVal = parseFloat(document.body.style.zoom) || 1;
                const effPH = PAGE_HEIGHT * zoomVal;
                const VISUAL_GAP = 32;  // size of the visual separator strip between sheets

                const vcTop = viewContent.getBoundingClientRect().top + window.scrollY;
                let pageNumber = 1;
                let pageStartY = 0;  // top of current page, relative to .view-content

                const sizer = viewContent.querySelector('.markdown-preview-sizer') || viewContent;
                const candidates = [];
                Array.from(sizer.children).forEach(child => {
                    if (child === docBody) {
                        Array.from(docBody.children).forEach(c => candidates.push(c));
                    } else {
                        candidates.push(child);
                    }
                });

                let i = 0;
                while (i < candidates.length) {
                    const block = candidates[i];
                    if (!block || !block.getBoundingClientRect) { i++; continue; }
                    const rect = block.getBoundingClientRect();
                    const blockTop = (rect.top + window.scrollY) - vcTop;
                    const blockBottom = (rect.bottom + window.scrollY) - vcTop;

                    let needBreak = false;
                    if (blockBottom - pageStartY > effPH && (blockTop - pageStartY) > 50) {
                        // Block overflows the current page. Push it to the next page.
                        needBreak = true;
                    }

                    if (needBreak) {
                        // Compute gap height so the block lands exactly at the start of the next page.
                        const remainingOnPage = (pageStartY + effPH) - blockTop;
                        const gapHeight = Math.max(VISUAL_GAP, remainingOnPage + VISUAL_GAP);
                        pageNumber++;
                        insertGapBefore(block, pageNumber, gapHeight);
                        // The block is now offset by gapHeight; the new page starts after the gap
                        pageStartY = blockTop + gapHeight;
                    }
                    i++;
                }
            }

            function insertGapBefore(block, pageNum, gapHeight) {
                const gap = document.createElement('div');
                gap.className = 'ef-page-gap';
                if (gapHeight) gap.style.height = gapHeight + 'px';
                const label = document.createElement('span');
                label.className = 'ef-page-gap-label';
                label.textContent = 'PAGE ' + pageNum;
                gap.appendChild(label);
                block.parentElement.insertBefore(gap, block);
            }

            function fitToWidth() {
                // Scale the page so it fits horizontally in the iframe width
                const iframeWidth = document.documentElement.clientWidth || window.innerWidth;
                const targetWidth = 794 + 48;  // A4 width + viewport side padding
                if (iframeWidth < targetWidth) {
                    const scale = Math.max(0.4, iframeWidth / targetWidth);
                    document.body.style.zoom = scale;
                } else {
                    document.body.style.zoom = 1;
                }
            }
            const runPaginate = () => {
                try {
                    fitToWidth();
                    paginate();
                    console.log('[ef-preview] paginated, gaps:', document.querySelectorAll('.ef-page-gap').length);
                } catch (e) {
                    console.error('[ef-preview] paginate error:', e);
                }
            };

            // Repaginate live whenever the user types/edits in contenteditable mode
            let editPaginateTimer = null;
            const onEditInput = () => {
                if (editPaginateTimer) clearTimeout(editPaginateTimer);
                editPaginateTimer = setTimeout(runPaginate, 180);
            };
            docBody.addEventListener('input', onEditInput);
            // Also catch keydown on Enter for immediate response on hard line breaks
            docBody.addEventListener('keyup', (e) => {
                if (e.key === 'Enter') onEditInput();
            });
            if (document.readyState === 'complete') runPaginate();
            else window.addEventListener('load', runPaginate);
            document.querySelectorAll('img').forEach(img => {
                if (!img.complete) img.addEventListener('load', runPaginate);
            });
            window.addEventListener('resize', runPaginate);
            // Re-run after a moment in case fonts/images settled late
            setTimeout(runPaginate, 600);
        })();
    `;
    const injection = '<style>' + css + '</style><script>' + script + '<' + '/script>';
    if (htmlString.includes('</body>')) return htmlString.replace('</body>', injection + '</body>');
    return htmlString + injection;
}

// Hex helpers
function hexToRgb(hex) {
    let h = (hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
    const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
}
function complementBg(accentHex, targetLuminance) {
    // Build a desaturated, low-luminance variant of the accent for use as a dark background
    // targetLuminance ~ 0.06 for very dark bg, ~ 0.92 for very light bg
    const rgb = hexToRgb(accentHex);
    if (!rgb) return null;
    const [r, g, b] = rgb;
    // Compute hue/saturation roughly: keep hue, drop saturation, set luminance
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const L = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d !== 0) {
        s = L > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r / 255: h = ((g / 255 - b / 255) / d) % 6; break;
            case g / 255: h = (b / 255 - r / 255) / d + 2; break;
            default: h = (r / 255 - g / 255) / d + 4;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    const sNew = Math.min(0.25, s);
    const lNew = targetLuminance != null ? targetLuminance : 0.06;
    // hsl -> rgb
    function hslToRgb(h, s, l) {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let r1 = 0, g1 = 0, b1 = 0;
        if (h < 60) { r1 = c; g1 = x; }
        else if (h < 120) { r1 = x; g1 = c; }
        else if (h < 180) { g1 = c; b1 = x; }
        else if (h < 240) { g1 = x; b1 = c; }
        else if (h < 300) { r1 = x; b1 = c; }
        else { r1 = c; b1 = x; }
        return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
    }
    const [rr, gg, bb] = hslToRgb(h, sNew, lNew);
    return rgbToHex(rr, gg, bb);
}

function getObsidianAccent() {
    try {
        const v = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim();
        if (v.startsWith('#')) return v;
        const div = document.createElement('div');
        div.style.color = v;
        document.body.appendChild(div);
        const rgb = getComputedStyle(div).color;
        document.body.removeChild(div);
        const m = rgb.match(/\d+/g);
        if (!m || m.length < 3) return '#7f6df2';
        return '#' + m.slice(0, 3).map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
    } catch (e) {
        return '#7f6df2';
    }
}

// JS port of Python THEMES (used by the mobile renderer; desktop uses the Python script).
const JS_THEMES = {
    'minimal-dark': { bg: '#000000', bg_soft: '#0d0d10', text: '#e6e3dc', text_muted: '#7e7e83', accent: '#7f6df2', link: '#7f6df2', strong: '#ffffff', em: '#c6c4be', quote_border: '#3a3d44', quote_bg: 'rgba(255,255,255,0.04)', table_border: 'rgba(230,227,220,0.14)', code_bg: '#0d0d10', code_fg: '#e6e3dc', banner_fade_rgb: '0,0,0' },
    'minimal-light': { bg: '#fafaf7', bg_soft: '#f1f0ec', text: '#26262a', text_muted: '#7e7e83', accent: '#7f6df2', link: '#7f6df2', strong: '#000000', em: '#3a3a3e', quote_border: '#d9d7d1', quote_bg: 'rgba(0,0,0,0.03)', table_border: 'rgba(38,38,42,0.12)', code_bg: '#f1f0ec', code_fg: '#26262a', banner_fade_rgb: '250,250,247' },
    'dark-kanagawa': { bg: '#1f1f28', bg_soft: '#2a2a37', text: '#dcd7ba', text_muted: '#8a8784', accent: '#7e9cd8', link: '#98bb6c', strong: '#ffa066', em: '#c0a36e', quote_border: '#957fb8', quote_bg: 'rgba(149,127,184,0.10)', table_border: 'rgba(220,215,186,0.18)', code_bg: '#2a2a37', code_fg: '#ffa066', banner_fade_rgb: '31,31,40' },
    'dark-dracula': { bg: '#282a36', bg_soft: '#343746', text: '#f8f8f2', text_muted: '#9aa0aa', accent: '#bd93f9', link: '#50fa7b', strong: '#ff79c6', em: '#f1fa8c', quote_border: '#bd93f9', quote_bg: 'rgba(189,147,249,0.12)', table_border: 'rgba(248,248,242,0.18)', code_bg: '#343746', code_fg: '#ff79c6', banner_fade_rgb: '40,42,54' },
    'dark-nord': { bg: '#2e3440', bg_soft: '#3b4252', text: '#eceff4', text_muted: '#9aa3b0', accent: '#88c0d0', link: '#a3be8c', strong: '#d08770', em: '#ebcb8b', quote_border: '#b48ead', quote_bg: 'rgba(180,142,173,0.12)', table_border: 'rgba(236,239,244,0.18)', code_bg: '#3b4252', code_fg: '#d08770', banner_fade_rgb: '46,52,64' },
    'light-paper': { bg: '#fdfaf1', bg_soft: '#f3eedd', text: '#2a2a28', text_muted: '#6a6864', accent: '#4a5b87', link: '#5a7e3a', strong: '#c25a1f', em: '#7d6a3a', quote_border: '#a07ec6', quote_bg: 'rgba(160,126,198,0.10)', table_border: 'rgba(42,42,40,0.15)', code_bg: '#f3eedd', code_fg: '#c25a1f', banner_fade_rgb: '253,250,241' },
    'light-solarized': { bg: '#fdf6e3', bg_soft: '#eee8d5', text: '#586e75', text_muted: '#93a1a1', accent: '#268bd2', link: '#859900', strong: '#cb4b16', em: '#b58900', quote_border: '#6c71c4', quote_bg: 'rgba(108,113,196,0.10)', table_border: 'rgba(88,110,117,0.18)', code_bg: '#eee8d5', code_fg: '#cb4b16', banner_fade_rgb: '253,246,227' },
    'light-gruvbox': { bg: '#fbf1c7', bg_soft: '#ebdbb2', text: '#3c3836', text_muted: '#7c6f64', accent: '#458588', link: '#79740e', strong: '#af3a03', em: '#b57614', quote_border: '#8f3f71', quote_bg: 'rgba(143,63,113,0.10)', table_border: 'rgba(60,56,54,0.18)', code_bg: '#ebdbb2', code_fg: '#af3a03', banner_fade_rgb: '251,241,199' },
};

function shiftColor(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    let [r, g, b] = rgb;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const delta = Math.round(255 * (amount || 0.05));
    if (lum < 0.5) { r += delta; g += delta; b += delta; }
    else { r -= delta; g -= delta; b -= delta; }
    return rgbToHex(r, g, b);
}

function buildThemeCSS(themeName, opts) {
    const base = JS_THEMES[themeName] || JS_THEMES['minimal-dark'];
    const t = Object.assign({}, base);
    if (opts.accent) { t.accent = opts.accent; t.link = opts.accent; }
    if (opts.bg) {
        t.bg = opts.bg;
        t.bg_soft = shiftColor(opts.bg, 0.05);
        t.code_bg = t.bg_soft;
        const rgb = hexToRgb(opts.bg);
        if (rgb) t.banner_fade_rgb = rgb.join(',');
    }
    const fs = opts.fontSize || 16;
    return `
:root {
  --bg: ${t.bg}; --bg-soft: ${t.bg_soft};
  --text: ${t.text}; --text-muted: ${t.text_muted};
  --accent: ${t.accent}; --link: ${t.link};
  --strong: ${t.strong}; --em: ${t.em};
  --quote-border: ${t.quote_border}; --quote-bg: ${t.quote_bg};
  --table-border: ${t.table_border};
  --code-bg: ${t.code_bg}; --code-fg: ${t.code_fg};
}
@page { size: A4; margin: 0; }
*,*::before,*::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif; font-size: ${fs}px; line-height: 1.6; }
.banner-container { position: relative; width: 100%; height: 380px; overflow: hidden; }
.pixel-banner-image { position: absolute; inset: 0; background-size: cover; background-repeat: no-repeat; }
.banner-fade { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(${t.banner_fade_rgb},0) 0%, rgba(${t.banner_fade_rgb},0) 55%, rgba(${t.banner_fade_rgb},0.75) 85%, rgba(${t.banner_fade_rgb},1) 100%); pointer-events: none; }
.document-body, .mod-header.mod-ui, .tag-row { max-width: 880px; margin: 0 auto; padding-left: 2.2cm; padding-right: 2.2cm; }
.mod-header.mod-ui { padding-top: 1.4em; }
.inline-title { font-size: 2.4em; font-weight: 700; margin: 0 0 0.2em 0; line-height: 1.15; }
.tag-row { margin-bottom: 1.6em; font-size: 0.85em; }
.tag { display: inline-block; background: rgba(127,109,242,0.12); color: var(--accent); padding: 1px 8px; border-radius: 999px; margin-right: 4px; text-decoration: none; }
h1,h2,h3,h4,h5,h6 { font-weight: 700; line-height: 1.25; margin-top: 1.4em; margin-bottom: 0.5em; clear: both; }
h1 { font-size: 1.7em; border-bottom: 1px solid var(--table-border); padding-bottom: 0.2em; }
.document-body > h1:first-child, .document-body > h1:first-of-type { font-size: 2.4em; line-height: 1.15; letter-spacing: -0.01em; font-weight: 700; border-bottom: none; padding-bottom: 0; margin-top: 0; margin-bottom: 0.5em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }
p { margin: 0.6em 0; }
strong { color: var(--strong); }
em { color: var(--em); font-style: italic; }
a { color: var(--link); text-decoration: none; border-bottom: 1px dotted var(--link); }
blockquote { border-left: 3px solid var(--quote-border); background: var(--quote-bg); margin: 1em 0; padding: 0.6em 1em; border-radius: 0 6px 6px 0; }
blockquote p { margin: 0; }
code { background: var(--code-bg); color: var(--code-fg); padding: 1px 5px; border-radius: 4px; font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 0.9em; }
pre { background: var(--code-bg); padding: 1em; border-radius: 6px; overflow-x: auto; }
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: 0.92em; }
th, td { border: 1px solid var(--table-border); padding: 0.5em 0.7em; text-align: left; vertical-align: top; }
th { background: rgba(127,109,242,0.08); font-weight: 600; }
ul, ol { padding-left: 1.4em; }
img { max-width: 100%; height: auto; } img[width] { width: attr(width px); }
.internal-embed.image-embed.img-align-right { float: right; margin: 0.4em 0 0.6em 1.2em; }
.internal-embed.image-embed.img-align-left { float: left; margin: 0.4em 1.2em 0.6em 0; }
.image-captions-caption { display: block; text-align: left; padding: 6px 2px 0; color: var(--text-muted); font-size: 0.85em; }
.float-anchor { display: flow-root; }
`;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
function mimeFromExt(ext) {
    const m = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
    return m[(ext || '').toLowerCase()] || 'image/png';
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


class ExportFidelityPlugin extends obsidian.Plugin {

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'export-current-note',
            name: 'Export current note...',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'md') return false;
                if (!checking) this.openExportModal(file);
                return true;
            },
        });

        this.addCommand({
            id: 'open-fidelity-export-menu',
            name: 'Open Fidelity Export menu',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'md') return false;
                if (!checking) this.openExportModal(file);
                return true;
            },
        });

        this.addCommand({
            id: 'quick-export-current-note',
            name: 'Quick export current note (default settings)',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'md') return false;
                if (!checking) this.exportFile(file);
                return true;
            },
        });

        this.addRibbonIcon('file-output', 'Fidelity Export & Format', () => {
            const file = this.app.workspace.getActiveFile();
            if (!file || file.extension !== 'md') {
                new obsidian.Notice('No active markdown note');
                return;
            }
            this.openExportModal(file);
        });

        // Right-click on a file in the explorer / on the note title → menu entry
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!(file instanceof obsidian.TFile) || file.extension !== 'md') return;
            menu.addItem((item) => {
                item.setTitle('Fidelity Export & Format...')
                    .setIcon('file-output')
                    .onClick(() => this.openExportModal(file));
            });
        }));

        this.addSettingTab(new ExportFidelitySettingTab(this.app, this));
    }

    onunload() { }

    async loadSettings() {
        const saved = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        // First-run: pick Desktop as the default output folder on desktop.
        if (!saved || !saved.outputFolder) {
            this.settings.outputFolder = this._guessDefaultOutputFolder();
        }
    }

    _guessDefaultOutputFolder() {
        if (IS_MOBILE) return 'exports';  // vault-relative on mobile
        try {
            if (os && os.homedir) {
                return path.join(os.homedir(), 'Desktop');
            }
        } catch (e) { /* fall through */ }
        return 'exports';
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    pluginDir() {
        return path.join(this.app.vault.adapter.getBasePath(), '.obsidian', 'plugins', this.manifest.id);
    }

    vaultRoot() {
        return this.app.vault.adapter.getBasePath();
    }

    openExportModal(file) {
        new ExportModal(this.app, this, file).open();
    }

    async exportFile(file, overrides) {
        if (IS_MOBILE) {
            return this.exportFileMobile(file, overrides);
        }
        const opts = Object.assign(
            { skipPdf: false, theme: this.settings.defaultTheme, fontSize: this.settings.fontSize },
            this.settings,
            overrides || {}
        );
        const vault = this.vaultRoot();
        const notePath = path.join(vault, file.path);
        const scriptPath = path.join(this.pluginDir(), 'obsidian_export.py');
        const outDir = path.isAbsolute(opts.outputFolder)
            ? opts.outputFolder
            : path.join(vault, opts.outputFolder);

        if (!fs.existsSync(scriptPath)) {
            new obsidian.Notice('Python script not found: ' + scriptPath, 8000);
            return null;
        }

        const notice = new obsidian.Notice(
            'Exporting "' + file.basename + '" (theme: ' + opts.theme + ')...',
            0
        );

        const args = [
            scriptPath, notePath,
            '-o', outDir,
            '--vault', vault,
            '--theme', opts.theme,
            '--font-size', String(opts.fontSize || 16),
        ];
        // If a live-edited HTML was captured, pass it via --from-html (bypasses markdown rendering)
        if (opts.fromHtmlPath) {
            args.push('--from-html', opts.fromHtmlPath);
        }
        if (opts.skipPdf) args.push('--no-pdf');
        if (!opts.showTitle) args.push('--hide-title');
        if (!opts.showProperties) args.push('--hide-properties');

        // Background override
        if (overrides && overrides.bg) {
            args.push('--bg', overrides.bg);
        }

        // Accent (minimal themes or explicit override)
        const isMinimal = MINIMAL_THEMES.has(opts.theme);
        if (isMinimal || (overrides && overrides.accent)) {
            let accent = overrides && overrides.accent;
            if (!accent) {
                if (opts.useObsidianAccent || !opts.accentColor) {
                    accent = getObsidianAccent();
                } else {
                    accent = opts.accentColor;
                }
            }
            if (accent) args.push('--accent', accent);
        }

        const result = await this.runPython(opts.pythonPath, args);
        notice.hide();

        if (!result.ok) {
            console.error('[Export Fidelity] stderr:', result.stderr);
            console.error('[Export Fidelity] stdout:', result.stdout);
            new obsidian.Notice(
                'Export failed: ' + result.errorMessage + '\n(see the console: View -> Toggle Developer Tools)',
                10000
            );
            return null;
        }

        const htmlPath = path.join(outDir, file.basename + '.html');
        const pdfPath = path.join(outDir, file.basename + '.pdf');
        new obsidian.Notice('Exported to ' + path.relative(vault, outDir) + '/', 5000);

        if (opts.openAfterExport === 'pdf' && fs.existsSync(pdfPath)) {
            this.revealAndOpen(pdfPath);
        } else if (opts.openAfterExport === 'html' && fs.existsSync(htmlPath)) {
            this.revealAndOpen(htmlPath);
        }
        return { htmlPath, pdfPath };
    }

    async exportFileMobile(file, overrides) {
        const opts = Object.assign(
            { skipPdf: true, theme: this.settings.defaultTheme, fontSize: this.settings.fontSize },
            this.settings,
            overrides || {}
        );

        const notice = new obsidian.Notice('Exporting "' + file.basename + '"...', 0);

        try {
            // Read markdown
            const md = await this.app.vault.read(file);

            // Split frontmatter (simple regex; fields used: banner, banner-x/y, tags)
            const fm = {};
            let body = md;
            const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/);
            if (fmMatch) {
                body = md.slice(fmMatch[0].length);
                fmMatch[1].split('\n').forEach((line) => {
                    const m2 = line.match(/^([\w-]+):\s*(.*)$/);
                    if (m2) {
                        let v = m2[2].trim();
                        if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1, -1);
                        fm[m2[1]] = v;
                    } else if (line.match(/^\s+-\s+(.+)$/)) {
                        const tag = line.match(/^\s+-\s+(.+)$/)[1].trim();
                        if (!fm.__list) fm.__list = [];
                        fm.__list.push(tag);
                    }
                });
            }
            // collect tags
            const tagsCache = this.app.metadataCache.getFileCache(file);
            const tags = (tagsCache && tagsCache.frontmatter && tagsCache.frontmatter.tags) || fm.__list || [];
            const tagList = Array.isArray(tags) ? tags : (tags ? [tags] : []);

            // Render markdown via Obsidian
            const tmpDiv = document.createElement('div');
            const comp = new obsidian.Component();
            await obsidian.MarkdownRenderer.render(this.app, body, tmpDiv, file.path, comp);

            // Inline images
            await this._inlineImages(tmpDiv, file);

            // Build banner HTML if frontmatter has banner
            let bannerHtml = '';
            if (fm.banner) {
                const bannerData = await this._readVaultImage(fm.banner, file);
                if (bannerData) {
                    const bx = fm['banner-x'] || '50';
                    const by = fm['banner-y'] || '50';
                    bannerHtml =
                        '<div class="banner-container">' +
                        '<div class="pixel-banner-image" style="background-image:url(' + bannerData + ');background-position:' + bx + '% ' + by + '%;"></div>' +
                        '<div class="banner-fade"></div>' +
                        '</div>';
                }
            }

            // Build title/tag blocks (respect hide flags)
            const titleHtml = !opts.showTitle ? '' :
                '<div class="mod-header mod-ui"><div class="inline-title">' + escapeHtml(file.basename) + '</div></div>';
            const tagHtml = (!opts.showProperties || tagList.length === 0) ? '' :
                '<div class="tag-row">' + tagList.map((t) => '<a class="tag" href="#">#' + escapeHtml(t) + '</a>').join(' ') + '</div>';

            // Theme CSS
            const accent = MINIMAL_THEMES.has(opts.theme)
                ? (opts.useObsidianAccent ? getObsidianAccent() : (opts.accentColor || getObsidianAccent()))
                : null;
            const bg = (MINIMAL_THEMES.has(opts.theme) && !opts.useThemeBg) ? (opts.bgColor || null) : null;
            const css = buildThemeCSS(opts.theme, { accent, bg, fontSize: opts.fontSize });

            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(file.basename) + '</title><style>' + css + '</style></head><body>' +
                '<div class="view-content">' + bannerHtml + titleHtml + tagHtml +
                '<div class="document-body">' + tmpDiv.innerHTML + '</div>' +
                '</div></body></html>';

            // Save inside the vault (output folder is treated as vault-relative on mobile)
            const outFolder = (opts.outputFolder || 'exports').replace(/^\/+/, '');
            const outDirAbstract = this.app.vault.getAbstractFileByPath(outFolder);
            if (!outDirAbstract) {
                try { await this.app.vault.createFolder(outFolder); } catch (e) { /* exists */ }
            }
            const outPath = outFolder + '/' + file.basename + '.html';
            const existing = this.app.vault.getAbstractFileByPath(outPath);
            if (existing) {
                await this.app.vault.modify(existing, html);
            } else {
                await this.app.vault.create(outPath, html);
            }

            comp.unload();
            notice.hide();
            new obsidian.Notice('Exported to ' + outPath, 5000);
            if (opts.openAfterExport === 'html') {
                const tf = this.app.vault.getAbstractFileByPath(outPath);
                if (tf) await this.app.workspace.getLeaf(true).openFile(tf);
            }
            return { htmlPath: outPath, pdfPath: null };
        } catch (e) {
            notice.hide();
            console.error('[Export Fidelity] mobile export failed:', e);
            new obsidian.Notice('Export failed: ' + e.message, 8000);
            return null;
        }
    }

    async _inlineImages(rootEl, sourceFile) {
        const imgs = Array.from(rootEl.querySelectorAll('img'));
        for (const img of imgs) {
            const src = img.getAttribute('src');
            if (!src || src.startsWith('data:')) continue;
            let pathHint = src;
            // app:// scheme used by Obsidian internally; strip to get the vault path
            const m = src.match(/app:\/\/[^\/]+\/(.+?)\?/);
            if (m) pathHint = decodeURIComponent(m[1]);
            const data = await this._readVaultImage(pathHint, sourceFile);
            if (data) img.setAttribute('src', data);
        }
    }

    async _readVaultImage(refPath, sourceFile) {
        try {
            let tFile = this.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(refPath), sourceFile.path);
            if (!tFile) {
                tFile = this.app.vault.getAbstractFileByPath(decodeURIComponent(refPath));
            }
            if (!tFile || !('extension' in tFile)) return null;
            const buf = await this.app.vault.readBinary(tFile);
            const base64 = arrayBufferToBase64(buf);
            const mime = mimeFromExt(tFile.extension);
            return 'data:' + mime + ';base64,' + base64;
        } catch (e) {
            console.warn('[Export Fidelity] failed to read image', refPath, e);
            return null;
        }
    }

    async _renderHtmlOnly(file, opts) {
        // Build the same HTML the mobile exporter would write, but return as string.
        const md = await this.app.vault.read(file);
        let body = md;
        const fm = {};
        const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
            body = md.slice(fmMatch[0].length);
            fmMatch[1].split('\n').forEach((line) => {
                const m2 = line.match(/^([\w-]+):\s*(.*)$/);
                if (m2) {
                    let v = m2[2].trim();
                    if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1, -1);
                    fm[m2[1]] = v;
                }
            });
        }
        const tagsCache = this.app.metadataCache.getFileCache(file);
        const tags = (tagsCache && tagsCache.frontmatter && tagsCache.frontmatter.tags) || [];
        const tagList = Array.isArray(tags) ? tags : (tags ? [tags] : []);

        const tmpDiv = document.createElement('div');
        const comp = new obsidian.Component();
        await obsidian.MarkdownRenderer.render(this.app, body, tmpDiv, file.path, comp);
        await this._inlineImages(tmpDiv, file);

        let bannerHtml = '';
        if (fm.banner) {
            const data = await this._readVaultImage(fm.banner, file);
            if (data) {
                const bx = fm['banner-x'] || '50';
                const by = fm['banner-y'] || '50';
                bannerHtml = '<div class="banner-container">' +
                    '<div class="pixel-banner-image" style="background-image:url(' + data + ');background-position:' + bx + '% ' + by + '%;"></div>' +
                    '<div class="banner-fade"></div></div>';
            }
        }

        const titleHtml = !opts.showTitle ? '' :
            '<div class="mod-header mod-ui"><div class="inline-title">' + escapeHtml(file.basename) + '</div></div>';
        const tagHtml = (!opts.showProperties || tagList.length === 0) ? '' :
            '<div class="tag-row">' + tagList.map((t) => '<a class="tag" href="#">#' + escapeHtml(t) + '</a>').join(' ') + '</div>';

        const accent = MINIMAL_THEMES.has(opts.theme)
            ? (opts.useObsidianAccent ? getObsidianAccent() : (opts.accentColor || getObsidianAccent()))
            : null;
        const bg = (MINIMAL_THEMES.has(opts.theme) && !opts.useThemeBg) ? (opts.bgColor || null) : null;
        const css = buildThemeCSS(opts.theme, { accent, bg, fontSize: opts.fontSize });

        comp.unload();

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(file.basename) + '</title><style>' + css + '</style></head><body>' +
            '<div class="view-content">' + bannerHtml + titleHtml + tagHtml +
            '<div class="document-body">' + tmpDiv.innerHTML + '</div>' +
            '</div></body></html>';
    }

    async renderPreview(file, opts) {
        // Run the script with --no-pdf into a temp folder, return the HTML path
        const vault = this.vaultRoot();
        const notePath = path.join(vault, file.path);
        const scriptPath = path.join(this.pluginDir(), 'obsidian_export.py');
        const tmpDir = path.join(os.tmpdir(), 'obsidian-export-fidelity-preview');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const args = [
            scriptPath, notePath,
            '-o', tmpDir,
            '--vault', vault,
            '--theme', opts.theme,
            '--font-size', String(opts.fontSize || 16),
            '--no-pdf',
        ];
        if (MINIMAL_THEMES.has(opts.theme)) {
            const accent = opts.useObsidianAccent
                ? getObsidianAccent()
                : (opts.accentColor || getObsidianAccent());
            if (accent) args.push('--accent', accent);
            if (!opts.useThemeBg && opts.bgColor) {
                args.push('--bg', opts.bgColor);
            }
        }
        if (!opts.showTitle) args.push('--hide-title');
        if (!opts.showProperties) args.push('--hide-properties');

        const r = await this.runPython(this.settings.pythonPath, args);
        if (!r.ok) {
            return { ok: false, error: r.errorMessage, stderr: r.stderr };
        }
        return { ok: true, htmlPath: path.join(tmpDir, file.basename + '.html') };
    }

    async renderPreviewAsPNG(file, opts) {
        // Run the script with --preview-pages and collect resulting PNG paths
        const vault = this.vaultRoot();
        const notePath = path.join(vault, file.path);
        const scriptPath = path.join(this.pluginDir(), 'obsidian_export.py');
        const tmpDir = path.join(os.tmpdir(), 'obsidian-export-fidelity-pdfprev');
        if (fs.existsSync(tmpDir)) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
        fs.mkdirSync(tmpDir, { recursive: true });
        const pagesDir = path.join(tmpDir, 'pages');
        const outPdf = path.join(tmpDir, file.basename + '.pdf');

        const args = [
            scriptPath, notePath,
            '-o', tmpDir,
            '--vault', vault,
            '--theme', opts.theme,
            '--font-size', String(opts.fontSize || 16),
            '--no-html',
            '--preview-pages', pagesDir,
        ];
        if (MINIMAL_THEMES.has(opts.theme)) {
            const accent = opts.useObsidianAccent ? getObsidianAccent() : (opts.accentColor || getObsidianAccent());
            if (accent) args.push('--accent', accent);
            if (!opts.useThemeBg && opts.bgColor) args.push('--bg', opts.bgColor);
        }
        if (!opts.showTitle) args.push('--hide-title');
        if (!opts.showProperties) args.push('--hide-properties');
        if (opts.marginH != null) args.push('--margin-h', String(opts.marginH));
        if (opts.marginV != null) args.push('--margin-v', String(opts.marginV));
        if (opts.showPageNumbers) args.push('--page-numbers');
        if (opts.pageBreaksBefore && opts.pageBreaksBefore.length) {
            args.push('--page-breaks', opts.pageBreaksBefore.join(','));
        }

        const r = await this.runPython(this.settings.pythonPath, args);
        if (!r.ok) {
            return { ok: false, error: r.errorMessage, stderr: r.stderr };
        }
        // Read PNG paths from stdout. NOTE: on Windows the lines end with \r\n,
        // and JS regex `.` does NOT match \r, so `(.+)$` would fail (the \r
        // remains between the captured path and end-of-string, breaking the $
        // anchor). Strip \r explicitly so the match works cross-platform.
        const pngPaths = [];
        for (const rawLine of (r.stdout || '').split('\n')) {
            const line = rawLine.replace(/\r+$/, '');
            const m = line.match(/^\[PNG\]\s+(.+)$/);
            if (m) pngPaths.push(m[1].trim());
        }
        if (pngPaths.length === 0) {
            // Surface the actual Python stdout/stderr so the user can diagnose.
            const stdoutTail = (r.stdout || '').split('\n').slice(-20).join('\n');
            const stderrTail = (r.stderr || '').split('\n').slice(-20).join('\n');
            console.error('[Export Fidelity] no PNGs from Python.\nSTDOUT (last 20 lines):\n' + stdoutTail + '\n\nSTDERR (last 20 lines):\n' + stderrTail);
            // Pull a meaningful 1-line hint from stdout/stderr if possible
            let hint = 'No PNG pages were generated.';
            const m = (r.stdout || '').match(/\[WARN\][^\n]*/);
            if (m) hint = m[0];
            else if (r.stderr && r.stderr.trim()) hint = 'Python error: ' + r.stderr.trim().split('\n').pop().slice(0, 200);
            return { ok: false, error: hint + ' (see console for full Python output)', stderr: r.stderr };
        }
        // Read each PNG as base64 data URI
        const dataUris = pngPaths.map(p => {
            try {
                const buf = fs.readFileSync(p);
                return 'data:image/png;base64,' + buf.toString('base64');
            } catch (e) {
                return null;
            }
        }).filter(Boolean);
        // Also read the _blocks.json sidecar (per-page text-block positions
        // used by the splicing UI to overlay clickable scissors).
        let blocks = null;
        try {
            const blocksPath = path.join(pagesDir, '_blocks.json');
            if (fs.existsSync(blocksPath)) {
                blocks = JSON.parse(fs.readFileSync(blocksPath, 'utf-8'));
            }
        } catch (e) {
            console.warn('[Export Fidelity] failed to read _blocks.json:', e);
        }
        return { ok: true, pngDataUris: dataUris, blocks };
    }

    async runPython(userPath, args) {
        const candidates = [];
        if (userPath && userPath.trim()) candidates.push(userPath.trim());
        candidates.push('python', 'python3', 'py');

        let lastErr = null;
        for (const cmd of candidates) {
            try {
                const r = await new Promise((resolve) => {
                    execFile(cmd, args, { windowsHide: true, maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
                        resolve({ err, stdout, stderr });
                    });
                });
                if (r.err) {
                    if (r.err.code === 'ENOENT') {
                        lastErr = 'interpreter "' + cmd + '" not found';
                        continue;
                    }
                    return {
                        ok: false,
                        errorMessage: 'python returned an error (exit ' + (r.err.code || '?') + ')',
                        stderr: r.stderr,
                        stdout: r.stdout,
                    };
                }
                return { ok: true, stdout: r.stdout, stderr: r.stderr };
            } catch (e) {
                lastErr = String(e);
            }
        }
        return { ok: false, errorMessage: lastErr || 'no Python interpreter available', stderr: '', stdout: '' };
    }

    revealAndOpen(filePath) {
        try {
            const { shell } = require('electron');
            shell.openPath(filePath);
        } catch (e) {
            console.error('[Export Fidelity] reveal failed:', e);
        }
    }
}

function buildPdfPreviewHtml(pngDataUris, blocks, splicingMode, activeBreaks) {
    // blocks: per-page array [{page, page_w, page_h, blocks: [{x,y,w,h,text,htmlIdx},...]}]
    // splicingMode: boolean — if true, overlay clickable scissors before each block where htmlIdx is set
    // activeBreaks: Set/Array of htmlIdx that already have a break
    const activeSet = new Set(Array.isArray(activeBreaks) ? activeBreaks : []);
    const sheets = pngDataUris.map((u, i) => {
        const pageInfo = blocks && blocks[i];
        // build splicing overlays
        let overlays = '';
        if (splicingMode && pageInfo && pageInfo.blocks && pageInfo.page_h) {
            const pageH = pageInfo.page_h;
            // Track which htmlIdx values already placed so we don't render
            // multiple scissors for the same block (in case a paragraph has
            // several PDF blocks all sharing the same htmlIdx).
            const seen = new Set();
            for (const b of pageInfo.blocks) {
                if (b.htmlIdx == null) continue;
                if (seen.has(b.htmlIdx)) continue;
                seen.add(b.htmlIdx);
                if (b.y < 14) continue;  // would clip at the page top
                if (b.y > pageH - 14) continue;  // would clip at the page bottom
                const yPct = (b.y / pageH) * 100;
                const isActive = activeSet.has(b.htmlIdx);
                const label = (b.text || '').replace(/"/g, '&quot;').slice(0, 50);
                overlays += '<div class="ef-splice' + (isActive ? ' ef-splice-active' : '') + '"' +
                    ' style="top: ' + yPct.toFixed(3) + '%"' +
                    ' data-html-idx="' + b.htmlIdx + '"' +
                    ' data-page="' + (i + 1) + '"' +
                    ' title="' + (isActive ? 'Remove page break before: ' : 'Insert page break before: ') + label + '">' +
                    '<span class="ef-splice-line"></span>' +
                    '<span class="ef-splice-scissor">&#9986;</span>' +
                    '<span class="ef-splice-line"></span>' +
                    '</div>';
            }
        }
        return '<div class="ef-pdf-sheet" data-page="' + (i + 1) + '">' +
                '<img src="' + u + '" alt="page ' + (i + 1) + '" />' +
                '<div class="ef-pdf-page-label">PAGE ' + (i + 1) + '</div>' +
                overlays +
            '</div>';
    }).join('');
    return [
        '<!doctype html><html><head><meta charset="utf-8"><style>',
        'html, body { background: #2a2a2e; margin: 0; padding: 24px 0; overflow-x: hidden; }',
        'body { display: flex; flex-direction: column; align-items: center; gap: 24px; }',
        '.ef-pdf-sheet { position: relative; box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4); width: 100%; max-width: 794px; }',
        '.ef-pdf-sheet img { display: block; width: 100%; height: auto; }',
        '.ef-pdf-page-label { position: absolute; right: 12px; top: 12px; background: rgba(127,109,242,0.92); color: white; padding: 2px 10px; font-size: 10px; font-weight: 600; letter-spacing: 2px; border-radius: 3px; font-family: sans-serif; }',
        // Splicing overlay styling — invisible by default. The strip is still
        // hoverable (pointer-events: auto on the .ef-splice element), and the
        // visible scissor + line appear ONLY for the strip under the cursor.
        // Active breaks (already inserted) stay visible permanently.
        '.ef-splice { position: absolute; left: 0; right: 0; height: 28px; transform: translateY(-50%); display: flex; align-items: center; gap: 4px; padding: 0 12px; cursor: pointer; opacity: 0; transition: opacity 0.10s ease; z-index: 5; }',
        '.ef-splice:hover { opacity: 1; }',
        '.ef-splice-active { opacity: 1; }',
        '.ef-splice-line { flex: 1; height: 0; border-top: 2px dashed #ff5e5e; }',
        '.ef-splice-active .ef-splice-line { border-top: 3px solid #ff3030; }',
        '.ef-splice-scissor { background: #ff5e5e; color: white; min-width: 26px; height: 22px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.5); user-select: none; white-space: nowrap; flex: 0 0 auto; }',
        '.ef-splice-active .ef-splice-scissor { background: #ff3030; }',
        '.ef-splice:hover .ef-splice-scissor { transform: scale(1.12); }',
        '</style></head><body>',
        sheets,
        '<script>',
        // Bubble click events up to the parent via postMessage so the modal can re-render
        '(function(){',
        '  document.addEventListener("click", function(ev){',
        '    var sp = ev.target.closest && ev.target.closest(".ef-splice");',
        '    if (!sp) return;',
        '    var idx = parseInt(sp.getAttribute("data-html-idx"), 10);',
        '    if (isNaN(idx)) return;',
        '    try { window.parent.postMessage({ type: "ef-splice-toggle", htmlIdx: idx }, "*"); } catch (e) {}',
        '  });',
        '})();',
        '</script>',
        '</body></html>'
    ].join('\n');
}

class ExportModal extends obsidian.Modal {
    constructor(app, plugin, file) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        // local state, seeded from current settings
        this.state = {
            theme: plugin.settings.defaultTheme,
            useObsidianAccent: plugin.settings.useObsidianAccent,
            accentColor: plugin.settings.accentColor || getObsidianAccent(),
            outputFolder: plugin.settings.outputFolder,
            openAfterExport: plugin.settings.openAfterExport,
            fontSize: plugin.settings.fontSize || 16,
            skipPdf: (plugin.settings.format || 'pdf') === 'html',
            useThemeBg: plugin.settings.useThemeBg !== false,
            bgColor: plugin.settings.bgColor || '#000000',
            showTitle: !!plugin.settings.showTitle,
            showProperties: !!plugin.settings.showProperties,
            format: plugin.settings.format || 'pdf',
            previewMode: plugin.settings.previewMode || ((plugin.settings.format || 'pdf') === 'html' ? 'html' : 'pdf'),
            // Preview ALWAYS uses pdf-accurate (PyMuPDF renders the actual PDF
            // as PNGs). The HTML editor mode was inaccurate because Chromium and
            // WeasyPrint disagree about box sizes. PNGs match what gets exported.
            previewSource: 'pdf-accurate',
            editMode: false,
            editedBodyHTML: null,  // captured from contenteditable iframe at export time
            // Block IDs (0-indexed children of .document-body) where to insert a page break BEFORE
            pageBreaksBefore: [],
            splicingMode: false,  // when ON, overlay clickable scissors on the PDF preview
            showPageNumbers: !!plugin.settings.showPageNumbers,
            marginH: plugin.settings.marginH != null ? plugin.settings.marginH : 2.2,
            marginV: plugin.settings.marginV != null ? plugin.settings.marginV : 1.6,
        };
        this._previewTimer = null;
    }

    onOpen() {
        const { modalEl, contentEl, titleEl } = this;
        modalEl.classList.add('export-fidelity-modal');
        // make the modal wide
        modalEl.style.width = 'min(1100px, 95vw)';
        modalEl.style.maxWidth = '95vw';

        titleEl.setText('Export: ' + this.file.basename);

        // Listen to break-toggle events from the preview iframe
        this._messageHandler = (e) => {
            if (!e.data || e.data.type !== 'ef-toggle-break') return;
            const id = e.data.blockId;
            const arr = this.state.pageBreaksBefore;
            const idx = arr.indexOf(id);
            if (idx >= 0) arr.splice(idx, 1); else arr.push(id);
            this.refreshPreview();
        };
        window.addEventListener('message', this._messageHandler);

        // Two-column layout: form on left, preview on right
        const grid = contentEl.createDiv({ cls: 'efm-grid' });
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'minmax(320px, 380px) 1fr';
        grid.style.gap = '20px';
        grid.style.minHeight = '60vh';

        this.formEl = grid.createDiv({ cls: 'efm-form' });
        this.formEl.style.overflowY = 'auto';
        this.formEl.style.maxHeight = '70vh';
        this.formEl.style.paddingRight = '8px';

        this.previewWrap = grid.createDiv({ cls: 'efm-preview' });
        this.previewWrap.style.display = 'flex';
        this.previewWrap.style.flexDirection = 'column';
        this.previewWrap.style.minHeight = '60vh';
        this.previewWrap.style.border = '1px solid var(--background-modifier-border)';
        this.previewWrap.style.borderRadius = '6px';
        this.previewWrap.style.overflow = 'hidden';

        this.buildForm();
        this.buildPreviewArea();
        this.buildActionRow();

        // initial preview
        this.schedulePreview(0);
    }

    onClose() {
        if (this._previewTimer) clearTimeout(this._previewTimer);
        if (this._messageHandler) {
            window.removeEventListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if (this._splicingListener) {
            window.removeEventListener('message', this._splicingListener);
            this._splicingListener = null;
        }
        this.contentEl.empty();
    }

    buildForm() {
        const f = this.formEl;
        f.empty();

        f.createEl('div', { text: 'Output', cls: 'efm-section-title' })
            .setAttr('style', 'font-weight:600; margin-top:0.8em; margin-bottom:0.3em;');

        if (!IS_MOBILE) {
            new obsidian.Setting(f)
                .setName('Format')
                .addDropdown((d) => {
                    d.addOption('pdf', 'PDF only');
                    d.addOption('both', 'HTML + PDF');
                    d.addOption('html', 'HTML only (faster)');
                    d.setValue(this.state.format).onChange((v) => {
                        this.state.format = v;
                        this.state.skipPdf = v === 'html';
                        // adjust previewMode coherently
                        if (v === 'pdf') this.state.previewMode = 'pdf';
                        if (v === 'html') this.state.previewMode = 'html';
                        this.buildForm();
                        this.schedulePreview();
                    });
                });

            // Preview is always PDF-accurate (PNG render). Help hint:
            if (this.state.format === 'pdf' || this.state.format === 'both') {
                const help = f.createDiv({ cls: 'efm-pagination-help' });
                help.style.background = 'var(--background-secondary)';
                help.style.border = '1px solid var(--background-modifier-border)';
                help.style.borderRadius = '6px';
                help.style.padding = '10px 12px';
                help.style.margin = '8px 0 4px 0';
                help.style.fontSize = '0.85em';
                help.style.lineHeight = '1.5';
                help.createEl('div', { text: 'Preview & Splicing mode' })
                    .setAttr('style', 'font-weight:600; margin-bottom:6px;');
                const intro = help.createEl('div');
                intro.setAttr('style', 'color: var(--text-muted);');
                intro.innerHTML =
                    'The preview shows the <b>actual PDF</b> rendered by WeasyPrint, page by page — pixel-perfect.<br>' +
                    'Click <b>✂ Splicing mode</b> (above the preview) to overlay clickable scissor icons on every paragraph, heading and block. ' +
                    'Click a scissor to <b>insert a page break</b> before that block — the PDF re-renders immediately. Click it again to remove the break. ' +
                    'Use <b>Clear breaks</b> to wipe all manual breaks. ' +
                    'Your <code>.md</code> file is never modified; breaks live only in this modal session.';
            }
        } else {
            // Mobile: HTML only, no PDF
            this.state.skipPdf = true;
            this.state.format = 'html';
            this.state.previewMode = 'html';
            const info = new obsidian.Setting(f).setName('Format');
            info.descEl.setText('HTML only (PDF requires desktop)');
        }

        const outFolderSetting = new obsidian.Setting(f).setName('Output folder');
        // Stack label sopra il controllo, controllo full-width
        outFolderSetting.settingEl.style.flexDirection = 'column';
        outFolderSetting.settingEl.style.alignItems = 'stretch';
        outFolderSetting.settingEl.style.gap = '4px';
        outFolderSetting.controlEl.style.width = '100%';
        outFolderSetting.controlEl.style.justifyContent = 'stretch';
        let outFolderTextRef = null;
        outFolderSetting
            .addText((t) => {
                outFolderTextRef = t;
                t.setPlaceholder('exports')
                    .setValue(this.state.outputFolder)
                    .onChange((v) => {
                        this.state.outputFolder = v || 'exports';
                    });
                t.inputEl.style.flex = '1';
                t.inputEl.style.width = '100%';
                t.inputEl.style.fontFamily = 'var(--font-monospace)';
            })
            ;
        if (!IS_MOBILE) {
            outFolderSetting.addExtraButton((btn) => {
                btn.setIcon('folder-open')
                    .setTooltip('Browse...')
                    .onClick(async () => {
                        const picked = await pickFolder(this.state.outputFolder, this.plugin.vaultRoot());
                        if (picked) {
                            this.state.outputFolder = picked;
                            if (outFolderTextRef) outFolderTextRef.setValue(picked);
                        }
                    });
            });
        }

        new obsidian.Setting(f)
            .setName('Open after export')
            .addDropdown((d) =>
                d.addOption('pdf', 'PDF')
                    .addOption('html', 'HTML')
                    .addOption('none', 'None')
                    .setValue(this.state.openAfterExport)
                    .onChange((v) => {
                        this.state.openAfterExport = v;
                    })
            );

        new obsidian.Setting(f)
            .setName('Theme')
            .addDropdown((d) => {
                THEMES.forEach((t) => d.addOption(t.id, t.label));
                d.setValue(this.state.theme).onChange((v) => {
                    this.state.theme = v;
                    this.buildForm();
                    this.schedulePreview();
                });
            });

        // Accent — only for minimal themes
        if (MINIMAL_THEMES.has(this.state.theme)) {
            f.createEl('div', { text: 'Accent color', cls: 'efm-section-title' })
                .setAttr('style', 'font-weight:600; margin-top:0.8em; margin-bottom:0.3em;');

            new obsidian.Setting(f)
                .setName('Use Obsidian accent')
                .setDesc('Currently: ' + getObsidianAccent())
                .addToggle((t) =>
                    t.setValue(this.state.useObsidianAccent).onChange((v) => {
                        this.state.useObsidianAccent = v;
                        this.buildForm();
                        this.schedulePreview();
                    })
                );

            if (!this.state.useObsidianAccent) {
                new obsidian.Setting(f)
                    .setName('Custom accent')
                    .addColorPicker((cp) =>
                        cp.setValue(this.state.accentColor).onChange((v) => {
                            this.state.accentColor = v;
                            this.schedulePreview();
                        })
                    )
                    .addText((t) =>
                        t.setPlaceholder('#7f6df2').setValue(this.state.accentColor).onChange((v) => {
                            v = v.trim();
                            if (v === '' || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
                                this.state.accentColor = v;
                                this.schedulePreview();
                            }
                        })
                    );
            }
        }

                // Background section (only for minimal themes)
        if (MINIMAL_THEMES.has(this.state.theme)) {
            f.createEl('div', { text: 'Background', cls: 'efm-section-title' })
                .setAttr('style', 'font-weight:600; margin-top:0.8em; margin-bottom:0.3em;');

            new obsidian.Setting(f)
                .setName('Use theme background')
                .setDesc('Off = use the custom background below')
                .addToggle((t) =>
                    t.setValue(this.state.useThemeBg).onChange((v) => {
                        this.state.useThemeBg = v;
                        this.buildForm();
                        this.schedulePreview();
                    })
                );

            if (!this.state.useThemeBg) {
                const bgSetting = new obsidian.Setting(f).setName('Custom background');
                bgSetting
                    .addColorPicker((cp) =>
                        cp.setValue(this.state.bgColor).onChange((v) => {
                            this.state.bgColor = v;
                            this.schedulePreview();
                        })
                    )
                    .addText((t) =>
                        t.setPlaceholder('#000000').setValue(this.state.bgColor).onChange((v) => {
                            v = v.trim();
                            if (v === '' || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
                                this.state.bgColor = v;
                                this.schedulePreview();
                            }
                        })
                    )
                    .addExtraButton((b) =>
                        b.setIcon('palette')
                            .setTooltip('Tinted from accent (desaturated low-luminance variant)')
                            .onClick(() => {
                                const accent = this.state.useObsidianAccent
                                    ? getObsidianAccent()
                                    : (this.state.accentColor || getObsidianAccent());
                                const isLightTheme = this.state.theme === 'minimal-light';
                                const target = isLightTheme ? 0.95 : 0.06;
                                const derived = complementBg(accent, target);
                                if (derived) {
                                    this.state.bgColor = derived;
                                    this.buildForm();
                                    this.schedulePreview();
                                }
                            })
                    );
            }
        }

        f.createEl('div', { text: 'Typography', cls: 'efm-section-title' })
            .setAttr('style', 'font-weight:600; margin-top:0.8em; margin-bottom:0.3em;');

        new obsidian.Setting(f)
            .setName('Body font size')
            .setDesc(this.state.fontSize + ' px')
            .addSlider((s) =>
                s.setLimits(10, 22, 1)
                    .setValue(this.state.fontSize)
                    .setDynamicTooltip()
                    .onChange((v) => {
                        this.state.fontSize = v;
                        const items = f.querySelectorAll('.setting-item');
                        items.forEach((it) => {
                            if (it.querySelector('input[type=range]')) {
                                const d = it.querySelector('.setting-item-description');
                                if (d) d.textContent = v + ' px';
                            }
                        });
                        this.schedulePreview();
                    })
            );

        f.createEl('div', { text: 'Content', cls: 'efm-section-title' })
            .setAttr('style', 'font-weight:600; margin-top:0.8em; margin-bottom:0.3em;');

        new obsidian.Setting(f)
            .setName('Show note title')
            .addToggle((t) =>
                t.setValue(this.state.showTitle).onChange((v) => {
                    this.state.showTitle = v;
                    this.schedulePreview();
                })
            );

        new obsidian.Setting(f)
            .setName('Show properties')
            .addToggle((t) =>
                t.setValue(this.state.showProperties).onChange((v) => {
                    this.state.showProperties = v;
                    this.schedulePreview();
                })
            );

        new obsidian.Setting(f)
            .setName('Show page numbers (PDF)')
            .setDesc('Renders the page number at the bottom of each PDF page.')
            .addToggle((t) =>
                t.setValue(this.state.showPageNumbers).onChange((v) => {
                    this.state.showPageNumbers = v;
                    this.schedulePreview();
                })
            );

        f.createEl('div', { text: 'Margins', cls: 'efm-section-title' })
            .setAttr('style', 'font-weight:600; margin-top:0.8em; margin-bottom:0.3em;');

        new obsidian.Setting(f)
            .setName('Horizontal margin')
            .setDesc(this.state.marginH.toFixed(1) + ' cm')
            .addSlider((s) =>
                s.setLimits(0.5, 5.0, 0.1)
                    .setValue(this.state.marginH)
                    .setDynamicTooltip()
                    .onChange((v) => {
                        this.state.marginH = Math.round(v * 10) / 10;
                        // update desc
                        const items = f.querySelectorAll('.setting-item');
                        items.forEach((it) => {
                            const name = it.querySelector('.setting-item-name');
                            if (name && name.textContent === 'Horizontal margin') {
                                const d = it.querySelector('.setting-item-description');
                                if (d) d.textContent = this.state.marginH.toFixed(1) + ' cm';
                            }
                        });
                        this.schedulePreview();
                    })
            );

        new obsidian.Setting(f)
            .setName('Vertical margin')
            .setDesc(this.state.marginV.toFixed(1) + ' cm')
            .addSlider((s) =>
                s.setLimits(0.0, 5.0, 0.1)
                    .setValue(this.state.marginV)
                    .setDynamicTooltip()
                    .onChange((v) => {
                        this.state.marginV = Math.round(v * 10) / 10;
                        const items = f.querySelectorAll('.setting-item');
                        items.forEach((it) => {
                            const name = it.querySelector('.setting-item-name');
                            if (name && name.textContent === 'Vertical margin') {
                                const d = it.querySelector('.setting-item-description');
                                if (d) d.textContent = this.state.marginV.toFixed(1) + ' cm';
                            }
                        });
                        this.schedulePreview();
                    })
            );


    }

    buildPreviewArea() {
        const w = this.previewWrap;

        const bar = w.createDiv({ cls: 'efm-preview-bar' });
        bar.style.display = 'flex';
        bar.style.alignItems = 'center';
        bar.style.justifyContent = 'space-between';
        bar.style.padding = '6px 10px';
        bar.style.borderBottom = '1px solid var(--background-modifier-border)';
        bar.style.background = 'var(--background-secondary)';

        this.statusEl = bar.createSpan({ text: 'Preview' });
        this.statusEl.style.fontSize = '0.85em';
        this.statusEl.style.color = 'var(--text-muted)';

        const btnRow = bar.createDiv();
        btnRow.style.display = 'flex';
        btnRow.style.gap = '6px';

        // Splicing mode toggle — when ON, the PDF preview overlays clickable
        // scissor icons before every top-level block. Clicking one inserts
        // (or removes) a page-break before that element and re-renders.
        const spliceBtn = btnRow.createEl('button', { text: '✂ Splicing mode' });
        spliceBtn.style.fontSize = '0.85em';
        const updateSpliceBtn = () => {
            spliceBtn.textContent = this.state.splicingMode ? '✂ Splicing ON' : '✂ Splicing mode';
            if (this.state.splicingMode) spliceBtn.classList.add('mod-warning');
            else spliceBtn.classList.remove('mod-warning');
        };
        spliceBtn.onclick = () => {
            this.state.splicingMode = !this.state.splicingMode;
            updateSpliceBtn();
            this.refreshPreview();
        };
        updateSpliceBtn();

        // Clear all breaks button — only visible when breaks exist
        const clearBtn = btnRow.createEl('button', { text: 'Clear breaks' });
        clearBtn.style.fontSize = '0.85em';
        clearBtn.onclick = () => {
            this.state.pageBreaksBefore = [];
            this.refreshPreview();
        };

        const refreshBtn = btnRow.createEl('button', { text: 'Refresh' });
        refreshBtn.style.fontSize = '0.85em';
        refreshBtn.onclick = () => this.refreshPreview();

        // Listen for splice toggle messages from the preview iframe
        if (!this._splicingListener) {
            this._splicingListener = (ev) => {
                const data = ev && ev.data;
                if (!data || data.type !== 'ef-splice-toggle') return;
                if (typeof data.htmlIdx !== 'number') return;
                const idx = data.htmlIdx;
                const arr = this.state.pageBreaksBefore || [];
                const pos = arr.indexOf(idx);
                if (pos >= 0) arr.splice(pos, 1);
                else arr.push(idx);
                this.state.pageBreaksBefore = arr;
                this.refreshPreview();
            };
            window.addEventListener('message', this._splicingListener);
        }

        this.iframeEl = w.createEl('iframe');
        this.iframeEl.style.flex = '1';
        this.iframeEl.style.width = '100%';
        this.iframeEl.style.minHeight = '400px';
        this.iframeEl.style.border = 'none';
        this.iframeEl.style.background = 'var(--background-primary)';
        // Sandbox permits self-contained HTML to render without scripts
        this.iframeEl.setAttribute('sandbox', 'allow-same-origin');
    }

    buildActionRow() {
        const row = this.contentEl.createDiv({ cls: 'efm-actions' });
        row.style.display = 'flex';
        row.style.justifyContent = 'flex-end';
        row.style.gap = '8px';
        row.style.marginTop = '12px';

        // Edit text / Reset edits buttons removed: preview is now PDF-accurate
        // (read-only PNG rendering of the actual WeasyPrint output).

        const cancel = row.createEl('button', { text: 'Cancel' });
        cancel.style.marginLeft = 'auto';  // push trailing buttons to the right
        cancel.onclick = () => this.close();

        const exportBtn = row.createEl('button', { text: 'Export' });
        exportBtn.classList.add('mod-cta');
        exportBtn.onclick = () => this.runExport();
    }

    applyEditMode() {
        try {
            const doc = this.iframeEl.contentDocument;
            if (!doc) {
                console.warn('[Export Fidelity] iframe contentDocument not accessible');
                return;
            }
            const body = doc.querySelector('.document-body') || doc.body;
            if (!body) {
                console.warn('[Export Fidelity] document-body not found in iframe');
                return;
            }
            body.contentEditable = this.state.editMode ? 'true' : 'false';
            body.style.outline = this.state.editMode ? '2px dashed var(--accent, #7f6df2)' : '';
            body.style.outlineOffset = '4px';
            body.style.minHeight = this.state.editMode ? '200px' : '';
            if (this.state.editMode) {
                body.focus();
                if (!body._efEditListener) {
                    body._efEditListener = () => {
                        this.state.editedBodyHTML = body.innerHTML;
                    };
                    body.addEventListener('input', body._efEditListener);
                }
                console.log('[Export Fidelity] edit mode ON');
            } else {
                console.log('[Export Fidelity] edit mode OFF');
            }
        } catch (e) {
            console.error('[Export Fidelity] applyEditMode failed:', e);
            new obsidian.Notice('Edit mode error: ' + e.message);
        }
    }

    captureEditedHTML() {
        try {
            const doc = this.iframeEl.contentDocument;
            if (!doc) return null;
            const docBody = doc.querySelector('.document-body');
            if (!docBody) return null;
            const clone = doc.documentElement.cloneNode(true);
            clone.querySelectorAll('.ef-break-ctrl, .ef-page-gap, .ef-page-guide').forEach(el => el.remove());
            clone.querySelectorAll('style, script').forEach(el => {
                const txt = (el.textContent || '');
                if (txt.includes('ef-break-ctrl') || txt.includes('ef-page-gap') || txt.includes('window.parent.postMessage')) {
                    el.remove();
                }
            });
            // Remove editor-only inline styles that would leak into the PDF:
            // - dashed outline applied to .document-body during edit mode
            // - contenteditable / outline / minHeight / zoom decorations
            // - body.style.zoom from fit-to-width
            clone.querySelectorAll('.document-body').forEach(el => {
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.style.minHeight = '';
                el.removeAttribute('contenteditable');
            });
            const cloneBody = clone.querySelector('body');
            if (cloneBody) {
                cloneBody.style.zoom = '';
            }
            return '<!doctype html>\n' + clone.outerHTML;
        } catch (e) {
            console.error('[Export Fidelity] captureEditedHTML failed:', e);
            return null;
        }
    }

    async runExport() {
        const accent = MINIMAL_THEMES.has(this.state.theme)
            ? (this.state.useObsidianAccent ? getObsidianAccent() : this.state.accentColor)
            : null;

        const bg = (MINIMAL_THEMES.has(this.state.theme) && !this.state.useThemeBg)
            ? this.state.bgColor
            : null;

        // Capture edited HTML if user has been editing
        let fromHtmlPath = null;
        if ((this.state.editMode || this.state.editedBodyHTML) && !IS_MOBILE) {
            const edited = this.captureEditedHTML();
            if (edited) {
                try {
                    fromHtmlPath = path.join(os.tmpdir(), 'ef-edited-' + Date.now() + '.html');
                    fs.writeFileSync(fromHtmlPath, edited, 'utf-8');
                } catch (e) {
                    console.error('[Export Fidelity] Failed to write edited HTML:', e);
                    fromHtmlPath = null;
                }
            }
        }

        // Persist modal state as "last used" settings for next time
        Object.assign(this.plugin.settings, {
            defaultTheme: this.state.theme,
            fontSize: this.state.fontSize,
            useObsidianAccent: this.state.useObsidianAccent,
            accentColor: this.state.accentColor,
            useThemeBg: this.state.useThemeBg,
            bgColor: this.state.bgColor,
            showTitle: this.state.showTitle,
            showProperties: this.state.showProperties,
            outputFolder: this.state.outputFolder,
            openAfterExport: this.state.openAfterExport,
        });
        await this.plugin.saveSettings();

        this.close();
        await this.plugin.exportFile(this.file, {
            theme: this.state.theme,
            accent: accent,
            bg: bg,
            fontSize: this.state.fontSize,
            outputFolder: this.state.outputFolder,
            openAfterExport: this.state.openAfterExport,
            skipPdf: this.state.skipPdf,
            pdfOnly: this.state.format === 'pdf',
            showTitle: this.state.showTitle,
            showProperties: this.state.showProperties,
            pageBreaksBefore: this.state.pageBreaksBefore,
            marginH: this.state.marginH,
            marginV: this.state.marginV,
            showPageNumbers: this.state.showPageNumbers,
            fromHtmlPath: fromHtmlPath,
        });
    }

    schedulePreview(delay) {
        if (this._previewTimer) clearTimeout(this._previewTimer);
        this._previewTimer = setTimeout(() => this.refreshPreview(), delay == null ? 350 : delay);
    }

    async refreshPreview() {
        this.statusEl.textContent = 'Rendering...';
        // PDF-accurate path: generate the actual PDF and show pages as PNGs
        if (!IS_MOBILE && this.state.previewSource === 'pdf-accurate' && this.state.previewMode === 'pdf') {
            try {
                const r = await this.plugin.renderPreviewAsPNG(this.file, {
                    theme: this.state.theme,
                    fontSize: this.state.fontSize,
                    useObsidianAccent: this.state.useObsidianAccent,
                    accentColor: this.state.accentColor,
                    useThemeBg: this.state.useThemeBg,
                    bgColor: this.state.bgColor,
                    showTitle: this.state.showTitle,
                    showProperties: this.state.showProperties,
                    pageBreaksBefore: this.state.pageBreaksBefore,
                    marginH: this.state.marginH,
                    marginV: this.state.marginV,
                    showPageNumbers: this.state.showPageNumbers,
                });
                if (r.ok) {
                    // Sandbox: need allow-scripts for the splicing click handler postMessage
                    this.iframeEl.setAttribute('sandbox', 'allow-same-origin allow-scripts');
                    this.iframeEl.srcdoc = buildPdfPreviewHtml(
                        r.pngDataUris,
                        r.blocks,
                        !!this.state.splicingMode,
                        this.state.pageBreaksBefore || []
                    );
                    this.statusEl.textContent = 'PDF preview ready (' + r.pngDataUris.length + ' pages)' + (this.state.splicingMode ? ' — Splicing ON' : '');
                } else {
                    this.statusEl.textContent = 'PDF preview error (see console)';
                    console.error('[Export Fidelity] PDF preview error:', r.error);
                }
            } catch (e) {
                this.statusEl.textContent = 'PDF preview error: ' + e.message;
                console.error('[Export Fidelity] PDF preview error:', e);
            }
            return;
        }
        if (IS_MOBILE) {
            // Mobile preview: generate HTML in-memory via the JS renderer
            try {
                const html = await this.plugin._renderHtmlOnly(this.file, {
                    theme: this.state.theme,
                    fontSize: this.state.fontSize,
                    useObsidianAccent: this.state.useObsidianAccent,
                    accentColor: this.state.accentColor,
                    useThemeBg: this.state.useThemeBg,
                    bgColor: this.state.bgColor,
                    showTitle: this.state.showTitle,
                    showProperties: this.state.showProperties,
                });
                const wrapped = injectPreviewEditor(html, this.state.pageBreaksBefore, this.state.previewMode, this.state.marginV);
                this.iframeEl.setAttribute('sandbox', 'allow-same-origin allow-scripts');
                this.iframeEl.srcdoc = wrapped;
                this.statusEl.textContent = 'Preview ready';
            } catch (e) {
                this.statusEl.textContent = 'Preview error: ' + e.message;
                console.error('[Export Fidelity] mobile preview error:', e);
            }
            return;
        }
        const opts = {
            theme: this.state.theme,
            fontSize: this.state.fontSize,
            useObsidianAccent: this.state.useObsidianAccent,
            accentColor: this.state.accentColor,
            useThemeBg: this.state.useThemeBg,
            bgColor: this.state.bgColor,
            showTitle: this.state.showTitle,
            showProperties: this.state.showProperties,
        };
        const r = await this.plugin.renderPreview(this.file, opts);
        if (!r.ok) {
            this.statusEl.textContent = 'Preview error (see console)';
            console.error('[Export Fidelity] preview error:', r.error, r.stderr);
            return;
        }
        try {
            let html = fs.readFileSync(r.htmlPath, 'utf-8');
            html = injectPreviewEditor(html, this.state.pageBreaksBefore, this.state.previewMode, this.state.marginV);
            this.iframeEl.setAttribute('sandbox', 'allow-same-origin allow-scripts');
            this.iframeEl.srcdoc = html;
            this.statusEl.textContent = 'Preview ready';
        } catch (e) {
            this.statusEl.textContent = 'Preview error: ' + e.message;
            console.error('[Export Fidelity] preview read error:', e);
        }
    }
}

async function pickFolder(defaultPath, vaultRoot) {
    try {
        const electron = require('electron');
        const dialog = (electron.remote && electron.remote.dialog) || electron.dialog;
        if (!dialog) {
            new obsidian.Notice('Folder picker unavailable in this Obsidian build');
            return null;
        }
        let startPath = defaultPath;
        if (!path.isAbsolute(startPath)) startPath = path.join(vaultRoot, defaultPath);
        const result = await dialog.showOpenDialog({
            title: 'Pick export folder',
            defaultPath: startPath,
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
        return result.filePaths[0];
    } catch (e) {
        console.error('[Export Fidelity] folder picker error:', e);
        new obsidian.Notice('Folder picker error: ' + e.message);
        return null;
    }
}

class ExportFidelitySettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Fidelity Export & Format' });
        if (IS_MOBILE) {
            const banner = containerEl.createEl('div', { cls: 'setting-item-description' });
            banner.style.padding = '8px 12px';
            banner.style.marginBottom = '12px';
            banner.style.background = 'rgba(127,109,242,0.10)';
            banner.style.borderRadius = '6px';
            banner.setText('Mobile mode: HTML export only (PDF requires desktop). The renderer uses Obsidian\'s built-in markdown engine plus this plugin\'s themes and accent picker.');
        }

        new obsidian.Setting(containerEl)
            .setName('Default theme')
            .setDesc('Color palette pre-selected in the export modal and used by the Quick export command.')
            .addDropdown((d) => {
                THEMES.forEach((t) => d.addOption(t.id, t.label));
                d.setValue(this.plugin.settings.defaultTheme).onChange(async (v) => {
                    this.plugin.settings.defaultTheme = v;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        const defaultIsMinimal = MINIMAL_THEMES.has(this.plugin.settings.defaultTheme);
        const obsidianAccent = getObsidianAccent();

        const accentHeader = containerEl.createEl('h3', { text: 'Accent color (Minimal themes only)' });
        const accentDesc = containerEl.createEl('p', {
            text: 'Applied to links, tags, and other colored elements of the Minimal themes. Other themes ship with a fixed palette.',
            cls: 'setting-item-description',
        });
        if (!defaultIsMinimal) {
            accentHeader.style.opacity = '0.5';
            accentDesc.style.opacity = '0.5';
        }

        new obsidian.Setting(containerEl)
            .setName('Use Obsidian accent')
            .setDesc('Currently: ' + obsidianAccent)
            .addToggle((t) =>
                t.setValue(this.plugin.settings.useObsidianAccent).onChange(async (v) => {
                    this.plugin.settings.useObsidianAccent = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        const customAccentSetting = new obsidian.Setting(containerEl)
            .setName('Custom accent (hex)')
            .setDesc('Overrides the Obsidian accent.')
            .addColorPicker((cp) => {
                const initial = this.plugin.settings.accentColor || obsidianAccent;
                cp.setValue(initial).onChange(async (v) => {
                    this.plugin.settings.accentColor = v;
                    this.plugin.settings.useObsidianAccent = false;
                    await this.plugin.saveSettings();
                });
            })
            .addText((t) =>
                t.setPlaceholder('#7f6df2')
                    .setValue(this.plugin.settings.accentColor || '')
                    .onChange(async (v) => {
                        v = v.trim();
                        if (v === '' || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
                            this.plugin.settings.accentColor = v;
                            if (v) this.plugin.settings.useObsidianAccent = false;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        if (this.plugin.settings.useObsidianAccent || !defaultIsMinimal) {
            customAccentSetting.settingEl.style.opacity = '0.5';
        }

        containerEl.createEl('h3', { text: 'Typography' });

        new obsidian.Setting(containerEl)
            .setName('Default body font size (px)')
            .setDesc('Initial value of the font-size slider in the export modal.')
            .addSlider((s) =>
                s.setLimits(10, 22, 1)
                    .setValue(this.plugin.settings.fontSize || 16)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        this.plugin.settings.fontSize = v;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl('h3', { text: 'Runtime' });

        if (!IS_MOBILE) {
            new obsidian.Setting(containerEl)
                .setName('Python executable')
                .setDesc('Path to the Python interpreter. Leave empty to auto-detect.')
                .addText((text) =>
                    text.setPlaceholder('auto-detect')
                        .setValue(this.plugin.settings.pythonPath)
                        .onChange(async (v) => {
                            this.plugin.settings.pythonPath = v;
                            await this.plugin.saveSettings();
                        })
                );
        }

        const defaultOutSetting = new obsidian.Setting(containerEl)
            .setName('Default output folder');
        defaultOutSetting.settingEl.style.flexDirection = 'column';
        defaultOutSetting.settingEl.style.alignItems = 'stretch';
        defaultOutSetting.settingEl.style.gap = '4px';
        defaultOutSetting.controlEl.style.width = '100%';
        defaultOutSetting.controlEl.style.justifyContent = 'stretch';
        let outTextRef = null;
        defaultOutSetting
            .addText((text) => {
                outTextRef = text;
                text.setPlaceholder('exports')
                    .setValue(this.plugin.settings.outputFolder)
                    .onChange(async (v) => {
                        this.plugin.settings.outputFolder = v || 'exports';
                        await this.plugin.saveSettings();
                    });
            });

        if (!IS_MOBILE) {
            defaultOutSetting.addExtraButton((b) =>
                b.setIcon('folder-open')
                    .setTooltip('Browse...')
                    .onClick(async () => {
                        const picked = await pickFolder(this.plugin.settings.outputFolder, this.plugin.vaultRoot());
                        if (picked) {
                            this.plugin.settings.outputFolder = picked;
                            await this.plugin.saveSettings();
                            if (outTextRef) outTextRef.setValue(picked);
                        }
                    })
            );
        }

        new obsidian.Setting(containerEl)
        new obsidian.Setting(containerEl)
            .setName('Default "open after export"')
            .addDropdown((d) =>
                d.addOption('pdf', 'PDF')
                    .addOption('html', 'HTML')
                    .addOption('none', 'None')
                    .setValue(this.plugin.settings.openAfterExport)
                    .onChange(async (v) => {
                        this.plugin.settings.openAfterExport = v;
                        await this.plugin.saveSettings();
                    })
            );
    }
}

module.exports = ExportFidelityPlugin;
