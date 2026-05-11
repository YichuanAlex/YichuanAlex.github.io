import { readFile, writeFile } from 'node:fs/promises'

const DATA_PATH = new URL('../data/news.json', import.meta.url)
const QZONE_UIN = process.env.QZONE_UIN || '1527435659'
const QZONE_COOKIE = process.env.QZONE_COOKIE || ''
const LIMIT = Number(process.env.QZONE_LIMIT || 12)

if (!QZONE_COOKIE) {
    console.log('QZONE_COOKIE is not set; leaving data/news.json unchanged.')
    process.exit(0)
}

const news = JSON.parse(await readFile(DATA_PATH, 'utf8'))
const posts = await fetchQzonePosts(QZONE_UIN, QZONE_COOKIE, LIMIT)

news.qzone = Object.assign({}, news.qzone, {
    profile_url: `https://user.qzone.qq.com/${QZONE_UIN}`,
    last_synced_at: new Date().toISOString(),
    sync_status: `Fetched ${posts.length} QQ Zone posts.`,
    items: posts
})

await writeFile(DATA_PATH, `${JSON.stringify(news, null, 2)}\n`)
console.log(`Synced ${posts.length} QQ Zone posts.`)

async function fetchQzonePosts(uin, cookie, limit) {
    const gtk = qzoneGtk(cookie)
    const url = new URL('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6')
    url.searchParams.set('uin', uin)
    url.searchParams.set('ftype', '0')
    url.searchParams.set('sort', '0')
    url.searchParams.set('pos', '0')
    url.searchParams.set('num', String(limit))
    url.searchParams.set('replynum', '0')
    url.searchParams.set('g_tk', String(gtk))
    url.searchParams.set('callback', '_Callback')

    const response = await fetch(url, {
        headers: {
            'Cookie': cookie,
            'Referer': `https://user.qzone.qq.com/${uin}/311`,
            'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
        }
    })

    if (!response.ok) {
        throw new Error(`QZone request failed with HTTP ${response.status}`)
    }

    const payload = parseJsonp(await response.text())
    const msglist = Array.isArray(payload.msglist) ? payload.msglist : []

    return msglist.map(post => ({
        date: post.created_time ? new Date(Number(post.created_time) * 1000).toISOString() : new Date().toISOString(),
        title: 'QQ Zone Post',
        body: cleanText(post.content || post.conlist?.map(item => item.con).join(' ') || ''),
        url: `https://user.qzone.qq.com/${uin}/311`,
        images: Array.isArray(post.pic)
            ? post.pic.map(image => image.url1 || image.url2 || image.url3 || image.pic_id).filter(Boolean).slice(0, 3)
            : []
    })).filter(post => post.body || post.images.length)
}

function parseJsonp(text) {
    const match = text.match(/^[^(]*\(([\s\S]*)\);?$/)
    if (!match) {
        throw new Error('Unexpected QZone response format.')
    }
    return JSON.parse(match[1])
}

function qzoneGtk(cookie) {
    const skey = cookie.match(/(?:^|;\s*)p_skey=([^;]+)/)?.[1]
        || cookie.match(/(?:^|;\s*)skey=([^;]+)/)?.[1]
        || ''
    let hash = 5381

    for (let index = 0; index < skey.length; index += 1) {
        hash += (hash << 5) + skey.charCodeAt(index)
    }

    return hash & 0x7fffffff
}

function cleanText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
}
