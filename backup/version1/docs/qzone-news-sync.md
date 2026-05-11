# QQ Zone News Sync

The homepage renders `data/news.json` in the News section. Personal updates can be edited directly in the `manual` list.

QQ Zone does not expose a stable anonymous public feed for all personal posts. The sync path therefore runs server-side through GitHub Actions with a private login cookie stored as a repository secret.

## Setup

1. Open QQ Zone in a browser while logged in.
2. Copy the request cookie for `user.qzone.qq.com`.
3. In GitHub, add a repository secret named `QZONE_COOKIE`.
4. Run the `Sync QQ Zone News` workflow manually or wait for the daily schedule.

The workflow runs `scripts/sync-qzone.mjs`, fetches recent QQ Zone posts, and commits them into `data/news.json`. The public website reads only that JSON file; it never exposes the QQ login cookie.
