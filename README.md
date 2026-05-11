# Zixi Jiang Personal Homepage

Static GitHub Pages site for Zixi Jiang.

## Structure

```text
.
├── contents/              # Markdown content loaded by the page
├── source/                # CV and source documents
├── static/
│   ├── assets/img/        # Profile and supporting images
│   ├── css/               # Site styles
│   └── js/                # Markdown/YAML loader and visitor widgets
└── index.html
```

## Local Preview

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

## Editing

- `contents/*.md` controls the main text sections.
- `contents/config.yml` controls small global labels.
- `static/css/main.css` controls layout and visual style.
- `static/js/scripts.js` loads Markdown and powers the visitor-region widget.
