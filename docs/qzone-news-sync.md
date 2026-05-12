# QQ Zone News Sync

The homepage renders `data/news.json` in the News section. Personal updates can be edited directly in the `manual` list.

QQ Zone does not expose a stable anonymous public feed for all personal posts. The safest automatic path for this static GitHub Pages site is therefore:

1. keep the QQ login cookie in a private GitHub Actions secret;
2. let GitHub Actions fetch recent posts on a schedule;
3. write the sanitized public result into `data/news.json`;
4. let the public homepage read only that JSON file.

This is near-real-time, not true browser real-time. A static GitHub Pages page must not contain or request with your QQ login cookie, because that would expose the cookie to every visitor.

## Setup

The easiest setup is the automated local capture helper. It opens a real Chrome QQ Zone login page, listens to Chrome's own network events, and updates `data/news.json` after it sees `emotion_cgi_msglist_v6`.

```bash
node scripts/capture-qzone-session.mjs --keep-open
```

Then:

1. Log in to QQ Zone in the Chrome window opened by the script.
2. If the feed is not visible after login, open `https://user.qzone.qq.com/1527435659/infocenter?loginfrom=31` or click 说说.
3. Wait until the terminal prints `Captured ... posts`.
4. Review `data/news.json`.
5. Commit and push the changed News data if it looks correct.

The helper writes temporary capture files to `/private/tmp/qzone-capture/`:

- `qzone-capture.har`: response snapshot used for local import.
- `qzone-fields.json`: non-secret report showing endpoint, request params, cookie names, sample post keys, and sample image keys.
- `qzone-cookie.txt`: the captured Cookie value, mode `0600`; do not commit this file.

To enable scheduled GitHub Actions sync, put the content of `/private/tmp/qzone-capture/qzone-cookie.txt` into a repository secret:

1. Open `https://github.com/YichuanAlex/YichuanAlex.github.io`.
2. Go to Settings -> Secrets and variables -> Actions -> New repository secret.
3. Name the secret `QZONE_COOKIE`.
4. Paste the cookie string as the secret value, then save.
5. Go to Actions -> Sync QQ Zone News -> Run workflow.

If the helper cannot open Chrome automatically, start Chrome manually with remote debugging and attach to it:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/private/tmp/qzone-capture/chrome-profile \
  "https://user.qzone.qq.com/1527435659/infocenter?loginfrom=31"

node scripts/capture-qzone-session.mjs --attach --keep-open
```

The workflow also runs automatically twice per hour at minute 17 and 47. GitHub may delay scheduled workflows, so this should be treated as near-real-time synchronization.

The sync script uses the logged-in PC endpoint:

```text
https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6
```

It requests `ftype=0`, `sort=0`, `replynum=100`, `format=jsonp`, `need_private_comment=1`, and paginates with `pos` and `num`. The `g_tk` token is calculated from `p_skey` or `skey` in the secret cookie. Text, Unicode emoji, QQ custom `[em]...[/em]` emoji, and post images are normalized into `data/news.json`.

QQ photo URLs are often temporary or protected by QQ's image service. The scheduled workflow therefore downloads every returned image for each post into `static/assets/qzone/` and rewrites `data/news.json` to use those local static files. `QZONE_MAX_IMAGES=0` and `QZONE_CACHE_IMAGES_PER_POST=0` mean no per-post image limit. This keeps the GitHub Pages News feed stable after the original QQ image URLs expire.

## Optional Shared Links

Some QQ Zone H5 share URLs can be parsed without a full post-list API response, but they are less reliable than the cookie-backed feed. Use them as a fallback for selected posts, not as the main sync path.

There are two supported ways to provide share links:

- Add public links to `data/qzone-share-links.json` as a JSON array of strings.
- Or create a second Actions secret named `QZONE_SHARE_URLS`, with one share URL per line.

The script will try to read Open Graph metadata from each share page and merge it with the cookie-backed feed.

## HAR Import Fallback

If Chrome's HAR export does not include the Cookie header but does include the `emotion_cgi_msglist_v6` response body, the script can import the captured posts locally:

```bash
QZONE_HAR_PATH=user.qzone.qq.com.har QZONE_LIMIT=20 node scripts/sync-qzone.mjs
```

This updates `data/news.json` from the HAR snapshot. It is useful for a one-time import, but it is not an automatic live sync. Treat HAR files like private login data. If a HAR must be retained in this repository, keep it in Git LFS and verify that it does not contain a `Cookie` request header before pushing.

The workflow runs `scripts/sync-qzone.mjs`, fetches recent QQ Zone posts, and commits them into `data/news.json`. The public website reads only that JSON file; it never exposes the QQ login cookie.

## Maintenance

- QQ cookies expire. If the workflow stops fetching new posts or reports an API failure in `data/news.json`, copy a fresh cookie and update `QZONE_COOKIE`.
- Do not paste `QZONE_COOKIE` into source files, issues, README text, or chat logs.
- If you need truly live rendering on every page view, use a server-side proxy such as a Cloudflare Worker or Vercel Function and store the cookie only in that platform's secret store. Do not call QQ Zone APIs directly from browser JavaScript with a cookie.
