const STATS_PATH = 'data/visitor-stats.json'
const DEFAULT_BRANCH = 'main'
const MAX_RECENT_VISITS = 100
const MAX_HASHES = 5000

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || ''
        const allowed = isOriginAllowed(origin, env)
        const corsHeaders = buildCorsHeaders(origin, allowed)

        if (request.method === 'OPTIONS') {
            return allowed
                ? new Response(null, { status: 204, headers: corsHeaders })
                : jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders)
        }

        const pathname = new URL(request.url).pathname.replace(/\/$/, '') || '/'
        if (request.method === 'GET' && pathname === '/health') {
            return healthResponse(env, corsHeaders)
        }
        if (request.method !== 'POST' || pathname !== '/') {
            return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
        }
        if (!allowed) return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders)
        if (!hasRepositoryConfig(env)) return jsonResponse({ error: 'Collector is not configured' }, 503, corsHeaders)

        let body
        try {
            body = await request.json()
        } catch {
            return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders)
        }
        const validation = validateBody(body)
        if (!validation.ok) return jsonResponse({ error: validation.error }, 400, corsHeaders)

        try {
            const update = await buildVisitUpdate(request, env, validation.value)
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const current = await readStats(env)
                const nextStats = mergeVisit(current.stats, update)
                const saved = await writeStats(env, current.sha, nextStats)
                if (saved.ok) return jsonResponse({ ok: true, stats: publicStats(nextStats) }, 200, corsHeaders)
                if (saved.status !== 409 && saved.status !== 422) {
                    return jsonResponse({ error: 'Repository write failed' }, 502, corsHeaders)
                }
                await sleep(180 * (attempt + 1))
            }
            return jsonResponse({ error: 'Concurrent update conflict' }, 409, corsHeaders)
        } catch {
            return jsonResponse({ error: 'Repository connection failed' }, 502, corsHeaders)
        }
    }
}

async function healthResponse(env, corsHeaders) {
    if (!hasRepositoryConfig(env)) {
        return jsonResponse({ ok: true, connected: false, status: 'unconfigured' }, 200, corsHeaders)
    }
    try {
        await readStats(env)
        return jsonResponse({ ok: true, connected: true, status: 'connected' }, 200, corsHeaders)
    } catch {
        return jsonResponse({ ok: false, connected: false, status: 'error' }, 503, corsHeaders)
    }
}

function hasRepositoryConfig(env) {
    return Boolean(env.GITHUB_OWNER && env.GITHUB_REPO && env.GITHUB_TOKEN && env.VISITOR_HASH_SALT)
}

function allowedOrigins(env) {
    return String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
}

function isOriginAllowed(origin, env) {
    const allowlist = allowedOrigins(env)
    if (!origin) return true
    return allowlist.length > 0 && allowlist.includes(origin)
}

function buildCorsHeaders(origin, allowed) {
    const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
        'Cache-Control': 'no-store'
    }
    if (origin && allowed) headers['Access-Control-Allow-Origin'] = origin
    return headers
}

function validateBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'JSON object required' }
    const latitude = numberInRange(body.latitude, -90, 90)
    const longitude = numberInRange(body.longitude, -180, 180)
    if (latitude === null || longitude === null) return { ok: false, error: 'Valid latitude and longitude are required' }
    const path = cleanPath(body.path)
    if (!path) return { ok: false, error: 'Valid path is required' }
    const deviceType = cleanEnum(body.device_type, ['desktop', 'mobile', 'tablet', 'unknown'])
    return {
        ok: true,
        value: {
            latitude,
            longitude,
            city: clean(body.city, 80),
            region: clean(body.region, 80),
            country: clean(body.country, 80) || 'Unknown',
            path,
            referrer: referrerBucket(body.referrer),
            deviceType: deviceType || 'unknown'
        }
    }
}

async function buildVisitUpdate(request, env, body) {
    const cf = request.cf || {}
    const ip = request.headers.get('CF-Connecting-IP') || firstForwardedIp(request.headers.get('X-Forwarded-For')) || 'unknown'
    const userAgent = request.headers.get('User-Agent') || 'unknown'
    const visitorHash = await sha256(`${env.VISITOR_HASH_SALT}|${ip}|${userAgent}`)
    return {
        time: new Date().toISOString(),
        visitorHash,
        country: body.country || clean(cf.country, 80) || 'Unknown',
        region: body.region || clean(cf.region, 80) || 'Unknown',
        city: body.city || clean(cf.city, 80),
        timezone: clean(cf.timezone, 80),
        latitude: body.latitude,
        longitude: body.longitude,
        path: body.path,
        referrer: body.referrer,
        deviceType: body.deviceType
    }
}

function mergeVisit(stats, visit) {
    const hashes = Object.assign({}, stats.visitor_hashes || {})
    hashes[visit.visitorHash] = hashes[visit.visitorHash] || visit.time
    const hashEntries = Object.entries(hashes).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, MAX_HASHES)
    const next = {
        total_visits: Number(stats.total_visits || 0) + 1,
        unique_visitors: hashEntries.length,
        regions: Object.assign({}, stats.regions || {}),
        countries: Object.assign({}, stats.countries || {}),
        recent_visits: Array.isArray(stats.recent_visits) ? stats.recent_visits.slice() : [],
        daily_visits: Object.assign({}, stats.daily_visits || {}),
        pages: Object.assign({}, stats.pages || {}),
        referrers: Object.assign({}, stats.referrers || {}),
        devices: Object.assign({}, stats.devices || {}),
        visitor_hashes: Object.fromEntries(hashEntries),
        updated_at: visit.time,
        meta: stats.meta || {}
    }
    const regionKey = [visit.country, visit.region, visit.city].filter(Boolean).join(' / ') || 'Unknown'
    increment(next.regions, regionKey)
    increment(next.countries, visit.country)
    increment(next.daily_visits, visit.time.slice(0, 10))
    increment(next.pages, visit.path)
    increment(next.referrers, visit.referrer)
    increment(next.devices, visit.deviceType)
    next.recent_visits = [{
        time: visit.time,
        country: visit.country,
        region: visit.region,
        city: visit.city,
        timezone: visit.timezone,
        latitude: visit.latitude,
        longitude: visit.longitude,
        path: visit.path,
        referrer: visit.referrer,
        device_type: visit.deviceType,
        visitor: visit.visitorHash.slice(0, 12)
    }].concat(next.recent_visits).slice(0, MAX_RECENT_VISITS)
    return next
}

function increment(bucket, key) {
    const label = key || 'Unknown'
    bucket[label] = Number(bucket[label] || 0) + 1
}

async function readStats(env) {
    const response = await fetch(githubContentsUrl(env), { headers: githubHeaders(env) })
    if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`)
    const payload = await response.json()
    return { sha: payload.sha, stats: JSON.parse(decodeBase64(payload.content || 'e30=')) }
}

async function writeStats(env, sha, stats) {
    return fetch(githubContentsUrl(env), {
        method: 'PUT',
        headers: githubHeaders(env),
        body: JSON.stringify({
            message: `chore: record visitor stats ${stats.updated_at}`,
            content: encodeBase64(`${JSON.stringify(stats, null, 2)}\n`),
            sha,
            branch: env.GITHUB_BRANCH || DEFAULT_BRANCH
        })
    })
}

function githubContentsUrl(env) {
    const branch = encodeURIComponent(env.GITHUB_BRANCH || DEFAULT_BRANCH)
    return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${STATS_PATH}?ref=${branch}`
}

function githubHeaders(env) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'zixijiang-visitor-collector',
        'X-GitHub-Api-Version': '2022-11-28'
    }
}

function publicStats(stats) {
    return {
        total_visits: stats.total_visits,
        unique_visitors: stats.unique_visitors,
        regions: stats.regions,
        countries: stats.countries,
        recent_visits: stats.recent_visits,
        daily_visits: stats.daily_visits,
        pages: stats.pages,
        referrers: stats.referrers,
        devices: stats.devices,
        updated_at: stats.updated_at
    }
}

function jsonResponse(payload, status, headers) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)
    })
}

function firstForwardedIp(value) {
    return value ? value.split(',')[0].trim() : ''
}

function clean(value, max) {
    return Array.from(String(value || '').replace(/[<>]/g, ''))
        .filter(character => character >= ' ' && character !== '\u007f')
        .join('')
        .trim()
        .slice(0, max)
}

function cleanPath(value) {
    const path = clean(value || '/', 180)
    return path.startsWith('/') && !path.startsWith('//') ? path : ''
}

function referrerBucket(value) {
    const text = String(value || '').trim()
    if (!text) return 'Direct'
    try {
        const url = new URL(text)
        return clean(url.hostname.toLowerCase(), 120) || 'Direct'
    } catch {
        return 'Invalid/Other'
    }
}

function cleanEnum(value, allowed) {
    const normalized = String(value || '').toLowerCase()
    return allowed.includes(normalized) ? normalized : ''
}

function numberInRange(value, min, max) {
    if (value === '' || value === null || value === undefined) return null
    const number = Number(value)
    return Number.isFinite(number) && number >= min && number <= max ? number : null
}

async function sha256(value) {
    const data = new TextEncoder().encode(value)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(value) {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    bytes.forEach(byte => { binary += String.fromCharCode(byte) })
    return btoa(binary)
}

function decodeBase64(value) {
    const binary = atob(String(value).replace(/\s/g, ''))
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}
