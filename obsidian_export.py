"""
Obsidian-faithful exporter — converts a markdown note into HTML and PDF while
preserving Pixel Banner banners, image embeds with captions, float alignment,
tables, callouts, and footnotes.

Usage:
    python obsidian_export.py <path/to/note.md>

Run with --help for all options.
"""
from __future__ import annotations
import sys
import re
import base64
import mimetypes
import html as html_lib
from pathlib import Path

import yaml
import markdown
from markdown.extensions import Extension
from markdown.preprocessors import Preprocessor
from markdown.blockprocessors import BlockProcessor
import xml.etree.ElementTree as etree
import urllib.request
import urllib.error
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# ============================================================
#   PATH RESOLUTION
# ============================================================
VAULT_ROOT: Path = Path("/")
ATTACH_ROOT: Path = Path("/")



def _hex_to_rgb(hex_str):
    h = hex_str.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb_to_hex(r, g, b):
    return f"#{max(0,min(255,int(r))):02x}{max(0,min(255,int(g))):02x}{max(0,min(255,int(b))):02x}"


def _luminance(r, g, b):
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255


def shift_color(hex_color, amount=0.05):
    """Lighten if dark, darken if light. amount in [0,1]."""
    r, g, b = _hex_to_rgb(hex_color)
    lum = _luminance(r, g, b)
    delta = int(255 * amount)
    if lum < 0.5:
        return _rgb_to_hex(r + delta, g + delta, b + delta)
    return _rgb_to_hex(r - delta, g - delta, b - delta)

def find_vault_root(note_path: Path):
    """Risale i parent finché non trova una cartella .obsidian/."""
    p = note_path.resolve()
    for parent in [p.parent, *p.parents]:
        if (parent / ".obsidian").is_dir():
            return parent
    return None


def set_vault_root(root: Path) -> None:
    """Imposta VAULT_ROOT e deduce ATTACH_ROOT da .obsidian/app.json o fallback."""
    global VAULT_ROOT, ATTACH_ROOT
    VAULT_ROOT = root
    app_json = root / ".obsidian" / "app.json"
    if app_json.exists():
        try:
            import json as _json
            cfg = _json.loads(app_json.read_text(encoding="utf-8"))
            af = cfg.get("attachmentFolderPath", "")
            if af and af != "/":
                candidate = (root / af) if not af.startswith("/") else (root / af.lstrip("/"))
                if candidate.exists():
                    ATTACH_ROOT = candidate
                    return
        except Exception:
            pass
    for name in ("allegati", "attachments", "assets", "img", "images"):
        cand = root / name
        if cand.is_dir():
            ATTACH_ROOT = cand
            return
    ATTACH_ROOT = root


def resolve_asset(rel_path: str):
    """Risolve un riferimento di asset Obsidian (anche solo filename)
    cercando prima nel path relativo, poi in /allegati, poi nell'intero vault."""
    rel_path = rel_path.strip()
    if not rel_path:
        return None

    # 1. Path relativo dalla root vault
    p = VAULT_ROOT / rel_path
    if p.exists():
        return p

    # 2. In allegati/
    p = ATTACH_ROOT / Path(rel_path).name
    if p.exists():
        return p

    # 3. Fallback: cerca per nome in tutto il vault
    name = Path(rel_path).name
    matches = list(VAULT_ROOT.rglob(name))
    if matches:
        return matches[0]
    return None


def asset_to_data_uri(p: Path) -> str:
    """Converte un file in data URI base64 (per HTML self-contained)."""
    mime, _ = mimetypes.guess_type(str(p))
    if mime is None:
        mime = "application/octet-stream"
    data = p.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def get_image_size(p: Path) -> tuple[int, int] | None:
    """Restituisce (width, height) dell'immagine, None se illeggibile."""
    if not HAS_PIL:
        return None
    try:
        with Image.open(p) as im:
            return im.size
    except Exception:
        return None


def fetch_url_to_data_uri(url: str, timeout: float = 10.0) -> str | None:
    """Scarica una URL e la converte in data URI; None se errore."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            mime = resp.headers.get_content_type() or "image/jpeg"
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, Exception):
        return None


def render_preview_pages(pdf_path: Path, out_dir: Path, dpi: int = 96):
    """Render each PDF page as a PNG image using PyMuPDF.
    Returns list of Path to the generated PNG files (one per page)."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("[WARN] PyMuPDF not installed; preview pages unavailable. pip install PyMuPDF", flush=True)
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf_path))
    paths = []
    try:
        for i in range(doc.page_count):
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            p = out_dir / f"page-{i+1:03d}.png"
            pix.save(str(p))
            paths.append(p)
    finally:
        doc.close()
    return paths


def extract_pdf_blocks(pdf_path: Path, dpi: int = 96):
    """Return per-page text blocks with bounding boxes in PNG pixel coordinates.
    Used by the splicing UI to overlay clickable scissors between text blocks.

    Returns list of {page: 1-indexed, blocks: [{x, y, w, h, text, lines}, ...]}.
    The PDF coordinates are in points (72 DPI); convert to pixels at `dpi`.
    """
    try:
        import fitz
    except ImportError:
        return []
    scale = dpi / 72.0
    doc = fitz.open(str(pdf_path))
    out = []
    try:
        for i in range(doc.page_count):
            page = doc.load_page(i)
            page_h_px = page.rect.height * scale
            page_w_px = page.rect.width * scale
            raw_blocks = page.get_text("blocks") or []
            blocks = []
            for b in raw_blocks:
                x0, y0, x1, y1, text = b[0], b[1], b[2], b[3], (b[4] or "")
                if not text.strip():
                    continue
                blocks.append({
                    "x": round(x0 * scale, 1),
                    "y": round(y0 * scale, 1),
                    "w": round((x1 - x0) * scale, 1),
                    "h": round((y1 - y0) * scale, 1),
                    "text": text.strip()[:80],
                })
            # Sort by reading order (top-to-bottom, left-to-right)
            blocks.sort(key=lambda b: (b["y"], b["x"]))
            out.append({
                "page": i + 1,
                "page_w": round(page_w_px, 1),
                "page_h": round(page_h_px, 1),
                "blocks": blocks,
            })
    finally:
        doc.close()
    return out


def match_blocks_to_html_indices(pdf_blocks, body_html_with_markers):
    """Match each PDF text block to a top-level HTML child index.
    Approach: walk top-level HTML children, extract their visible plain text,
    and match the start of each PDF block to whichever HTML index has the
    closest text prefix. Simple and good enough for splicing.

    Returns the same per-page structure but each block gets an extra "htmlIdx"
    field (or None if no match).
    """
    import re as _re
    # Extract plain text of each top-level child of .document-body
    # Find the .document-body section
    body_match = _re.search(r'<div class="document-body[^"]*">(.*?)</div>\s*(?=<div class="ef-footer|</article|</body)',
                            body_html_with_markers, _re.DOTALL)
    body_inner = body_match.group(1) if body_match else body_html_with_markers

    # Greedy split of top-level tags
    top_tag = _re.compile(r"<(p|h[1-6]|blockquote|ul|ol|div|table|figure|pre|hr|aside)\b", _re.IGNORECASE)
    children_text = []  # list of (htmlIdx, normalized_text_prefix)
    i = 0
    block_idx = 0
    while i < len(body_inner):
        m = top_tag.search(body_inner, i)
        if not m:
            break
        # Find the closing tag (balanced)
        tag_name = m.group(1).lower()
        # CRITICAL: skip <div class="page-break"> markers — they're internal
        # markup inserted by the user's splicing choices and must NOT shift the
        # block index. If we counted them, every re-render would invalidate
        # the user's prior break selections.
        if tag_name == 'div':
            open_tag_end = body_inner.find('>', m.end())
            if open_tag_end != -1:
                open_tag = body_inner[m.start():open_tag_end + 1]
                if 'class="page-break"' in open_tag or "class='page-break'" in open_tag:
                    i = open_tag_end + 1
                    continue
        if tag_name == 'hr':
            children_text.append((block_idx, ''))
            block_idx += 1
            i = m.end()
            continue
        # Find the matching end tag
        end_pat = _re.compile(rf'</{tag_name}\s*>', _re.IGNORECASE)
        depth = 1
        cur = m.end()
        # Skip nested opens of same tag (for divs)
        while depth > 0 and cur < len(body_inner):
            open_m = _re.search(rf'<{tag_name}\b', body_inner[cur:], _re.IGNORECASE)
            close_m = end_pat.search(body_inner, cur)
            if not close_m:
                cur = len(body_inner)
                break
            if open_m and (cur + open_m.start()) < close_m.start():
                depth += 1
                cur = cur + open_m.end()
            else:
                depth -= 1
                cur = close_m.end()
                if depth == 0:
                    break
        chunk = body_inner[m.start():cur]
        plain = _re.sub(r'<[^>]+>', ' ', chunk)
        plain = _re.sub(r'\s+', ' ', plain).strip()
        children_text.append((block_idx, plain[:120]))
        block_idx += 1
        i = cur

    # Now for each PDF block, find best matching HTML child by text prefix
    def normalize(s):
        return _re.sub(r'\s+', ' ', (s or '').strip().lower())

    for page in pdf_blocks:
        for block in page["blocks"]:
            btext = normalize(block.get("text", ""))[:50]
            if not btext:
                block["htmlIdx"] = None
                continue
            # Find first HTML child whose text contains the block text (or vice versa)
            best = None
            for h_idx, h_text in children_text:
                h_norm = normalize(h_text)
                if not h_norm:
                    continue
                # Check if block text appears in HTML text or HTML starts with block text
                if h_norm.startswith(btext[:20]) or btext[:20] in h_norm[:200]:
                    best = h_idx
                    break
            block["htmlIdx"] = best
    return pdf_blocks


# ============================================================
#   WIKILINK EMBED PARSER  ![[file|param|param|...]]
# ============================================================
# Match ![[ ... ]] permettendo singoli ] dentro (es. ![[file|[link](url)|...]])
# Strategia: cattura tutto fino al `]]` (greedy) sulla stessa riga.
WIKILINK_EMBED_RE = re.compile(r"!\[\[(.+?)\]\](?!\])")


def parse_embed_params(parts: list[str]) -> dict:
    """Distingue caption / align / width / height nei pipe-separated params.
    Regola:
      - se è 'left'/'right'/'center' -> align
      - se è un intero puro -> dimensione (prima width, poi height)
      - altrimenti -> caption (concatenate se più di una)
    """
    out = {"caption": None, "align": None, "width": None, "height": None}
    captions = []
    dims = []
    for raw in parts:
        s = raw.strip()
        if not s:
            continue
        low = s.lower()
        if low in ("left", "right", "center"):
            out["align"] = low
        elif s.isdigit():
            dims.append(int(s))
        else:
            captions.append(s)
    if dims:
        out["width"] = dims[0]
        if len(dims) > 1:
            out["height"] = dims[1]
    if captions:
        out["caption"] = " | ".join(captions)
    return out


def render_inline_md_to_html(text: str) -> str:
    """Converte una stringa di markdown inline (link, bold, italic) in HTML."""
    if not text:
        return ""
    html = markdown.markdown(text, extensions=[])
    # rimuovi <p> wrapper
    html = re.sub(r"^\s*<p>(.*)</p>\s*$", r"\1", html, flags=re.DOTALL)
    return html


def make_embed_html(file_ref: str, params: dict) -> str:
    """Genera l'HTML per un embed immagine in stile Obsidian view mode."""
    asset = resolve_asset(file_ref)
    if asset is None:
        return f'<span class="internal-embed image-embed is-broken">!!![{html_lib.escape(file_ref)}]</span>'

    src = asset_to_data_uri(asset)
    align = params.get("align")
    width = params.get("width")
    height = params.get("height")
    caption = params.get("caption")

    # Default: portrait/sized images senza align esplicito → float right (come Obsidian view mode)
    effective_align = align
    if effective_align is None and width:
        effective_align = "right"
    align_class = f" img-align-{effective_align}" if effective_align else ""
    embed_classes = f"internal-embed image-embed is-loaded{align_class}"

    img_style_parts = []
    if width:
        img_style_parts.append(f"width:{width}px")
        img_style_parts.append("max-width:100%")
    if height:
        img_style_parts.append(f"height:{height}px")
    else:
        img_style_parts.append("height:auto")
    img_style = f' style="{";".join(img_style_parts)}"' if img_style_parts else ""
    img_attrs = [f'src="{src}"', f'alt="{html_lib.escape(file_ref)}"']
    img_tag = f'<img {" ".join(img_attrs)}{img_style}>'

    # Calcola altezza renderizzata per riservare spazio float (evita clipping al page break)
    min_h_px = None
    if width:
        size = get_image_size(asset)
        if size:
            nat_w, nat_h = size
            display_h = int(width * (nat_h / nat_w))
            # Aggiungi spazio per caption (line-height 1.4 * 0.85em ≈ 17px per riga + padding)
            min_h_px = display_h + (40 if caption else 0)

    wrapper_style_parts = []
    if width:
        wrapper_style_parts.append(f"width:{width}px")
        wrapper_style_parts.append("max-width:100%")
    wrapper_style = f' style="{";".join(wrapper_style_parts)}"' if wrapper_style_parts else ""


    if caption:
        caption_html = render_inline_md_to_html(caption)
        figure = (
            f'<figure class="image-captions-figure">'
            f"{img_tag}"
            f'<figcaption class="image-captions-caption">{caption_html}</figcaption>'
            f"</figure>"
        )
    else:
        figure = img_tag

    data_h_attr = f' data-float-height="{min_h_px}"' if min_h_px else ""
    return (
        f'<div class="{embed_classes}"{wrapper_style}{data_h_attr} '
        f'data-src="{html_lib.escape(file_ref)}" '
        f'data-alt="{html_lib.escape(file_ref)}">'
        f"{figure}"
        f"</div>"
    )


class WikilinkEmbedPreprocessor(Preprocessor):
    """Sostituisce ![[...]] con placeholder HTML prima del parsing markdown."""

    PLACEHOLDER_FMT = "WIKILINKEMBEDPLACEHOLDER{:03d}WIKILINKEND"

    def __init__(self, md, storage: list):
        super().__init__(md)
        self.storage = storage

    def run(self, lines):
        text = "\n".join(lines)

        def repl(m):
            inner = m.group(1)
            parts = inner.split("|")
            file_ref = parts[0].strip()
            params = parse_embed_params(parts[1:]) if len(parts) > 1 else {}
            html = make_embed_html(file_ref, params)
            idx = len(self.storage)
            self.storage.append(html)
            # avvolgi il placeholder con \n\n così markdown lo tratta come paragrafo a sé:
            # il body text che lo segue diventa un <p> separato e il float wrappa
            return "\n\n" + self.PLACEHOLDER_FMT.format(idx) + "\n\n"

        text = WIKILINK_EMBED_RE.sub(repl, text)
        return text.split("\n")


CALLOUT_ICONS = {
    "note": "\U0001f4dd", "info": "\u2139\ufe0f",
    "abstract": "\U0001f4cb", "summary": "\U0001f4cb", "tldr": "\U0001f4cb",
    "tip": "\U0001f4a1", "hint": "\U0001f4a1", "important": "\u26a1",
    "success": "\u2705", "check": "\u2705", "done": "\u2705",
    "question": "\u2753", "help": "\u2753", "faq": "\u2753",
    "warning": "\u26a0\ufe0f", "caution": "\u26a0\ufe0f", "attention": "\u26a0\ufe0f",
    "failure": "\u274c", "fail": "\u274c", "missing": "\u274c",
    "danger": "\U0001f6d1", "error": "\U0001f6d1",
    "bug": "\U0001f41b",
    "example": "\U0001f4d1",
    "quote": "\u275d", "cite": "\u275d",
    "todo": "\u2611\ufe0f",
}

CALLOUT_HEAD_RE = re.compile(r"^>\s*\[!([a-zA-Z][a-zA-Z0-9_-]*)\]([+-]?)\s*(.*)$")


class CalloutPreprocessor(Preprocessor):
    """Converte le callout di Obsidian (`> [!type] Titolo`) in HTML inline."""
    PLACEHOLDER_FMT = "OBSCALLOUTPLACEHOLDER{:03d}CALLOUTEND"

    def __init__(self, md, storage):
        super().__init__(md)
        self.storage = storage

    def run(self, lines):
        out = []
        i = 0
        n = len(lines)
        while i < n:
            m = CALLOUT_HEAD_RE.match(lines[i])
            if not m:
                out.append(lines[i])
                i += 1
                continue
            ctype = m.group(1).lower()
            title = m.group(3).strip()
            content_lines = []
            i += 1
            while i < n and lines[i].startswith(">"):
                stripped = re.sub(r"^>\s?", "", lines[i])
                content_lines.append(stripped)
                i += 1
            content_md = "\n".join(content_lines)
            content_html = markdown.markdown(
                content_md,
                extensions=["tables", "fenced_code", "sane_lists", "attr_list"],
            ) if content_md.strip() else ""
            display_title = title if title else ctype.replace("_", " ").title()
            title_html = render_inline_md_to_html(display_title)
            icon = CALLOUT_ICONS.get(ctype, CALLOUT_ICONS["note"])
            html = (
                f'<div class="callout" data-callout="{ctype}">'
                f'<div class="callout-title">'
                f'<span class="callout-icon">{icon}</span>'
                f'<span class="callout-title-inner">{title_html}</span>'
                f'</div>'
                f'<div class="callout-content">{content_html}</div>'
                f'</div>'
            )
            idx = len(self.storage)
            self.storage.append(html)
            # Buffer blank lines before/after così Markdown lo tratta come paragrafo singolo
            out.append("")
            out.append(self.PLACEHOLDER_FMT.format(idx))
            out.append("")
        return out


class CalloutExtension(Extension):
    def __init__(self, storage):
        super().__init__()
        self.storage = storage

    def extendMarkdown(self, md):
        md.preprocessors.register(CalloutPreprocessor(md, self.storage), "obscallout", 32)


class EmbedPostprocessor:
    """Reinserisce gli HTML degli embed sostituendo i placeholder
    e rimuove i <p> ridondanti che li avvolgono se sono soli sulla riga."""

    def __init__(self, storage: list):
        self.storage = storage

    def run(self, html: str) -> str:
        for i, snippet in enumerate(self.storage):
            placeholder = WikilinkEmbedPreprocessor.PLACEHOLDER_FMT.format(i)
            html = html.replace(placeholder, snippet)
        return html


# ============================================================
#   embed code block (link metadata card)
# ============================================================
EMBED_BLOCK_RE = re.compile(r"```embed\n(.*?)\n```", re.DOTALL)


def render_embed_card(yaml_text: str) -> str:
    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    title = html_lib.escape(str(data.get("title", "")))
    desc = html_lib.escape(str(data.get("description", "")))
    url = str(data.get("url", "#"))
    img = data.get("image", "")

    img_html = ""
    if img:
        # Scarica e inlinea l'immagine così WeasyPrint la renderizza
        data_uri = fetch_url_to_data_uri(img)
        bg_url = data_uri if data_uri else img
        img_html = f'<div class="embed-card-image" style="background-image:url({bg_url});"></div>'

    return (
        f'<a class="embed-card" href="{html_lib.escape(url)}" target="_blank" rel="noopener">'
        f"{img_html}"
        f'<div class="embed-card-body">'
        f'<div class="embed-card-title">{title}</div>'
        f'<div class="embed-card-desc">{desc}</div>'
        f'<div class="embed-card-url">{html_lib.escape(url)}</div>'
        f"</div>"
        f"</a>"
    )


class EmbedBlockPreprocessor(Preprocessor):
    PLACEHOLDER_FMT = "EMBEDBLOCKPLACEHOLDER{:03d}EMBEDBLOCKEND"

    def __init__(self, md, storage: list):
        super().__init__(md)
        self.storage = storage

    def run(self, lines):
        text = "\n".join(lines)

        def repl(m):
            html = render_embed_card(m.group(1))
            idx = len(self.storage)
            self.storage.append(html)
            return "\n\n" + self.PLACEHOLDER_FMT.format(idx) + "\n\n"

        text = EMBED_BLOCK_RE.sub(repl, text)
        return text.split("\n")


class EmbedBlockExtension(Extension):
    def __init__(self, storage):
        super().__init__()
        self.storage = storage

    def extendMarkdown(self, md):
        md.preprocessors.register(EmbedBlockPreprocessor(md, self.storage), "embedblock", 30)


class WikilinkEmbedExtension(Extension):
    def __init__(self, storage):
        super().__init__()
        self.storage = storage

    def extendMarkdown(self, md):
        md.preprocessors.register(WikilinkEmbedPreprocessor(md, self.storage), "wikilinkembed", 28)


# ============================================================
#   FRONTMATTER  ---  ---
# ============================================================
def split_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.DOTALL)
    if not m:
        return {}, text
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        fm = {}
    body = text[m.end():]
    return fm, body


# ============================================================
#   PALETTE DEI TEMI
# ============================================================
THEMES = {
    "dark-kanagawa": {
        "bg": "#1f1f28", "bg_soft": "#2a2a37",
        "text": "#dcd7ba", "text_muted": "#8a8784",
        "accent": "#7e9cd8", "link": "#98bb6c",
        "strong": "#ffa066", "em": "#c0a36e",
        "quote_border": "#957fb8", "quote_bg": "rgba(149,127,184,0.10)",
        "table_border": "rgba(220,215,186,0.18)",
        "code_bg": "#2a2a37", "code_fg": "#ffa066",
        "banner_fade_rgb": "31,31,40",
    },
    "dark-dracula": {
        "bg": "#282a36", "bg_soft": "#343746",
        "text": "#f8f8f2", "text_muted": "#9aa0aa",
        "accent": "#bd93f9", "link": "#50fa7b",
        "strong": "#ff79c6", "em": "#f1fa8c",
        "quote_border": "#bd93f9", "quote_bg": "rgba(189,147,249,0.12)",
        "table_border": "rgba(248,248,242,0.18)",
        "code_bg": "#343746", "code_fg": "#ff79c6",
        "banner_fade_rgb": "40,42,54",
    },
    "dark-nord": {
        "bg": "#2e3440", "bg_soft": "#3b4252",
        "text": "#eceff4", "text_muted": "#9aa3b0",
        "accent": "#88c0d0", "link": "#a3be8c",
        "strong": "#d08770", "em": "#ebcb8b",
        "quote_border": "#b48ead", "quote_bg": "rgba(180,142,173,0.12)",
        "table_border": "rgba(236,239,244,0.18)",
        "code_bg": "#3b4252", "code_fg": "#d08770",
        "banner_fade_rgb": "46,52,64",
    },
    "light-paper": {
        "bg": "#fdfaf1", "bg_soft": "#f3eedd",
        "text": "#2a2a28", "text_muted": "#6a6864",
        "accent": "#4a5b87", "link": "#5a7e3a",
        "strong": "#c25a1f", "em": "#7d6a3a",
        "quote_border": "#a07ec6", "quote_bg": "rgba(160,126,198,0.10)",
        "table_border": "rgba(42,42,40,0.15)",
        "code_bg": "#f3eedd", "code_fg": "#c25a1f",
        "banner_fade_rgb": "253,250,241",
    },
    "light-solarized": {
        "bg": "#fdf6e3", "bg_soft": "#eee8d5",
        "text": "#586e75", "text_muted": "#93a1a1",
        "accent": "#268bd2", "link": "#859900",
        "strong": "#cb4b16", "em": "#b58900",
        "quote_border": "#6c71c4", "quote_bg": "rgba(108,113,196,0.10)",
        "table_border": "rgba(88,110,117,0.18)",
        "code_bg": "#eee8d5", "code_fg": "#cb4b16",
        "banner_fade_rgb": "253,246,227",
    },
    "light-gruvbox": {
        "bg": "#fbf1c7", "bg_soft": "#ebdbb2",
        "text": "#3c3836", "text_muted": "#7c6f64",
        "accent": "#458588", "link": "#79740e",
        "strong": "#af3a03", "em": "#b57614",
        "quote_border": "#8f3f71", "quote_bg": "rgba(143,63,113,0.10)",
        "table_border": "rgba(60,56,54,0.18)",
        "code_bg": "#ebdbb2", "code_fg": "#af3a03",
        "banner_fade_rgb": "251,241,199",
    },
    # ---- Minimal: cromia neutra, l'accent è l'unico colore ----
    "minimal-dark": {
        "bg": "#000000", "bg_soft": "#0d0d10",
        "text": "#e6e3dc", "text_muted": "#7e7e83",
        "accent": "#7f6df2", "link": "#7f6df2",
        "strong": "#ffffff", "em": "#c6c4be",
        "quote_border": "#3a3d44", "quote_bg": "rgba(255,255,255,0.04)",
        "table_border": "rgba(230,227,220,0.14)",
        "code_bg": "#0d0d10", "code_fg": "#e6e3dc",
        "banner_fade_rgb": "0,0,0",
        "_minimal": True,
    },
    "minimal-light": {
        "bg": "#fafaf7", "bg_soft": "#f1f0ec",
        "text": "#26262a", "text_muted": "#7e7e83",
        "accent": "#7f6df2", "link": "#7f6df2",
        "strong": "#000000", "em": "#3a3a3e",
        "quote_border": "#d9d7d1", "quote_bg": "rgba(0,0,0,0.03)",
        "table_border": "rgba(38,38,42,0.12)",
        "code_bg": "#f1f0ec", "code_fg": "#26262a",
        "banner_fade_rgb": "250,250,247",
        "_minimal": True,
    },
}
DEFAULT_THEME = "dark-kanagawa"


def get_theme(name: str) -> dict:
    return THEMES.get(name, THEMES[DEFAULT_THEME])


# ============================================================
#   CSS BUNDLE
# ============================================================
def build_css(banner_src, banner_x: int, banner_y: int, theme_name: str = DEFAULT_THEME, accent_override: str = None, font_size: int = 16, bg_override: str = None, margin_h: float = 2.2, margin_v: float = 1.6, page_numbers: bool = False) -> str:
    banner_block = ""
    if banner_src:
        banner_block = f"""
.banner-container {{
  position: relative;
  width: 100%;
  height: 380px;
  margin: 0;
  overflow: hidden;
  page-break-inside: avoid;
  break-inside: avoid;
}}
.pixel-banner-image {{
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background-image: url('{banner_src}');
  background-size: cover;
  background-repeat: no-repeat;
  background-position: {banner_x}% {banner_y}%;
  opacity: 1;
}}
.banner-fade {{
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(to bottom,
    rgba(BANNERFADEPLACEHOLDER,0) 0%,
    rgba(BANNERFADEPLACEHOLDER,0) 55%,
    rgba(BANNERFADEPLACEHOLDER,0.75) 85%,
    rgba(BANNERFADEPLACEHOLDER,1) 100%);
  pointer-events: none;
}}
"""
    theme = dict(get_theme(theme_name))  # copia per non mutare il dict globale
    if accent_override:
        theme["accent"] = accent_override
        theme["link"] = accent_override
    if bg_override:
        theme["bg"] = bg_override
        theme["bg_soft"] = shift_color(bg_override, 0.05)
        theme["code_bg"] = theme["bg_soft"]
        r, g, b = _hex_to_rgb(bg_override)
        theme["banner_fade_rgb"] = f"{r},{g},{b}"
    theme_vars = (
        f"--bg: {theme['bg']};"
        f"--bg-soft: {theme['bg_soft']};"
        f"--text: {theme['text']};"
        f"--text-muted: {theme['text_muted']};"
        f"--accent: {theme['accent']};"
        f"--link: {theme['link']};"
        f"--strong: {theme['strong']};"
        f"--em: {theme['em']};"
        f"--quote-border: {theme['quote_border']};"
        f"--quote-bg: {theme['quote_bg']};"
        f"--table-border: {theme['table_border']};"
        f"--code-bg: {theme['code_bg']};"
        f"--code-fg: {theme['code_fg']};"
    )
    rendered_banner = banner_block.replace("BANNERFADEPLACEHOLDER", theme["banner_fade_rgb"]) if banner_block else ""
    css = r"""
/* Palette tema corrente */
:root { __THEME_VARS__ }

@page {
  size: A4;
  margin: 0 0 __PAGE_BOTTOM__ 0;
  __PAGE_NUMBER_RULE__
}

*,*::before,*::after {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif;
  font-size: __FONT_SIZE__px;
  line-height: 1.6;
  position: relative;
}

.view-content {
  position: relative;
  width: 100%;
  min-height: 100vh;
}

.markdown-preview-sizer {
  position: relative;
  padding: 0;
  margin: 0 auto;
  max-width: 100%;
}
.document-body, .mod-header.mod-ui, .tag-row {
  max-width: 880px;
  margin-left: auto;
  margin-right: auto;
  padding-left: __MH__cm;
  padding-right: __MH__cm;
}
.mod-header.mod-ui { padding-top: 1.4em; }
.document-body { padding-bottom: __MV__cm; padding-left: __MH__cm; padding-right: __MH__cm; }

""" + rendered_banner + r"""

/* ---- mod-header / inline title ------- */
.mod-header.mod-ui {
  margin-bottom: 0.2em;
  padding-top: 0.6em;
  position: relative;
  z-index: 2;
}
.inline-title {
  font-size: 2.4em;
  font-weight: 700;
  margin: 0 0 0.2em 0;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--text);
}

/* ---- tags ---- */
.tag-row {
  margin-bottom: 1.6em;
  font-size: 0.85em;
}
.tag {
  display: inline-block;
  background: rgba(126,156,216,0.12);
  color: var(--accent);
  padding: 1px 8px;
  border-radius: 999px;
  margin-right: 4px;
  text-decoration: none;
}

/* ---- typography ---- */
h1, h2, h3, h4, h5, h6 {
  font-weight: 700;
  line-height: 1.25;
  margin-top: 1.4em;
  margin-bottom: 0.5em;
  clear: both;
  page-break-after: avoid;
  break-after: avoid;
}
h1 { font-size: 1.7em; border-bottom: 1px solid var(--table-border); padding-bottom: 0.2em; }
/* Primo H1 = titolo nota: complementare al banner, slegato dal flusso del body */
.document-body > h1:first-child,
.document-body > h1:first-of-type {
  font-size: 2.8em;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-weight: 700;
  border-bottom: none;
  padding-bottom: 0;
  margin-top: -1.2em;          /* alza il titolo verso la fascia bassa del banner */
  margin-bottom: 0.8em;
  position: relative;
  z-index: 3;
  color: var(--text);
}
/* Subtitolo: primo blockquote subito dopo il titolo viene stilizzato come abstract hero */
.document-body > h1:first-of-type + blockquote {
  border-left: none;
  background: transparent;
  margin: 0 0 1.4em 0;
  padding: 0 0 0.4em 0;
  font-size: 1.1em;
  font-style: italic;
  color: var(--text-muted);
  border-bottom: 1px solid var(--table-border);
  border-radius: 0;
}
.document-body > h1:first-of-type + blockquote p { font-style: italic; }

/* ====== Obsidian Callouts ====== */
.callout {
  border-left: 4px solid var(--accent);
  background: var(--bg-soft);
  padding: 12px 16px;
  margin: 1em 0;
  border-radius: 0 6px 6px 0;
  page-break-inside: avoid;
  break-inside: avoid;
}
.callout-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text);
}
.callout-icon { font-size: 1.1em; line-height: 1; }
.callout-title-inner { line-height: 1.3; }
.callout-content { font-size: 0.95em; line-height: 1.55; }
.callout-content > :first-child { margin-top: 0; }
.callout-content > :last-child { margin-bottom: 0; }

/* ====== User-controlled pagination helpers ======
   Add these as raw HTML in your markdown to control where pages break. */
.page-break, .pagebreak, .new-page { page-break-before: always; break-before: page; height: 0; margin: 0; padding: 0; visibility: hidden; }
.no-break, .keep-together { page-break-inside: avoid; break-inside: avoid; }
.page-break-after { page-break-after: always; break-after: page; }
.callout-content p { margin: 0.5em 0; }
.callout-content ul, .callout-content ol { margin: 0.4em 0; padding-left: 1.4em; }

/* Type-specific accent colors */
.callout[data-callout="note"], .callout[data-callout="info"], .callout[data-callout="todo"] { border-left-color: #448aff; }
.callout[data-callout="abstract"], .callout[data-callout="summary"], .callout[data-callout="tldr"] { border-left-color: #00bcd4; }
.callout[data-callout="tip"], .callout[data-callout="hint"], .callout[data-callout="important"] { border-left-color: #00bfa6; }
.callout[data-callout="success"], .callout[data-callout="check"], .callout[data-callout="done"] { border-left-color: #00c853; }
.callout[data-callout="question"], .callout[data-callout="help"], .callout[data-callout="faq"] { border-left-color: #64dd17; }
.callout[data-callout="warning"], .callout[data-callout="caution"], .callout[data-callout="attention"] { border-left-color: #ff9100; }
.callout[data-callout="failure"], .callout[data-callout="fail"], .callout[data-callout="missing"] { border-left-color: #ff5252; }
.callout[data-callout="danger"], .callout[data-callout="error"] { border-left-color: #ff1744; }
.callout[data-callout="bug"] { border-left-color: #f50057; }
.callout[data-callout="example"] { border-left-color: #7c4dff; }
.callout[data-callout="quote"], .callout[data-callout="cite"] { border-left-color: var(--text-muted); }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }

p { margin: 0.6em 0; }

strong { color: var(--strong); }
em { color: var(--em); font-style: italic; }

a {
  color: var(--link);
  text-decoration: none;
  border-bottom: 1px dotted var(--link);
}
a:hover { border-bottom-style: solid; }

/* ---- blockquote ---- */
blockquote {
  border-left: 3px solid var(--quote-border);
  background: var(--quote-bg);
  margin: 1em 0;
  padding: 0.6em 1em;
  color: var(--text);
  border-radius: 0 6px 6px 0;
  page-break-inside: avoid;
  break-inside: avoid;
}
blockquote p { margin: 0; }

/* ---- code ---- */
code {
  background: var(--code-bg);
  color: var(--code-fg);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: "JetBrains Mono","Fira Code","Cascadia Code",monospace;
  font-size: 0.9em;
}
pre {
  background: var(--code-bg);
  padding: 1em;
  border-radius: 6px;
  overflow-x: auto;
}
pre code { background: transparent; padding: 0; }

/* ---- TABLE ---- */
table {
  border-collapse: collapse;
  width: 100%;
  margin: 1.2em 0;
  font-size: 0.92em;
  page-break-inside: avoid;
  break-inside: avoid;
}
th, td {
  border: 1px solid var(--table-border);
  padding: 0.5em 0.7em;
  text-align: left;
  vertical-align: top;
}
th {
  background: rgba(126,156,216,0.08);
  font-weight: 600;
}
tr:nth-child(even) td { background: rgba(255,255,255,0.015); }

/* ---- LISTS ---- */
ul, ol { padding-left: 1.4em; }
li { margin: 0.25em 0; }

/* ====== IMAGE EMBEDS — replica image-captions-fix.css ======
   La nostra HTML usa <span.internal-embed.image-embed.is-loaded>
   come parent dell'immagine, con .img-align-* per i float. */

.internal-embed.image-embed.is-loaded {
  display: block;
  padding: 0;
  background: transparent;
  margin: 0.4em 0;
  max-width: 100%;
  page-break-inside: avoid;
  break-inside: avoid;
}
.image-captions-figure {
  page-break-inside: avoid;
  break-inside: avoid;
}

.image-captions-figure {
  display: block;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  max-width: 100%;
}
.image-captions-figure img {
  display: block;
  margin: 0;
  border-radius: 4px;
  height: auto;
  max-width: 100%;
}
.image-captions-caption {
  display: block;
  text-align: left;
  padding: 6px 2px 0;
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85em;
  line-height: 1.4;
  background: transparent;
}

/* Float anchor: ora è un semplice wrapper, NIENTE flow-root.
   In questo modo il float esce dal wrapper, i paragrafi successivi possono
   wrappare naturalmente attorno e WeasyPrint può paginare tra paragrafi.
   La protezione anti-clip rimane su .image-captions-figure (immagine+caption
   stanno sempre insieme). */
.float-anchor {
  display: block;
}

/* float align: wrapper ha width inline da make_embed_html */
.internal-embed.image-embed.img-align-right {
  float: right;
  margin: 0.4em 0 0.6em 1.2em;
}
.internal-embed.image-embed.img-align-left {
  float: left;
  margin: 0.4em 1.2em 0.6em 0;
}
.internal-embed.image-embed.img-align-center {
  float: none;
  margin: 1em auto;
}
.internal-embed.image-embed.img-align-center .image-captions-figure,
.internal-embed.image-embed.img-align-center .image-captions-caption {
  text-align: center;
}

/* ---- embed link card (```embed) ---- */
.embed-card {
  display: flex;
  flex-direction: row;
  gap: 12px;
  margin: 1.2em 0;
  padding: 0;
  background: var(--bg-soft);
  border: 1px solid var(--table-border);
  border-radius: 8px;
  overflow: hidden;
  text-decoration: none;
  color: var(--text);
  border-bottom: none;
  page-break-inside: avoid;
  break-inside: avoid;
}
.embed-card-image {
  flex: 0 0 180px;
  min-height: 110px;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.embed-card-body {
  padding: 10px 12px;
  flex: 1;
  min-width: 0;
}
.embed-card-title {
  font-weight: 700;
  margin-bottom: 4px;
  line-height: 1.25;
}
.embed-card-desc {
  font-size: 0.85em;
  color: var(--text-muted);
  margin-bottom: 6px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.embed-card-url {
  font-size: 0.75em;
  color: var(--text-muted);
  word-break: break-all;
}

/* ---- footnotes ---- */
.footnote {
  font-size: 0.85em;
  color: var(--text-muted);
}
.footnote-ref { font-size: 0.75em; vertical-align: super; }
.footnote-backref { font-size: 0.85em; text-decoration: none; }
hr.footnotes-sep,
.footnote hr,
section.footnotes hr {
  border: none;
  border-top: 1px solid var(--table-border);
  margin: 2em 0 1em;
}
.footnote ol, section.footnotes ol { padding-left: 1.2em; }
"""
    css = css.replace("__THEME_VARS__", theme_vars)
    css = css.replace("__FONT_SIZE__", str(font_size))
    css = css.replace("__MH__", str(margin_h))
    css = css.replace("__MV__", str(margin_v))
    if page_numbers:
        css = css.replace("__PAGE_BOTTOM__", "1cm")
        css = css.replace("__PAGE_NUMBER_RULE__",
            '@bottom-center { content: counter(page); font-size: 10pt; color: ' + theme['text_muted'] + '; font-family: sans-serif; }')
    else:
        css = css.replace("__PAGE_BOTTOM__", "0")
        css = css.replace("__PAGE_NUMBER_RULE__", "")
    return css


# ============================================================
#   MAIN RENDERER
# ============================================================
HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
{css}
</style>
</head>
<body>
<div class="view-content pixel-banner">
  <div class="markdown-reading-view">
    <div class="markdown-preview-view markdown-rendered">
      <div class="markdown-preview-sizer markdown-preview-section">
        {banner_div}
        {header_block}
        {tag_row}
        <div class="document-body">
          {body_html}
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>
"""



def wrap_floats_for_pagination(html: str) -> str:
    """Avvolge ogni float (img-align-left/right) e i paragrafi/blockquote
    che lo seguono in un container .float-anchor con display: flow-root
    e break-inside: avoid. WeasyPrint sposta l'intero blocco alla pagina
    successiva se non ci sta, evitando clipping della caption.

    Numero di paragrafi inclusi: heuristic basata sull'altezza min-height
    del float (codificata nello style del div) — proviamo a includere
    abbastanza paragrafi da coprirla, max 4.
    """
    # Match: <div class="internal-embed image-embed is-loaded img-align-(left|right)"...
    #        style="...min-height:NNpx..." ...>...</div>
    pattern = re.compile(
        r'(<div class="internal-embed image-embed is-loaded img-align-(?:left|right)"'
        r'(?:[^>]*data-float-height="(\d+)")?'
        r'[^>]*>.*?</div>)',
        re.DOTALL,
    )

    def consume_following_blocks(rest_html: str, target_height: int, float_width_px: int):
        """Consuma paragrafi successivi finché l'altezza stimata del testo che
        wrappa accanto al float copre `target_height`. Modello:
          - colonna a fianco del float = COLUMN_WIDTH - float_width_px
          - chars-per-line @ font 16px ≈ side_col_px / 8
          - line-height ≈ 25.6 px
        Si ferma quando target raggiunto, max 5 paragrafi, o heading/altro float."""
        COLUMN_WIDTH = 700  # px assunti del content body
        side_col = max(120, COLUMN_WIDTH - float_width_px - 30)  # 30 margine
        chars_per_line = max(20, int(side_col / 8))
        line_height = 25.6

        consumed_parts = []
        rest = rest_html
        accumulated = 0
        max_blocks = 5
        for _ in range(max_blocks):
            m_skip = re.match(r"\s+", rest)
            skip = m_skip.group(0) if m_skip else ""
            after_ws = rest[len(skip):]
            # Stop at heading/altro float
            if re.match(r"<h[1-6]", after_ws) or re.match(r'<div class="internal-embed', after_ws):
                break
            m_block = re.match(
                r"(<p>.*?</p>|<blockquote>.*?</blockquote>|<ul>.*?</ul>|<ol>.*?</ol>)",
                after_ws, re.DOTALL,
            )
            if not m_block:
                break
            block = m_block.group(0)
            consumed_parts.append(skip + block)
            rest = after_ws[m_block.end():]
            # Stima altezza wrappata
            text = re.sub(r"<[^>]+>", "", block)
            chars = len(text)
            n_lines = max(1, -(-chars // chars_per_line))  # ceil div
            est_height = n_lines * line_height + 16  # +16 per margini
            accumulated += est_height
            if accumulated >= target_height:
                break
        return "".join(consumed_parts), rest

    out = []
    pos = 0
    for m in pattern.finditer(html):
        # Append text before this match
        out.append(html[pos:m.start()])
        float_html = m.group(1)
        target_h = int(m.group(2)) if m.group(2) else 0
        # Mangia i blocchi successivi
        rest = html[m.end():]
        # Estrai width del float dal style se presente
        fw_m = re.search(r'width:(\d+)px', float_html)
        fw_px = int(fw_m.group(1)) if fw_m else 325
        consumed, leftover = consume_following_blocks(rest, target_h, fw_px)
        out.append(
            '<div class="float-anchor">'
            + float_html
            + consumed
            + "</div>"
        )
        pos = m.end() + (len(rest) - len(leftover))
    out.append(html[pos:])
    return "".join(out)



def filter_orphan_footnotes(body: str) -> str:
    """Rimuove le definizioni `[^N]: ...` per footnote mai referenziate nel body."""
    # Trova tutti i riferimenti [^N] (escluse le definizioni che hanno : dopo)
    referenced = set(re.findall(r"\[\^([\w-]+)\](?!:)", body))
    def keep(match):
        fn_id = match.group(1)
        return match.group(0) if fn_id in referenced else ""
    # Pattern: definizioni [^N]: ... fino alla prossima linea vuota o altra definizione
    return re.sub(
        r"^\[\^([\w-]+)\]:[^\n]*(?:\n(?!\[\^|\n)[^\n]*)*",
        keep,
        body,
        flags=re.MULTILINE,
    )

def export_note(md_path: Path, out_html: Path, out_pdf=None, theme: str = DEFAULT_THEME, accent: str = None, font_size: int = 16, bg: str = None, hide_properties: bool = False, hide_title: bool = False, skip_html: bool = False, page_breaks_before: list = None, margin_h: float = 2.2, margin_v: float = 1.6, page_numbers: bool = False, preview_pages_dir: Path = None):
    raw = md_path.read_text(encoding="utf-8")
    fm, body = split_frontmatter(raw)
    body = filter_orphan_footnotes(body)

    # --- inline title = nome del file (come "Inline title" di Obsidian) ---
    # L'H1 del body resta intatto come heading normale, separato dal titolo della nota.
    inline_title = md_path.stem

    # --- banner ---
    banner_src = None
    banner_path = fm.get("banner")
    if banner_path:
        b_asset = resolve_asset(banner_path)
        if b_asset:
            banner_src = asset_to_data_uri(b_asset)

    banner_x = fm.get("banner-x", 50)
    banner_y = fm.get("banner-y", 50)

    banner_div = ""
    if banner_src:
        banner_div = (
            '<div class="banner-container">'
            '<div class="pixel-banner-image"></div>'
            '<div class="banner-fade"></div>'
            '</div>'
        )

    # --- tags ---
    tag_row = ""
    tags = fm.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    if tags and not hide_properties:
        tag_spans = " ".join(
            f'<a class="tag" href="#">#{html_lib.escape(t)}</a>' for t in tags
        )
        tag_row = f'<div class="tag-row">{tag_spans}</div>'

    # --- markdown -> HTML ---
    wikilink_storage: list[str] = []
    embed_storage: list[str] = []

    callout_storage: list[str] = []
    md_engine = markdown.Markdown(
        extensions=[
            "tables",
            "footnotes",
            "fenced_code",
            "sane_lists",
            "attr_list",
            "md_in_html",
            WikilinkEmbedExtension(wikilink_storage),
            EmbedBlockExtension(embed_storage),
            CalloutExtension(callout_storage),
        ],
        extension_configs={
            "footnotes": {
                "BACKLINK_TEXT": "↩",
            }
        },
    )
    body_html = md_engine.convert(body)

    # Strip <p> wrappers around lone embed placeholders (i blocchi tipo <p>WIKILINKPLACE001WIKILINKEND</p>
    # diventano semplici <div embed/> al di fuori del paragrafo).
    body_html = re.sub(
        r"<p>\s*(WIKILINKEMBEDPLACEHOLDER\d+WIKILINKEND)\s*</p>",
        r"\1",
        body_html,
    )
    body_html = re.sub(
        r"<p>\s*(EMBEDBLOCKPLACEHOLDER\d+EMBEDBLOCKEND)\s*</p>",
        r"\1",
        body_html,
    )
    body_html = re.sub(
        r"<p>\s*(OBSCALLOUTPLACEHOLDER\d+CALLOUTEND)\s*</p>",
        r"\1",
        body_html,
    )

    # reinserisci gli HTML degli embed
    for i, snippet in enumerate(wikilink_storage):
        body_html = body_html.replace(
            WikilinkEmbedPreprocessor.PLACEHOLDER_FMT.format(i), snippet
        )
    for i, snippet in enumerate(embed_storage):
        body_html = body_html.replace(
            EmbedBlockPreprocessor.PLACEHOLDER_FMT.format(i), snippet
        )
    for i, snippet in enumerate(callout_storage):
        body_html = body_html.replace(
            CalloutPreprocessor.PLACEHOLDER_FMT.format(i), snippet
        )

    # --- Wrapping disabilitato: float e paragrafi sono siblings diretti
    # in .document-body, così WeasyPrint può paginare naturalmente. ---
    # body_html = wrap_floats_for_pagination(body_html)

    # --- inserisci page break utente (non-distruttivo, definiti dal preview editor) ---
    if page_breaks_before:
        # Trova i top-level children del body_html (paragrafi, heading, blockquote, callout, embed, ecc.)
        # Approccio semplice: parse via regex sui top-level tag pattern, inserisci marker prima del N-esimo.
        # Per coerenza con l'indicizzazione lato JS, conta tutti i top-level element children.
        sorted_breaks = sorted(set(page_breaks_before))
        # Scorri body_html cercando i tag root e mantieni un counter
        out_parts = []
        i = 0
        block_idx = 0
        # match dei top-level block elements più comuni
        top_tag = re.compile(r"<(p|h[1-6]|blockquote|ul|ol|div|table|figure|pre|hr)\b", re.IGNORECASE)
        while i < len(body_html):
            m = top_tag.search(body_html, i)
            if not m:
                out_parts.append(body_html[i:])
                break
            # append fino al match
            out_parts.append(body_html[i:m.start()])
            if block_idx in sorted_breaks:
                out_parts.append('<div class="page-break"></div>')
            # trova chiusura del tag bilanciata
            tag_name = m.group(1).lower()
            close_tag = f"</{tag_name}>"
            # gestione semplice: cerca il prossimo close_tag al livello corrente
            depth = 1
            search = m.end()
            while depth > 0:
                next_open = body_html.lower().find(f"<{tag_name}", search)
                next_close = body_html.lower().find(close_tag, search)
                if next_close == -1: break
                if next_open != -1 and next_open < next_close:
                    depth += 1
                    search = next_open + len(tag_name) + 1
                else:
                    depth -= 1
                    search = next_close + len(close_tag)
            out_parts.append(body_html[m.start():search])
            i = search
            block_idx += 1
        body_html = "".join(out_parts)

    # --- compose final HTML ---
    css = build_css(banner_src, banner_x, banner_y, theme, accent_override=accent, font_size=font_size, bg_override=bg, margin_h=margin_h, margin_v=margin_v, page_numbers=page_numbers)
    inline_title_html = "" if hide_title else (
        f'<div class="mod-header mod-ui"><div class="inline-title">{html_lib.escape(inline_title)}</div></div>'
    )
    final = HTML_TEMPLATE.format(
        title=html_lib.escape(inline_title),
        css=css,
        banner_div=banner_div,
        header_block=inline_title_html,
        tag_row=tag_row,
        body_html=body_html,
    )

    if not skip_html:
        out_html.write_text(final, encoding="utf-8")
        print(f"[OK] HTML written to {out_html}")
    else:
        print(f"[INFO] HTML output skipped (--no-html)")

    # --- PDF via WeasyPrint ---
    if out_pdf:
        try:
            from weasyprint import HTML, CSS
            HTML(string=final).write_pdf(str(out_pdf))
            print(f"[OK] PDF written to {out_pdf}")
            # Render each PDF page as PNG for accurate preview
            if preview_pages_dir:
                pngs = render_preview_pages(out_pdf, preview_pages_dir, dpi=96)
                for p in pngs:
                    print(f"[PNG] {p}", flush=True)
                # Also extract text-block positions and match to HTML element indices
                # so the splicing UI can overlay clickable scissors between blocks.
                try:
                    import json as _json
                    blocks = extract_pdf_blocks(out_pdf, dpi=96)
                    blocks = match_blocks_to_html_indices(blocks, body_html)
                    blocks_json_path = preview_pages_dir / "_blocks.json"
                    blocks_json_path.write_text(_json.dumps(blocks), encoding="utf-8")
                    print(f"[BLOCKS] {blocks_json_path}", flush=True)
                except Exception as be:
                    print(f"[WARN] Block extraction failed: {be}")
        except Exception as e:
            print(f"[WARN] PDF render failed: {e}")


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Export an Obsidian note (.md) to HTML and PDF, preserving the reading-view rendering."
    )
    parser.add_argument("note", type=Path, nargs="?", default=None, help="Path to the .md file to export")
    parser.add_argument("-o", "--out-dir", type=Path, default=None,
                        help="Output directory (default: <vault>/exports)")
    parser.add_argument("--vault", type=Path, default=None,
                        help="Vault path (default: auto-detect via .obsidian/)")
    parser.add_argument("--no-pdf", action="store_true", help="HTML only, skip PDF")
    parser.add_argument("--no-html", action="store_true", help="Skip writing the HTML file (PDF only)")
    parser.add_argument("--page-breaks", type=str, default="",
                        help="Comma-separated block indexes (children of .document-body) where to insert a page break BEFORE")
    parser.add_argument("--margin-h", type=float, default=2.2, help="Horizontal margin in cm")
    parser.add_argument("--margin-v", type=float, default=1.6, help="Vertical margin in cm")
    parser.add_argument("--page-numbers", action="store_true", help="Show page number at the bottom of each PDF page")
    parser.add_argument("--preview-pages", type=Path, default=None,
                        help="Directory where to also save each PDF page as a PNG image (for accurate previews)")
    parser.add_argument("--from-html", type=Path, default=None,
                        help="Use this HTML file as the export source instead of rendering the markdown (for live-edited previews)")
    parser.add_argument("--theme", type=str, default=DEFAULT_THEME,
                        choices=sorted(THEMES.keys()),
                        help=f"Color palette (default: {DEFAULT_THEME})")
    parser.add_argument("--list-themes", action="store_true",
                        help="Print the list of available themes and exit")
    parser.add_argument("--accent", type=str, default=None,
                        help="Hex color (e.g. #7f6df2) to override accent/link of the theme")
    parser.add_argument("--font-size", type=int, default=16,
                        help="Body font size in px (default: 16)")
    parser.add_argument("--bg", type=str, default=None,
                        help="Hex color (e.g. #000000) to override background of Minimal themes")
    parser.add_argument("--hide-properties", action="store_true",
                        help="Don't render the frontmatter properties (tags and other rendered metadata)")
    parser.add_argument("--hide-title", action="store_true",
                        help="Don't render the note title (inline H1)")
    args = parser.parse_args()

    if args.list_themes:
        for name in sorted(THEMES.keys()):
            print(name)
        return

    if args.note is None:
        parser.error("argument note required (or use --list-themes)")
    note = args.note.resolve()
    if not note.exists():
        print(f"[ERR] Note not found: {note}")
        sys.exit(2)

    vault = args.vault.resolve() if args.vault else find_vault_root(note)
    if vault is None:
        print(f"[ERR] Vault not found (no .obsidian/ directory walking up from {note})")
        print("      Pass the vault explicitly with --vault /path/to/vault")
        sys.exit(2)
    set_vault_root(vault)
    print(f"[INFO] Vault: {vault}")
    print(f"[INFO] Attachments: {ATTACH_ROOT}")
    print(f"[INFO] Theme: {args.theme}")

    out_dir = args.out_dir.resolve() if args.out_dir else (vault / "exports")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_html = out_dir / f"{note.stem}.html"
    out_pdf = None if args.no_pdf else (out_dir / f"{note.stem}.pdf")
    pb = [int(x) for x in args.page_breaks.split(',') if x.strip().isdigit()] if args.page_breaks else None
    if args.from_html:
        from_html_path = args.from_html.resolve()
        if not from_html_path.exists():
            print(f"[ERR] --from-html source not found: {from_html_path}")
            sys.exit(2)
        final = from_html_path.read_text(encoding="utf-8")
        if not args.no_html:
            out_html.write_text(final, encoding="utf-8")
            print(f"[OK] HTML written to {out_html}")
        if out_pdf:
            try:
                from weasyprint import HTML
                HTML(string=final).write_pdf(str(out_pdf))
                print(f"[OK] PDF written to {out_pdf}")
                if args.preview_pages:
                    pngs = render_preview_pages(out_pdf, args.preview_pages, dpi=96)
                    for p in pngs:
                        print(f"[PNG] {p}", flush=True)
            except Exception as e:
                print(f"[WARN] PDF render failed: {e}")
        return
    export_note(note, out_html, out_pdf, theme=args.theme, accent=args.accent, font_size=args.font_size, bg=args.bg, hide_properties=args.hide_properties, hide_title=args.hide_title, skip_html=args.no_html, page_breaks_before=pb, margin_h=args.margin_h, margin_v=args.margin_v, page_numbers=args.page_numbers, preview_pages_dir=args.preview_pages)


if __name__ == "__main__":
    main()
