import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const DATA_PATH = new URL('../data/news.json', import.meta.url)
const SHARE_LINKS_PATH = new URL('../data/qzone-share-links.json', import.meta.url)
const IMAGE_CACHE_DIR = new URL('../static/assets/qzone/', import.meta.url)
const IMAGE_CACHE_PUBLIC_PREFIX = 'static/assets/qzone'
const QZONE_UIN = process.env.QZONE_UIN || '1527435659'
const QZONE_COOKIE = process.env.QZONE_COOKIE || ''
const QZONE_SHARE_URLS = process.env.QZONE_SHARE_URLS || ''
const QZONE_HAR_PATH = process.env.QZONE_HAR_PATH || ''
const QZONE_G_TK = process.env.QZONE_G_TK || ''
const LIMIT = Math.max(1, Number(process.env.QZONE_LIMIT || 40))
const PAGE_SIZE = Math.min(40, Math.max(1, Number(process.env.QZONE_PAGE_SIZE || 20)))
const MAX_IMAGES = parseImageLimit(process.env.QZONE_MAX_IMAGES, Infinity)
const CACHE_IMAGES_PER_POST = parseImageLimit(process.env.QZONE_CACHE_IMAGES_PER_POST, Infinity)
const CACHE_IMAGES = process.env.QZONE_CACHE_IMAGES !== '0' && Boolean(QZONE_COOKIE)
const FETCH_DETAIL = process.env.QZONE_FETCH_DETAIL !== '0'

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
if (CACHE_IMAGES) {
    await cachePostImages(mergedPosts, QZONE_COOKIE, QZONE_UIN)
}

news.qzone = Object.assign({}, news.qzone, {
    profile_url: `https://user.qzone.qq.com/${QZONE_UIN}`,
    last_synced_at: new Date().toISOString(),
    sync_status: buildSyncStatus(qzonePosts.length, harPosts.length, sharePosts.length, errors),
    items: mergedPosts
})

await writeFile(DATA_PATH, `${JSON.stringify(news, null, 2)}\n`)
console.log(news.qzone.sync_status)

async function fetchQzonePosts(uin, cookie, limit) {
    const gtk = QZONE_G_TK || qzoneGtk(cookie)
    const posts = []

    for (let pos = 0; posts.length < limit; pos += PAGE_SIZE) {
        const num = Math.min(PAGE_SIZE, limit - posts.length)
        const payload = await fetchQzoneMsgListPage({ uin, cookie, gtk, pos, num })
        const msglist = Array.isArray(payload.msglist) ? payload.msglist : []

        if (!msglist.length) {
            break
        }

        for (const post of msglist) {
            posts.push(await hydrateQzonePost(post, { uin, cookie, gtk }))
        }

        if (msglist.length < num) {
            break
        }
    }

    return mergePosts(posts).slice(0, limit).filter(post => post.body || post.images.length)
}

async function fetchQzoneMsgListPage({ uin, cookie, gtk, pos, num }) {
    const url = new URL('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6')
    url.searchParams.set('uin', uin)
    url.searchParams.set('inCharset', 'utf-8')
    url.searchParams.set('outCharset', 'utf-8')
    url.searchParams.set('ftype', '0')
    url.searchParams.set('sort', '0')
    url.searchParams.set('pos', String(pos))
    url.searchParams.set('num', String(num))
    url.searchParams.set('replynum', '100')
    url.searchParams.set('g_tk', String(gtk))
    url.searchParams.set('callback', '_preloadCallback')
    url.searchParams.set('code_version', '1')
    url.searchParams.set('format', 'jsonp')
    url.searchParams.set('need_private_comment', '1')

    const response = await fetch(url, {
        headers: {
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cookie': cookie,
            'Referer': `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`,
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

    return payload
}

async function hydrateQzonePost(post, context) {
    const mapped = mapQzonePost(post, context.uin)

    if (!FETCH_DETAIL || !post.tid || !shouldFetchQzoneDetail(post, mapped)) {
        return mapped
    }

    try {
        const detail = await fetchQzonePostDetail(post, context)
        return mapQzonePost(mergeQzoneDetail(post, detail), context.uin)
    } catch {
        return mapped
    }
}

function shouldFetchQzoneDetail(post, mapped) {
    const declaredPhotoCount = Number(post.pictotal || post.pic_total || post.picnum || post.photo_count || 0)
    const expectedPhotoCount = Number.isFinite(MAX_IMAGES) ? Math.min(MAX_IMAGES, declaredPhotoCount) : declaredPhotoCount
    return Boolean(post.hasmore || post.has_more || post.has_more_con || post.more)
        || (declaredPhotoCount && mapped.images.length < expectedPhotoCount)
}

async function fetchQzonePostDetail(post, { uin, cookie, gtk }) {
    const url = new URL('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6')
    url.searchParams.set('uin', uin)
    url.searchParams.set('tid', post.tid)
    url.searchParams.set('t1_source', String(post.t1_source || post.t1Source || post.source || 0))
    url.searchParams.set('ftype', '0')
    url.searchParams.set('sort', '0')
    url.searchParams.set('pos', '0')
    url.searchParams.set('num', '20')
    url.searchParams.set('g_tk', String(gtk))
    url.searchParams.set('callback', '_preloadCallback')
    url.searchParams.set('code_version', '1')
    url.searchParams.set('format', 'jsonp')
    url.searchParams.set('need_private_comment', '1')

    const response = await fetch(url, {
        headers: {
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cookie': cookie,
            'Referer': `https://user.qzone.qq.com/${uin}/311/${post.tid}`,
            'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
        }
    })

    if (!response.ok) {
        throw new Error(`QZone detail request failed with HTTP ${response.status}`)
    }

    const payload = parseJsonp(await response.text())
    if (payload.code && Number(payload.code) !== 0) {
        throw new Error(payload.message || payload.msg || `QZone detail API returned code ${payload.code}`)
    }

    return payload
}

function mergeQzoneDetail(post, detail) {
    const detailPost = [detail.msg, detail.message, detail.data?.msg, detail.data?.msglist?.[0], detail.msglist?.[0]]
        .find(item => item && typeof item === 'object' && !Array.isArray(item)) || {}
    return Object.assign({}, post, detailPost, {
        pic: mergeArrays(post.pic, detailPost.pic || detail.pic),
        conlist: mergeArrays(post.conlist, detailPost.conlist || detail.conlist)
    })
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
    const createdTime = Number(post.created_time || post.createdTime || post.create_time || post.time || 0)
    const date = createdTime
        ? new Date(createdTime > 1000000000000 ? createdTime : createdTime * 1000).toISOString()
        : new Date().toISOString()

    return {
        id: post.tid || post.id || '',
        date,
        title: 'QQ Zone Post',
        body: cleanText(post.content || conlistText(post) || post.shortcon || post.summary || ''),
        url: post.tid ? `https://user.qzone.qq.com/${uin}/311/${post.tid}` : `https://user.qzone.qq.com/${uin}/311`,
        images: limitImages(imageUrlsFromPost(post), MAX_IMAGES)
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
    const images = limitImages(extractMetaImages(html), MAX_IMAGES)

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
    const payload = String(text || '').trim()

    if (payload.startsWith('{')) {
        return JSON.parse(payload)
    }

    const start = payload.indexOf('(')
    const end = payload.lastIndexOf(')')
    if (start === -1 || end <= start) {
        throw new Error('Unexpected QZone response format.')
    }
    return JSON.parse(payload.slice(start + 1, end))
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
    const urls = []
    collectImageUrls(post.pic, urls)
    collectImageUrls(post.pics, urls)
    collectImageUrls(post.images, urls)
    collectImageUrls(post.photo, urls)
    collectImageUrls(post.photos, urls)
    collectImageUrls(post.photolist, urls)
    collectImageUrls(post.rich_info?.pic, urls)
    collectImageUrls(post.rich_info?.pics, urls)

    return [...new Set(urls.map(normalizeUrl).filter(isUsableImageUrl))]
}

function collectImageUrls(value, urls, depth = 0) {
    if (!value || depth > 4) {
        return
    }

    if (Array.isArray(value)) {
        value.forEach(item => collectImageUrls(item, urls, depth + 1))
        return
    }

    if (typeof value === 'string') {
        if (value.trim()) {
            urls.push(value)
        }
        return
    }

    if (typeof value !== 'object') {
        return
    }

    const directKeys = [
        'smallurl',
        'url1',
        'url3',
        'url2',
        'url',
        'photourl',
        'pre',
        'raw',
        'bigurl',
        'b_url',
        'o_url',
        'pic_url',
        'thumbnail',
        'thumb',
        'origin_url',
        'origin',
        'hd_pic'
    ]

    for (const key of directKeys) {
        if (typeof value[key] === 'string' && value[key].trim()) {
            urls.push(value[key])
            return
        }
    }

    for (const key of ['pic', 'pics', 'images', 'photo', 'photos', 'photolist', 'list']) {
        collectImageUrls(value[key], urls, depth + 1)
    }
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

function isUsableImageUrl(value) {
    return /^https?:\/\//i.test(value)
}

async function cachePostImages(posts, cookie, uin) {
    await mkdir(IMAGE_CACHE_DIR, { recursive: true })
    const activeFiles = new Set()

    for (const post of posts) {
        const remoteImages = limitImages(Array.isArray(post.images) ? post.images.filter(isRemoteImageUrl) : [], CACHE_IMAGES_PER_POST)
        if (!remoteImages.length) {
            continue
        }

        const cachedImages = []
        for (let index = 0; index < remoteImages.length; index += 1) {
            const cached = await cacheOneImage(remoteImages[index], post, index, cookie, uin)
            if (cached) {
                cachedImages.push(cached.publicPath)
                activeFiles.add(cached.filename)
            }
        }

        if (cachedImages.length) {
            post.images = cachedImages
        }
    }

    await removeStaleCachedImages(activeFiles)
}

async function cacheOneImage(url, post, index, cookie, uin) {
    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Cookie': cookie,
                'Referer': post.url || `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`,
                'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
            }
        })

        if (!response.ok) {
            console.warn(`Image cache skipped ${post.id || 'post'}#${index}: HTTP ${response.status}`)
            return null
        }

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.startsWith('image/')) {
            console.warn(`Image cache skipped ${post.id || 'post'}#${index}: content type ${contentType || 'unknown'}`)
            return null
        }

        const bytes = Buffer.from(await response.arrayBuffer())
        if (!bytes.length) {
            return null
        }

        const hash = createHash('sha256').update(url).digest('hex').slice(0, 14)
        const safePostId = String(post.id || post.date || 'qzone').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'qzone'
        const extension = imageExtension(contentType, url)
        const filename = `${safePostId}-${String(index + 1).padStart(2, '0')}-${hash}.${extension}`
        const target = new URL(filename, IMAGE_CACHE_DIR)

        await writeFile(target, bytes)
        return {
            filename,
            publicPath: `${IMAGE_CACHE_PUBLIC_PREFIX}/${filename}`
        }
    } catch (error) {
        console.warn(`Image cache skipped ${post.id || 'post'}#${index}: ${error.message}`)
        return null
    }
}

async function removeStaleCachedImages(activeFiles) {
    let filenames = []
    try {
        filenames = await readdir(IMAGE_CACHE_DIR)
    } catch {
        return
    }

    await Promise.all(filenames
        .filter(filename => /\.(avif|gif|jpe?g|png|webp)$/i.test(filename))
        .filter(filename => !activeFiles.has(filename))
        .map(filename => unlink(new URL(filename, IMAGE_CACHE_DIR)).catch(() => {})))
}

function isRemoteImageUrl(value) {
    return /^https?:\/\//i.test(String(value || ''))
}

function imageExtension(contentType, url) {
    const normalized = contentType.split(';')[0].trim().toLowerCase()
    if (normalized === 'image/jpeg') {
        return 'jpg'
    }
    if (normalized === 'image/png') {
        return 'png'
    }
    if (normalized === 'image/gif') {
        return 'gif'
    }
    if (normalized === 'image/avif') {
        return 'avif'
    }
    if (normalized === 'image/webp') {
        return 'webp'
    }

    try {
        const pathname = new URL(url).pathname
        const match = pathname.match(/\.([a-z0-9]{2,5})$/i)
        return match ? match[1].toLowerCase() : 'jpg'
    } catch {
        return 'jpg'
    }
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
        images: limitImages(Array.isArray(post.images) ? post.images.map(normalizeUrl).filter(isUsableImageUrl) : [], MAX_IMAGES)
    }
}

function parseImageLimit(value, fallback) {
    const raw = String(value ?? '').trim()
    if (!raw) {
        return fallback
    }
    if (/^(0|all|none|unlimited)$/i.test(raw)) {
        return Infinity
    }
    const numeric = Number(raw)
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

function limitImages(images, limit) {
    return Number.isFinite(limit) ? images.slice(0, limit) : images
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
    return decodeEntities(String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\\n/g, '\n'))
        .replace(/\r\n?/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function decodeEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (raw, code) => decodeCodePoint(Number.parseInt(code, 16), raw))
        .replace(/&#(\d+);/g, (raw, code) => decodeCodePoint(Number.parseInt(code, 10), raw))
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
}

function decodeCodePoint(value, fallback) {
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback
}

function mergeArrays(...groups) {
    return groups.flatMap(group => Array.isArray(group) ? group : []).filter(Boolean)
}
