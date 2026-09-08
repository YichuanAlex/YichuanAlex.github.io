# Repository-Backed Visitor Statistics

The homepage can show two visitor-stat sources:

- Vercount live counters for public page views.
- A repository-backed aggregate log stored in `data/visitor-stats.json`.

GitHub Pages is a static host, so browser code must not write directly to the repository with a GitHub token. The safe setup is:

1. Deploy `workers/visitor-collector.js` as a Cloudflare Worker or equivalent serverless function.
2. Add these worker secrets or environment variables:
   - `GITHUB_OWNER=YichuanAlex`
   - `GITHUB_REPO=YichuanAlex.github.io`
   - `GITHUB_TOKEN=<fine-grained token with Contents: Read and write for this repository>`
   - `VISITOR_HASH_SALT=<long random string>`
   - `ALLOWED_ORIGIN=https://yichuanalex.github.io`
3. Set the deployed endpoint in `static/js/visitor-config.js`:

```js
window.VISITOR_STATS_ENDPOINT = "https://your-worker.example.workers.dev"
```

The collector stores aggregate region counts, country counts, recent visit metadata, and salted visitor hashes. Raw IP addresses are used only inside the worker to create the salted hash and are not written into the repository.
