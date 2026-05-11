# Zixi Jiang Personal Homepage

Static GitHub Pages site for Zixi Jiang.

## Structure

```text
.
├── contents/              # Markdown content loaded by the page
├── data/                  # Repository-backed visitor statistics
├── docs/                  # Deployment notes
├── source/                # CV and source documents
├── static/
│   ├── assets/img/        # Profile and supporting images
│   ├── css/               # Site styles
│   └── js/                # Markdown/YAML loader and visitor widgets
├── workers/               # Serverless visitor collector for GitHub-backed stats
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
- `static/js/visitor-config.js` points the browser to the deployed visitor collector.
- `workers/visitor-collector.js` safely writes aggregate visitor stats to `data/visitor-stats.json` through server-side GitHub credentials.

## Visitor Statistics

The page uses Vercount for public live counters and includes a repository-backed aggregate log in `data/visitor-stats.json`. GitHub Pages cannot securely write to a repository from browser JavaScript, so the write path is implemented as a serverless collector in `workers/visitor-collector.js`.

See `docs/visitor-stats.md` for deployment variables and privacy notes.
