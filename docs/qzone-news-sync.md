# QQ Zone News Sync

The homepage renders `data/news.json` in the News section. Personal updates can be edited directly in the `manual` list.

QQ Zone does not expose a stable anonymous public feed for all personal posts. The safest automatic path for this static GitHub Pages site is therefore:

1. keep the QQ login cookie in a private GitHub Actions secret;
2. let GitHub Actions fetch recent posts on a schedule;
3. write the sanitized public result into `data/news.json`;
4. let the public homepage read only that JSON file.

This is near-real-time, not true browser real-time. A static GitHub Pages page must not contain or request with your QQ login cookie, because that would expose the cookie to every visitor.

## Setup

1. Open QQ Zone in Chrome while logged in to QQ `1527435659`.
2. Open DevTools, select the Network tab, then refresh your QQ Zone page.
3. Filter requests by `emotion_cgi_msglist_v6`, `taotao.qq.com`, or `user.qzone.qq.com`.
4. Click the request that returns your recent posts.
5. In Request Headers, copy the full `Cookie` value. It should usually include `p_skey` or `skey`.
6. Open `https://github.com/YichuanAlex/YichuanAlex.github.io`.
7. Go to Settings -> Secrets and variables -> Actions -> New repository secret.
8. Name the secret `QZONE_COOKIE`.
9. Paste the full cookie string as the secret value, then save.
10. Go to Actions -> Sync QQ Zone News -> Run workflow.

The workflow also runs automatically twice per hour at minute 17 and 47. GitHub may delay scheduled workflows, so this should be treated as near-real-time synchronization.

## Optional Shared Links

Some QQ Zone H5 share URLs can be parsed without a full post-list API response, but they are less reliable than the cookie-backed feed. Use them as a fallback for selected posts, not as the main sync path.

There are two supported ways to provide share links:

- Add public links to `data/qzone-share-links.json` as a JSON array of strings.
- Or create a second Actions secret named `QZONE_SHARE_URLS`, with one share URL per line.

The script will try to read Open Graph metadata from each share page and merge it with the cookie-backed feed.

The workflow runs `scripts/sync-qzone.mjs`, fetches recent QQ Zone posts, and commits them into `data/news.json`. The public website reads only that JSON file; it never exposes the QQ login cookie.

## Maintenance

- QQ cookies expire. If the workflow stops fetching new posts or reports an API failure in `data/news.json`, copy a fresh cookie and update `QZONE_COOKIE`.
- Do not paste `QZONE_COOKIE` into source files, issues, README text, or chat logs.
- If you need truly live rendering on every page view, use a server-side proxy such as a Cloudflare Worker or Vercel Function and store the cookie only in that platform's secret store. Do not call QQ Zone APIs directly from browser JavaScript with a cookie.
