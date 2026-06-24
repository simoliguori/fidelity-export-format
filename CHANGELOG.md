# Changelog

## 0.3.0 — 2026-06-24
- Renamed to **Fidelity Export & Format**
- New: **Splicing mode** — click a scissor between any two top-level blocks on the live PDF preview to insert a page break before that element. Click again to remove. PDF re-renders instantly. The `.md` is never modified.
- New: PDF-accurate preview is now the only preview mode (renders the actual WeasyPrint PDF as PNGs via PyMuPDF, pixel-perfect with the export)
- Fix: `[PNG]` stdout parsing broke on Windows because of CRLF line endings
- Fix: when a page-break is inserted, the wrapper `<div class="page-break">` no longer shifts subsequent block indexes (splicing choices stay stable across re-renders)
- Fix: scissor icons no longer clip at page edges; only the scissor under the cursor is shown
- Removed: HTML editor preview mode + Edit text / Reset edits buttons (replaced by splicing)
- Removed: `display: flow-root` from `.float-anchor`; floats now escape naturally so WeasyPrint paginates between paragraphs

## 0.2.0
- Mobile compatibility (HTML-only on mobile)
- Native folder picker for output destination
- 8 themes + accent picker (Minimal themes use the Obsidian accent)
- Banner background-position from `banner-x` / `banner-y` frontmatter
- Image float wrap-around with `.float-anchor` wrapper

## 0.1.0
- Initial release: HTML + PDF export, banner, image captions, footnotes, callouts, embed cards
