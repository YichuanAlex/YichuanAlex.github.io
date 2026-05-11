# Zixi Jiang Personal Homepage

This repository contains the static GitHub Pages site for Zixi Jiang.

## Structure

```text
.
├── contents/              # Markdown content loaded by the page
├── source/                # CV and source documents
├── static/
│   ├── assets/img/        # Profile and hero images
│   ├── css/               # Theme styles
│   └── js/                # Markdown/YAML loader scripts
└── index.html
```

## Local Preview

Run a local static server from the repository root:

```bash
python3 -m http.server 8000
```

Then open `http://127.0.0.1:8000/`.

## Editing

- Global text such as the title and hero copy is in `contents/config.yml`.
- Page sections are in `contents/*.md`.
- Layout is in `index.html`.
- Visual styling is in `static/css/main.css`.

The site is based on the original academic homepage template by Sen Li and keeps the upstream MIT license in `LICENSE`.
