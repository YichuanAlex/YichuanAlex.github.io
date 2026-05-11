import { readFile, writeFile } from 'node:fs/promises'

const DATA_PATH = new URL('../data/news.json', import.meta.url)
const SHARE_LINKS_PATH = new URL('../data/qzone-share-links.json', import.meta.url)
const QZONE_UIN = process.env.QZONE_UIN || '1527435659'
const QZONE_COOKIE = process.env.QZONE_COOKIE || ''
const QZONE_SHARE_URLS = process.env.QZONE_SHARE_URLS || ''
const QZONE_HAR_PATH = process.env.QZONE_HAR_PATH || ''
const LIMIT = Math.max(1, Number(process.env.QZONE_LIMIT || 18))

const news = JSON.parse(await readFile(DATA_PATH, 'utf8'))
const existingPosts = Array.isArray(news.qzone?.items) ? news.qzone.items : []
const errors = []
let qzonePosts = []
let harPosts = []
let sharePosts = []

if (QZONE_COOKIE) {
    try {
        qzonePosts = await fetchQzonePosts(QZONE_UIN, QZONE_COOKIE, LIMIT)
    } catch (error) {
        errors.push(`QQ Zone API failed: ${error.message}`)
    }
}

if (QZONE_HAR_PATH) {
    try {
        harPosts = await fetchQzonePostsFromHar(QZONE_HAR_PATH, LIMIT)
    } catch (error) {
        errors.push(`QZone HAR import failed: ${error.message}`)
    }
}

const shareUrls = await loadShareUrls()
if (shareUrls.length) {
    sharePosts = await fetchSharePosts(shareUrls, QZONE_COOKIE)
}

if (!QZONE_COOKIE && !QZONE_HAR_PATH && !shareUrls.length) {
    console.log('Neither QZONE_COOKIE, QZONE_HAR_PATH, nor QZone share URLs are configured; leaving data/news.json unchanged.')
    process.exit(0)
}

const mergedPosts = mergePosts(qzonePosts, harPosts, sharePosts, existingPosts).slice(0, LIMIT)

news.qzone = Object.assign({}, news.qzone, {
    profile_url: `https://user.qzone.qq.com/${QZONE_UIN}`,
    last_synced_at: new Date().toISOString(),
    sync_status: buildSyncStatus(qzonePosts.length, harPosts.length, sharePosts.length, errors),
    items: mergedPosts
})

await writeFile(DATA_PATH, `${JSON.stringify(news, null, 2)}\n`)
console.log(news.qzone.sync_status)

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
    url.searchParams.set('code_version', '1')
    url.searchParams.set('format', 'jsonp')
    url.searchParams.set('need_private_comment', '1')

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
    if (payload.code && Number(payload.code) !== 0) {
        throw new Error(payload.message || payload.msg || `QZone API returned code ${payload.code}`)
    }

    const msglist = Array.isArray(payload.msglist) ? payload.msglist : []

    return msglist.map(post => mapQzonePost(post, uin)).filter(post => post.body || post.images.length)
}

async function fetchQzonePostsFromHar(path, limit) {
    const har = JSON.parse(await readFile(path, 'utf8'))
    const entries = Array.isArray(har.log?.entries) ? har.log.entries : []
    const posts = []

    entries
        .filter(entry => /emotion_cgi_msglist_v6/.test(entry.request?.url || ''))
        .forEach(entry => {
            const content = entry.response?.content || {}
            let text = content.text || ''
            if (!text) {
                return
            }
            if (content.encoding === 'base64') {
                text = Buffer.from(text, 'base64').toString('utf8')
            }
            const payload = parseJsonp(text)
            if (payload.code && Number(payload.code) !== 0) {
                throw new Error(payload.message || payload.msg || `QZone HAR response returned code ${payload.code}`)
            }
            const msglist = Array.isArray(payload.msglist) ? payload.msglist : []
            posts.push(...msglist.map(post => mapQzonePost(post, post.uin || QZONE_UIN)))
        })

    return mergePosts(posts).slice(0, limit)
}

function mapQzonePost(post, uin) {
    return {
        id: post.tid || post.id || '',
        date: post.created_time ? new Date(Number(post.created_time) * 1000).toISOString() : new Date().toISOString(),
        title: 'QQ Zone Post',
        body: cleanText(post.content || conlistText(post) || post.shortcon || ''),
        url: post.tid ? `https://user.qzone.qq.com/${uin}/311/${post.tid}` : `https://user.qzone.qq.com/${uin}/311`,
        images: imageUrlsFromPost(post).slice(0, 3)
    }
}

async function loadShareUrls() {
    const urls = []

    if (QZONE_SHARE_URLS.trim()) {
        urls.push(...QZONE_SHARE_URLS.split(/[\n,]+/).map(value => value.trim()).filter(Boolean))
    }

    try {
        const payload = JSON.parse(await readFile(SHARE_LINKS_PATH, 'utf8'))
        if (Array.isArray(payload)) {
            urls.push(...payload.map(item => typeof item === 'string' ? item : item.url).filter(Boolean))
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error
        }
    }

    return [...new Set(urls)].filter(url => /^https:\/\/h5\.qzone\.qq\.com\/universal-share\/share\?/i.test(url))
}

async function fetchSharePosts(urls, cookie) {
    const posts = await Promise.all(urls.map(async url => {
        try {
            return await fetchSharePost(url, cookie)
        } catch (error) {
            return {
                id: shareIdFromUrl(url),
                date: dateFromShareUrl(url) || new Date().toISOString(),
                title: 'QQ Zone Shared Post',
                body: `QQ Zone share could not be parsed automatically: ${error.message}`,
                url,
                images: []
            }
        }
    }))

    return posts.filter(post => post.url)
}

async function fetchSharePost(url, cookie) {
    const response = await fetch(url, {
        headers: {
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 QQ/9.0.0',
            'Referer': 'https://h5.qzone.qq.com/'
        }
    })

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
    }

    const html = await response.text()
    const title = cleanText(extractMeta(html, ['og:title', 'twitter:title']) || extractTitle(html) || 'QQ Zone Shared Post')
    const body = cleanText(extractMeta(html, ['og:description', 'description', 'twitter:description']) || '')
    const images = extractMetaImages(html).slice(0, 3)

    return {
        id: shareIdFromUrl(url),
        date: dateFromShareUrl(url) || new Date().toISOString(),
        title,
        body,
        url,
        images
    }
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

function conlistText(post) {
    if (!Array.isArray(post.conlist)) {
        return ''
    }

    return post.conlist.map(item => item.con || item.content || item.name || '').join(' ')
}

function imageUrlsFromPost(post) {
    if (!Array.isArray(post.pic)) {
        return []
    }

    return post.pic.map(image => {
        return image.url1 || image.url2 || image.url3 || image.origin_url || image.photourl || image.smallurl || image.pic_id || ''
    }).map(normalizeUrl).filter(Boolean)
}

function normalizeUrl(value) {
    const url = String(value || '').trim()
    if (!url) {
        return ''
    }
    if (url.startsWith('//')) {
        return `https:${url}`
    }
    if (url.startsWith('http://')) {
        return url.replace(/^http:/, 'https:')
    }
    return url
}

function extractMeta(html, keys) {
    const tags = html.match(/<meta\b[^>]*>/gi) || []
    for (const tag of tags) {
        const name = extractAttribute(tag, 'property') || extractAttribute(tag, 'name')
        if (keys.includes(String(name || '').toLowerCase())) {
            return decodeEntities(extractAttribute(tag, 'content') || '')
        }
    }
    return ''
}

function extractMetaImages(html) {
    const tags = html.match(/<meta\b[^>]*>/gi) || []
    return tags.map(tag => {
        const name = String(extractAttribute(tag, 'property') || extractAttribute(tag, 'name') || '').toLowerCase()
        return name.includes('image') ? normalizeUrl(decodeEntities(extractAttribute(tag, 'content') || '')) : ''
    }).filter(Boolean)
}

function extractTitle(html) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return match ? decodeEntities(match[1]) : ''
}

function extractAttribute(tag, attribute) {
    const match = tag.match(new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    return match ? (match[2] || match[3] || match[4] || '') : ''
}

function shareIdFromUrl(value) {
    try {
        const url = new URL(value)
        const busiData = JSON.parse(decodeURIComponent(url.searchParams.get('busi_data') || '{}'))
        return busiData.share_id || ''
    } catch {
        return ''
    }
}

function dateFromShareUrl(value) {
    const shareId = shareIdFromUrl(value)
    const parts = String(shareId).split('-')

    if (parts.length < 3 || !/^1/i.test(parts[2])) {
        return ''
    }

    try {
        const timeLow = BigInt(`0x${parts[0]}`)
        const timeMid = BigInt(`0x${parts[1]}`)
        const timeHigh = BigInt(`0x${parts[2]}`) & 0x0fffn
        const uuidTimestamp = (timeHigh << 48n) | (timeMid << 32n) | timeLow
        const unixTimestamp = uuidTimestamp - 0x01b21dd213814000n
        return new Date(Number(unixTimestamp / 10000n)).toISOString()
    } catch {
        return ''
    }
}

function mergePosts(...groups) {
    const seen = new Set()
    const posts = []

    groups.flat().forEach(post => {
        const normalized = normalizePost(post)
        const key = normalized.id || normalized.url || `${normalized.date}:${normalized.body.slice(0, 120)}`
        if (seen.has(key)) {
            return
        }
        seen.add(key)
        posts.push(normalized)
    })

    return posts.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
}

function normalizePost(post) {
    return {
        id: post.id || '',
        date: post.date || post.time || new Date().toISOString(),
        title: cleanText(post.title || 'QQ Zone Post'),
        body: cleanText(post.body || post.content || ''),
        url: post.url || `https://user.qzone.qq.com/${QZONE_UIN}/311`,
        images: Array.isArray(post.images) ? post.images.map(normalizeUrl).filter(Boolean).slice(0, 3) : []
    }
}

function buildSyncStatus(postCount, harCount, shareCount, errors) {
    const parts = []
    if (QZONE_COOKIE) {
        parts.push(`Fetched ${postCount} QQ Zone posts`)
    } else if (!harCount) {
        parts.push('QZONE_COOKIE is not configured')
    }
    if (harCount) {
        parts.push(`Imported ${harCount} QQ Zone posts from HAR`)
    } else {
        parts.push('HAR import is not configured')
    }
    if (shareCount) {
        parts.push(`parsed ${shareCount} shared links`)
    }
    if (errors.length) {
        parts.push(errors.join(' | '))
    }
    return `${parts.join('; ')}.`
}

function cleanText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[em\][^\[]*?\[\/em\]/g, '')
        .replace(/\\n/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
}

function decodeEntities(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
}
