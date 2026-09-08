const STATS_PATH = 'data/visitor-stats.json'
const BRANCH = 'main'
const MAX_RECENT_VISITS = 100

export default {
    async fetch(request, env) {
        const corsHeaders = buildCorsHeaders(request, env)

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders })
        }

        if (request.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
        }

        const origin = request.headers.get('Origin') || ''
        if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
            return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders)
        }

        let body = {}
        try {
            body = await request.json()
        } catch (error) {
            body = {}
        }

        const update = await buildVisitUpdate(request, env, body)

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = await readStats(env)
            const nextStats = mergeVisit(current.stats, update)
            const saved = await writeStats(env, current.sha, nextStats)

            if (saved.ok) {
                return jsonResponse({ ok: true, stats: publicStats(nextStats) }, 200, corsHeaders)
            }

            if (saved.status !== 409) {
                return jsonResponse({ error: 'GitHub write failed', status: saved.status }, 502, corsHeaders)
            }

            await sleep(180 * (attempt + 1))
        }

        return jsonResponse({ error: 'Concurrent update conflict' }, 409, corsHeaders)
    }
}

function buildCorsHeaders(request, env) {
    const origin = request.headers.get('Origin') || env.ALLOWED_ORIGIN || '*'
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    }
}

async function buildVisitUpdate(request, env, body) {
    const cf = request.cf || {}
    const ip = request.headers.get('CF-Connecting-IP') || firstForwardedIp(request.headers.get('X-Forwarded-For')) || 'unknown'
    const userAgent = request.headers.get('User-Agent') || 'unknown'
    const salt = env.VISITOR_HASH_SALT || 'replace-this-salt'
    const visitorHash = await sha256(`${salt}|${ip}|${userAgent}`)

    const country = clean(body.country || cf.country || 'Unknown')
    const region = clean(body.region || cf.region || 'Unknown')
    const city = clean(body.city || cf.city || '')
    const timezone = clean(body.timezone || cf.timezone || '')

    return {
        time: new Date().toISOString(),
        visitorHash,
        country,
        region,
        city,
        timezone,
        latitude: cleanNumber(body.latitude || cf.latitude),
        longitude: cleanNumber(body.longitude || cf.longitude),
        path: cleanPath(body.path || '/'),
        referrer: cleanUrl(body.referrer || '')
    }
}

function mergeVisit(stats, visit) {
    const next = {
        total_visits: Number(stats.total_visits || 0) + 1,
        unique_visitors: Number(stats.unique_visitors || 0),
        regions: stats.regions || {},
        countries: stats.countries || {},
        recent_visits: Array.isArray(stats.recent_visits) ? stats.recent_visits : [],
        visitor_hashes: stats.visitor_hashes || {},
        updated_at: visit.time,
        meta: stats.meta || {}
    }

    if (!next.visitor_hashes[visit.visitorHash]) {
        next.visitor_hashes[visit.visitorHash] = visit.time
    }
    next.unique_visitors = Object.keys(next.visitor_hashes).length

    const regionKey = [visit.country, visit.region, visit.city].filter(Boolean).join(' / ') || 'Unknown'
    next.regions[regionKey] = Number(next.regions[regionKey] || 0) + 1
    next.countries[visit.country] = Number(next.countries[visit.country] || 0) + 1
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
        visitor: visit.visitorHash.slice(0, 12)
    }].concat(next.recent_visits).slice(0, MAX_RECENT_VISITS)

    return next
}

async function readStats(env) {
    const response = await fetch(githubContentsUrl(env), {
        headers: githubHeaders(env)
    })

    if (!response.ok) {
        throw new Error(`GitHub read failed: ${response.status}`)
    }

    const payload = await response.json()
    return {
        sha: payload.sha,
        stats: JSON.parse(decodeBase64(payload.content || 'e30='))
    }
}

async function writeStats(env, sha, stats) {
    return fetch(githubContentsUrl(env), {
        method: 'PUT',
        headers: githubHeaders(env),
        body: JSON.stringify({
            message: `chore: record visitor stats ${stats.updated_at}`,
            content: encodeBase64(JSON.stringify(stats, null, 2) + '\n'),
            sha,
            branch: BRANCH
        })
    })
}

function githubContentsUrl(env) {
    return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${STATS_PATH}?ref=${BRANCH}`
}

function githubHeaders(env) {
    return {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
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
        updated_at: stats.updated_at
    }
}

function jsonResponse(payload, status, headers) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
    })
}

function firstForwardedIp(value) {
    return value ? value.split(',')[0].trim() : ''
}

function clean(value) {
    return String(value || '').replace(/[<>]/g, '').slice(0, 80)
}

function cleanPath(value) {
    const path = String(value || '/').replace(/[<>]/g, '').slice(0, 160)
    return path.startsWith('/') ? path : '/'
}

function cleanUrl(value) {
    return String(value || '').replace(/[<>]/g, '').slice(0, 220)
}

function cleanNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : ''
}

async function sha256(value) {
    const data = new TextEncoder().encode(value)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(value) {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    bytes.forEach(byte => {
        binary += String.fromCharCode(byte)
    })
    return btoa(binary)
}

function decodeBase64(value) {
    const binary = atob(String(value).replace(/\s/g, ''))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}
