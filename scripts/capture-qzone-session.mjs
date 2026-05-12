#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_UIN = process.env.QZONE_UIN || '1527435659'
const DEFAULT_PORT = Number(process.env.QZONE_CDP_PORT || 9222)
const DEFAULT_LIMIT = Number(process.env.QZONE_LIMIT || 40)
const DEFAULT_OUTPUT_DIR = process.env.QZONE_CAPTURE_DIR || '/private/tmp/qzone-capture'
const TARGET_CGI = 'emotion_cgi_msglist_v6'
const DETAIL_CGI = 'emotion_cgi_msgdetail_v6'

const options = parseArgs(process.argv.slice(2))
const uin = options.uin || DEFAULT_UIN
const port = Number(options.port || DEFAULT_PORT)
const limit = Number(options.limit || DEFAULT_LIMIT)
const outputDir = resolve(options.outputDir || DEFAULT_OUTPUT_DIR)
const profileDir = resolve(options.profileDir || `${outputDir}/chrome-profile`)
const loginUrl = `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`
const chromeBin = options.chrome || process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = Number(options.timeout || 10 * 60 * 1000)

let launchedChrome = null
let ws = null

main().catch(error => {
    console.error(`[qzone-capture] ${error.message}`)
    process.exitCode = 1
}).finally(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close()
    }
    if (launchedChrome && !options.keepOpen) {
        launchedChrome.kill('SIGTERM')
    }
})

async function main() {
    await mkdir(outputDir, { recursive: true })
    await mkdir(profileDir, { recursive: true })

    if (!options.attach) {
        launchedChrome = launchChrome()
    }

    const version = await waitForDevTools(port, timeoutMs)
    const target = await openQzoneTarget(port, loginUrl)
    ws = await connectWebSocket(target.webSocketDebuggerUrl || version.webSocketDebuggerUrl)
    const cdp = createCdpClient(ws)
    const capture = createCaptureState(cdp)

    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        capture.handleEvent(message)
    })

    await cdp.send('Network.enable', { maxResourceBufferSize: 1024 * 1024 * 80, maxTotalBufferSize: 1024 * 1024 * 120 })
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: loginUrl })

    console.log('[qzone-capture] Chrome is open. Log in to QQ Zone in that browser window.')
    console.log('[qzone-capture] After login, open the QQ Zone feed or click Shuoshuo/说说 if needed.')
    console.log(`[qzone-capture] Waiting for ${TARGET_CGI} for up to ${Math.round(timeoutMs / 1000)} seconds...`)

    const result = await capture.waitForMsgList(timeoutMs)
    const cookie = await getCookieHeader(cdp, result.cookie)
    const gtk = new URL(result.url).searchParams.get('g_tk') || qzoneGtk(cookie)
    const posts = Array.isArray(result.payload.msglist) ? result.payload.msglist : []

    const harPath = resolve(outputDir, 'qzone-capture.har')
    const fieldsPath = resolve(outputDir, 'qzone-fields.json')
    const cookiePath = resolve(outputDir, 'qzone-cookie.txt')

    await writeFile(harPath, `${JSON.stringify(buildHar(capture.entries), null, 2)}\n`, 'utf8')
    await writeFile(fieldsPath, `${JSON.stringify(buildFieldsReport({ url: result.url, cookie, gtk, posts }), null, 2)}\n`, 'utf8')
    await writeFile(cookiePath, cookie, { encoding: 'utf8', mode: 0o600 })

    await runNewsSync(harPath, limit)

    console.log(`[qzone-capture] Captured ${posts.length} posts from ${TARGET_CGI}.`)
    console.log(`[qzone-capture] Updated data/news.json through scripts/sync-qzone.mjs.`)
    console.log(`[qzone-capture] Non-secret field report: ${fieldsPath}`)
    console.log(`[qzone-capture] Temporary cookie file for GitHub Secret setup: ${cookiePath}`)
    console.log('[qzone-capture] Do not commit qzone-cookie.txt. Put its content only into the GitHub Actions secret QZONE_COOKIE.')
}

function launchChrome() {
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        loginUrl
    ]
    return spawn(chromeBin, args, { stdio: 'ignore' })
}

async function waitForDevTools(portNumber, timeout) {
    const deadline = Date.now() + timeout
    let lastError = null

    while (Date.now() < deadline) {
        try {
            return await fetchJson(`http://127.0.0.1:${portNumber}/json/version`)
        } catch (error) {
            lastError = error
            await delay(500)
        }
    }

    throw new Error(`Chrome DevTools did not start on port ${portNumber}: ${lastError?.message || 'timeout'}`)
}

async function openQzoneTarget(portNumber, url) {
    const targets = await fetchJson(`http://127.0.0.1:${portNumber}/json/list`)
    const target = targets.find(item => item.type === 'page' && item.url.includes('qzone.qq.com'))
        || targets.find(item => item.type === 'page')

    if (target?.webSocketDebuggerUrl) {
        return target
    }

    const created = await fetchJson(`http://127.0.0.1:${portNumber}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!created?.webSocketDebuggerUrl) {
        throw new Error('Could not create a Chrome DevTools page target.')
    }
    return created
}

function createCaptureState(cdp) {
    const requests = new Map()
    const entries = []
    let resolveMsgList = null
    let rejectMsgList = null
    let completed = false
    let timeoutId = null

    return {
        entries,
        handleEvent(message) {
            if (!message.method || completed) {
                return
            }

            const { method, params } = message
            if (method === 'Network.requestWillBeSent') {
                const request = params.request || {}
                requests.set(params.requestId, Object.assign(requests.get(params.requestId) || {}, {
                    requestId: params.requestId,
                    url: request.url || '',
                    method: request.method || 'GET',
                    requestHeaders: request.headers || {},
                    startedDateTime: new Date().toISOString()
                }))
                return
            }

            if (method === 'Network.requestWillBeSentExtraInfo') {
                requests.set(params.requestId, Object.assign(requests.get(params.requestId) || {}, {
                    requestHeaders: Object.assign({}, requests.get(params.requestId)?.requestHeaders || {}, params.headers || {})
                }))
                return
            }

            if (method === 'Network.responseReceived') {
                const response = params.response || {}
                requests.set(params.requestId, Object.assign(requests.get(params.requestId) || {}, {
                    requestId: params.requestId,
                    url: response.url || requests.get(params.requestId)?.url || '',
                    status: response.status,
                    mimeType: response.mimeType || '',
                    responseHeaders: response.headers || {}
                }))
                return
            }

            if (method === 'Network.loadingFinished') {
                const record = requests.get(params.requestId)
                if (!record || !isQzoneMoodApi(record.url)) {
                    return
                }

                cdp.send('Network.getResponseBody', { requestId: params.requestId })
                    .then(body => {
                        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
                        const payload = parseJsonp(text)
                        const entry = Object.assign(record, { text, payload })
                        entries.push(entry)

                        if (!completed && record.url.includes(TARGET_CGI) && Array.isArray(payload.msglist) && payload.msglist.length) {
                            completed = true
                            clearCaptureTimeout()
                            resolveMsgList?.(entry)
                        }
                    })
                    .catch(error => {
                        if (!completed && record.url.includes(TARGET_CGI)) {
                            completed = true
                            clearCaptureTimeout()
                            rejectMsgList?.(error)
                        }
                    })
            }
        },
        waitForMsgList(timeout) {
            return new Promise((resolve, reject) => {
                resolveMsgList = resolve
                rejectMsgList = reject
                timeoutId = setTimeout(() => {
                    if (!completed) {
                        completed = true
                        reject(new Error(`Timed out waiting for ${TARGET_CGI}. Make sure QQ Zone is logged in and the feed/说说 page is open.`))
                    }
                }, timeout)
            })
        }
    }

    function clearCaptureTimeout() {
        if (timeoutId) {
            clearTimeout(timeoutId)
            timeoutId = null
        }
    }
}

function isQzoneMoodApi(url) {
    return String(url || '').includes(TARGET_CGI) || String(url || '').includes(DETAIL_CGI)
}

async function getCookieHeader(cdp, fallbackCookie) {
    const result = await cdp.send('Network.getCookies', {
        urls: [
            'https://user.qzone.qq.com/',
            'https://taotao.qq.com/',
            `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`
        ]
    })
    const cookies = Array.isArray(result.cookies) ? result.cookies : []
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ')

    return cookie || fallbackCookie || ''
}

function buildHar(entries) {
    return {
        log: {
            version: '1.2',
            creator: {
                name: 'qzone-capture-session',
                version: '1.0.0'
            },
            entries: entries.map(entry => ({
                startedDateTime: entry.startedDateTime || new Date().toISOString(),
                time: 0,
                request: {
                    method: entry.method || 'GET',
                    url: entry.url,
                    httpVersion: 'HTTP/2',
                    headers: headerObjectToHarHeaders(stripSensitiveHeaders(entry.requestHeaders)),
                    queryString: [...new URL(entry.url).searchParams.entries()].map(([name, value]) => ({ name, value })),
                    cookies: [],
                    headersSize: -1,
                    bodySize: 0
                },
                response: {
                    status: entry.status || 200,
                    statusText: '',
                    httpVersion: 'HTTP/2',
                    headers: headerObjectToHarHeaders(entry.responseHeaders),
                    cookies: [],
                    content: {
                        size: Buffer.byteLength(entry.text || '', 'utf8'),
                        mimeType: entry.mimeType || 'text/html; charset=UTF-8',
                        text: entry.text || ''
                    },
                    redirectURL: '',
                    headersSize: -1,
                    bodySize: -1
                },
                cache: {},
                timings: {
                    send: 0,
                    wait: 0,
                    receive: 0
                }
            }))
        }
    }
}

function buildFieldsReport({ url, cookie, gtk, posts }) {
    const parsed = new URL(url)
    const sample = posts[0] || {}
    const samplePic = Array.isArray(sample.pic) ? sample.pic[0] || {} : {}
    const cookieNames = cookie.split(';').map(item => item.trim().split('=')[0]).filter(Boolean)

    return {
        captured_at: new Date().toISOString(),
        endpoint: `${parsed.origin}${parsed.pathname}`,
        request_params: Object.fromEntries(parsed.searchParams.entries()),
        uin,
        g_tk: String(gtk),
        g_tk_source: parsed.searchParams.get('g_tk') ? 'request_url' : 'computed_from_cookie',
        cookie_names: cookieNames,
        has_p_skey: cookieNames.includes('p_skey'),
        has_skey: cookieNames.includes('skey'),
        msg_count: posts.length,
        required_post_fields: {
            id: ['tid', 'id'],
            date: ['created_time', 'createdTime', 'create_time', 'time'],
            text: ['content', 'conlist', 'shortcon', 'summary'],
            images: ['pic', 'pics', 'images', 'photo', 'photos', 'photolist']
        },
        sample_post_keys: Object.keys(sample).sort(),
        sample_pic_keys: Object.keys(samplePic).sort()
    }
}

function stripSensitiveHeaders(headers = {}) {
    return Object.fromEntries(Object.entries(headers).filter(([key]) => !/^cookie$/i.test(key)))
}

function headerObjectToHarHeaders(headers = {}) {
    return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}

async function runNewsSync(harPath, syncLimit) {
    await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, ['scripts/sync-qzone.mjs'], {
            cwd: ROOT_DIR,
            env: Object.assign({}, process.env, {
                QZONE_HAR_PATH: harPath,
                QZONE_LIMIT: String(syncLimit)
            }),
            stdio: 'inherit'
        })

        child.on('exit', code => {
            if (code === 0) {
                resolvePromise()
            } else {
                rejectPromise(new Error(`scripts/sync-qzone.mjs exited with ${code}`))
            }
        })
        child.on('error', rejectPromise)
    })
}

function createCdpClient(socket) {
    let id = 0
    const pending = new Map()

    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        if (!message.id || !pending.has(message.id)) {
            return
        }

        const { resolve: resolvePromise, reject: rejectPromise } = pending.get(message.id)
        pending.delete(message.id)

        if (message.error) {
            rejectPromise(new Error(message.error.message || 'Chrome DevTools command failed.'))
        } else {
            resolvePromise(message.result || {})
        }
    })

    return {
        send(method, params = {}) {
            return new Promise((resolvePromise, rejectPromise) => {
                const commandId = id += 1
                pending.set(commandId, { resolve: resolvePromise, reject: rejectPromise })
                socket.send(JSON.stringify({ id: commandId, method, params }))
            })
        }
    }
}

function connectWebSocket(url) {
    return new Promise((resolvePromise, rejectPromise) => {
        const socket = new WebSocket(url)
        socket.addEventListener('open', () => resolvePromise(socket), { once: true })
        socket.addEventListener('error', () => rejectPromise(new Error(`Could not connect to ${url}`)), { once: true })
    })
}

async function fetchJson(url, init) {
    const response = await fetch(url, init)
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return response.json()
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

function parseArgs(args) {
    const parsed = {}

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--attach') {
            parsed.attach = true
        } else if (arg === '--keep-open') {
            parsed.keepOpen = true
        } else if (arg.startsWith('--')) {
            const key = arg.slice(2).replace(/-([a-z])/g, (_, value) => value.toUpperCase())
            parsed[key] = args[index + 1]
            index += 1
        }
    }

    return parsed
}

function delay(ms) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}
