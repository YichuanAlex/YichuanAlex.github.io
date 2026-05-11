const content_dir = 'contents/'
const config_file = 'config.yml'
const section_names = ['home', 'publications', 'news']
const visitorEarthState = {
    stats: {},
    current: null,
    stars: [],
    animationStarted: false,
    globe: {
        renderer: null,
        scene: null,
        camera: null,
        group: null,
        pinGroup: null,
        interactivePins: [],
        raycaster: null,
        pointer: null,
        pointerActive: false,
        dragging: false,
        lastPointer: { x: 0, y: 0 },
        targetScale: 1,
        scale: 1,
        interactionsAttached: false
    }
}

window.addEventListener('DOMContentLoaded', () => {
    loadConfig()
    loadMarkdownSections()
    loadNewsFeed()
    initVisitorEarthCanvas()
    loadRepositoryStats()
    initVisitorStats()
})

function loadConfig() {
    fetch(content_dir + config_file)
        .then(response => response.text())
        .then(text => {
            const yml = jsyaml.load(text)
            Object.keys(yml).forEach(key => {
                const node = document.getElementById(key)
                if (node) {
                    node.innerHTML = yml[key]
                }
            })
        })
        .catch(error => console.log(error))
}

function loadMarkdownSections() {
    marked.use({ mangle: false, headerIds: false })
    const requests = section_names.map((name) => {
        return fetch(content_dir + name + '.md')
            .then(response => response.text())
            .then(markdown => {
                const node = document.getElementById(name + '-md')
                if (node) {
                    node.innerHTML = marked.parse(markdown)
                }
            })
            .catch(error => console.log(error))
    })

    Promise.allSettled(requests).then(scrollToHashTarget)
}

function scrollToHashTarget() {
    if (!window.location.hash) {
        return
    }

    const target = document.querySelector(window.location.hash)
    if (target) {
        window.setTimeout(() => target.scrollIntoView(), 0)
    }
}

function loadNewsFeed() {
    fetch('data/news.json', { cache: 'no-store' })
        .then(response => response.json())
        .then(renderNewsFeed)
        .catch(() => {
            const node = document.getElementById('news-feed')
            if (node) {
                node.innerHTML = '<p class="news-empty">News data is temporarily unavailable.</p>'
            }
        })
}

function renderNewsFeed(data) {
    const node = document.getElementById('news-feed')

    if (!node) {
        return
    }

    const manualItems = Array.isArray(data.manual) ? data.manual.map(item => Object.assign({ source: 'Personal' }, item)) : []
    const qzoneItems = data.qzone && Array.isArray(data.qzone.items)
        ? data.qzone.items.map(item => Object.assign({ source: 'QQ Zone' }, item))
        : []
    const items = manualItems.concat(qzoneItems)
        .sort((a, b) => new Date(b.date || b.time || 0) - new Date(a.date || a.time || 0))

    const qzone = data.qzone || {}
    const qzoneStatus = qzone.items && qzone.items.length
        ? `Last synced ${formatDate(qzone.last_synced_at)}`
        : (qzone.sync_status || 'QQ Zone sync is ready. Add QZONE_COOKIE in GitHub Actions to fetch posts.')

    node.innerHTML = `
        <div class="news-source-panel">
            <div>
                <h3>Personal Updates and Life</h3>
                <p>Research notes, homepage updates, and QQ Zone life posts are rendered as a single feed.</p>
            </div>
            <a href="${escapeAttribute(qzone.profile_url || 'https://user.qzone.qq.com/1527435659')}" target="_blank" rel="noopener">QQ Zone</a>
        </div>
        <div class="qzone-status">
            <strong>QQ Zone Sync</strong>
            <span>${escapeHtml(qzoneStatus)}</span>
        </div>
        <div class="news-list">
            ${items.length ? items.map(renderNewsItem).join('') : '<p class="news-empty">No news items yet.</p>'}
        </div>
    `
}

function renderNewsItem(item) {
    const date = formatDate(item.date || item.time)
    const title = item.title || (item.source === 'QQ Zone' ? 'QQ Zone Post' : 'Update')
    const body = item.body || item.content || ''
    const images = Array.isArray(item.images) ? item.images.slice(0, 3) : []

    return `
        <article class="news-item">
            <div class="news-meta">
                <span>${escapeHtml(item.source || 'Personal')}</span>
                <time>${escapeHtml(date)}</time>
            </div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(body)}</p>
            ${images.length ? `<div class="news-images">${images.map(src => `<img src="${escapeAttribute(src)}" alt="">`).join('')}</div>` : ''}
            ${item.url ? `<a class="news-link" href="${escapeAttribute(item.url)}" target="_blank" rel="noopener">Open original</a>` : ''}
        </article>
    `
}

function formatDate(value) {
    if (!value) {
        return 'Pending'
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        return String(value)
    }
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function initVisitorStats() {
    const regionNode = document.getElementById('visitor-region')
    const statusNode = document.getElementById('visitor-log-status')

    if (!regionNode) {
        return
    }

    getVisitorRegion()
        .then(data => {
            const parts = [data.city, data.region, data.country].filter(Boolean)
            const location = parts.length ? parts.join(', ') : 'Approximate region unavailable'
            const timezone = data.timezone ? ` · ${data.timezone}` : ''
            regionNode.textContent = `${location}${timezone}`
            visitorEarthState.current = Object.assign({ time: new Date().toISOString() }, data)
            renderEarthDashboard()
            submitVisitorEvent(data, statusNode)
        })
        .catch(() => {
            const fallback = inferVisitFromTimezone()
            const parts = [fallback.city, fallback.region, fallback.country].filter(Boolean)
            const location = parts.length ? parts.join(', ') : 'Approximate region unavailable'
            regionNode.textContent = fallback.country === 'Unknown' ? location : `${location} · ${fallback.timezone}`
            visitorEarthState.current = fallback
            renderEarthDashboard()
            submitVisitorEvent(fallback, statusNode)
        })
}

function loadRepositoryStats() {
    fetch('data/visitor-stats.json', { cache: 'no-store' })
        .then(response => response.json())
        .then(applyRepositoryStats)
        .catch(() => {
            setText('repo_updated_at', 'Pending')
        })
}

function applyRepositoryStats(data) {
    visitorEarthState.stats = data || {}
    const regions = data.regions || {}
    const countries = data.countries || {}
    const regionRows = Object.entries(regions)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 5)

    setText('repo_total_visits', Number(data.total_visits || 0).toLocaleString())
    setText('repo_unique_visitors', Number(data.unique_visitors || 0).toLocaleString())
    setText('repo_top_region', regionRows.length ? regionRows[0][0] : 'Pending')
    setText('repo_region_list', regionRows.length ? regionRows.map(([region, count]) => `${region}: ${count}`).join(' · ') : 'No repository-backed visits recorded yet.')
    setText('repo_updated_at', data.updated_at ? new Date(data.updated_at).toLocaleString() : 'Pending')
    setText('earth_total_visits', Number(data.total_visits || 0).toLocaleString())
    setText('earth_country_count', Object.keys(countries).length.toLocaleString())
    renderEarthDashboard()
}

function setText(id, value) {
    const node = document.getElementById(id)
    if (node) {
        node.textContent = value
    }
}

function getVisitorRegion() {
    const providers = [
        {
            url: 'https://geo.kamero.ai/api/geo',
            normalize: (data) => ({
                city: data.city,
                region: data.countryRegion,
                country: data.country,
                latitude: data.latitude,
                longitude: data.longitude,
                timezone: data.timezone
            })
        },
        {
            url: 'https://api.country.is/?fields=city,continent,subdivision,location,asn',
            normalize: (data) => ({
                city: data.city,
                region: data.subdivision,
                country: data.country,
                latitude: data.location && data.location.latitude,
                longitude: data.location && data.location.longitude,
                timezone: data.location && data.location.time_zone
            })
        },
        {
            url: 'https://apip.cc/json',
            normalize: (data) => ({
                city: data.City,
                region: data.RegionName,
                country: data.CountryName,
                latitude: data.Latitude,
                longitude: data.Longitude,
                timezone: data.TimeZone
            })
        }
    ]

    return providers.reduce((chain, provider) => {
        return chain.catch(() => fetchJsonWithTimeout(provider.url, 1800)
            .then(provider.normalize)
            .then(data => {
                if (!data || data.country === undefined) {
                    throw new Error('Geo provider returned incomplete data')
                }
                return data
            }))
    }, Promise.reject())
}

function fetchJsonWithTimeout(url, timeout) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), timeout)

    return fetch(url, { signal: controller.signal })
        .then(response => {
            if (!response.ok) {
                throw new Error('Geo provider unavailable')
            }
            return response.json()
        })
        .finally(() => window.clearTimeout(timer))
}

function initVisitorEarthCanvas() {
    const canvas = document.getElementById('visitor-earth-canvas')

    if (!canvas) {
        return
    }

    visitorEarthState.stars = buildStarField(160)
    try {
        initThreeVisitorGlobe(canvas)
    } catch (error) {
        console.log('Three.js visitor globe unavailable; falling back to canvas renderer.', error)
        resetThreeVisitorGlobe()
    }
    if (!visitorEarthState.animationStarted) {
        visitorEarthState.animationStarted = true
        requestAnimationFrame(drawVisitorEarth)
    }

    window.addEventListener('resize', () => {
        if (visitorEarthState.globe.renderer) {
            resizeThreeGlobe()
        } else {
            resizeEarthCanvas(canvas)
        }
    })
}

function renderEarthDashboard() {
    const stats = visitorEarthState.stats || {}
    const visits = collectEarthVisits()
    const countries = new Set(Object.keys(stats.countries || {}))

    visits.forEach(visit => {
        if (visit.country && visit.country !== 'Unknown') {
            countries.add(visit.country)
        }
    })

    setText('earth_total_visits', Math.max(Number(stats.total_visits || 0), visits.length ? 1 : 0).toLocaleString())
    setText('earth_country_count', countries.size.toLocaleString())
    renderLatestVisitors(visits)
    syncGlobePins(visits)
}

function collectEarthVisits() {
    const stats = visitorEarthState.stats || {}
    const recent = Array.isArray(stats.recent_visits) ? stats.recent_visits : []
    const rows = recent.map(visit => normaliseVisit(visit, false))

    if (visitorEarthState.current) {
        rows.unshift(normaliseVisit(visitorEarthState.current, true))
    }

    return rows.filter(Boolean).slice(0, 24)
}

function normaliseVisit(visit, isCurrent) {
    const country = visit.country || 'Unknown'
    const region = visit.region || ''
    const city = visit.city || ''
    const inferred = coordinatesForLocation(country, region, city)
    const latitude = numberOrFallback(visit.latitude, inferred && inferred.latitude)
    const longitude = numberOrFallback(visit.longitude, inferred && inferred.longitude)

    return {
        country,
        region,
        city,
        latitude,
        longitude,
        time: visit.time || new Date().toISOString(),
        timezone: visit.timezone || '',
        visitor: visit.visitor || (isCurrent ? 'current' : ''),
        isCurrent
    }
}

function inferVisitFromTimezone() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    const locations = {
        'Asia/Shanghai': { country: 'China', region: 'China', city: 'Shanghai', latitude: 31.2304, longitude: 121.4737 },
        'Asia/Chongqing': { country: 'China', region: 'China', city: 'Chongqing', latitude: 29.563, longitude: 106.5516 },
        'Asia/Tokyo': { country: 'Japan', region: 'Tokyo', city: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
        'Asia/Singapore': { country: 'Singapore', region: 'Singapore', city: 'Singapore', latitude: 1.3521, longitude: 103.8198 },
        'America/New_York': { country: 'United States', region: 'New York', city: 'New York', latitude: 40.7128, longitude: -74.006 },
        'America/Los_Angeles': { country: 'United States', region: 'California', city: 'Los Angeles', latitude: 34.0522, longitude: -118.2437 },
        'Europe/London': { country: 'United Kingdom', region: 'England', city: 'London', latitude: 51.5072, longitude: -0.1276 },
        'Europe/Berlin': { country: 'Germany', region: 'Hesse', city: 'Frankfurt', latitude: 50.1109, longitude: 8.6821 }
    }

    return Object.assign({
        country: 'Unknown',
        region: '',
        city: '',
        latitude: '',
        longitude: '',
        timezone,
        time: new Date().toISOString()
    }, locations[timezone] || {})
}

function renderLatestVisitors(visits) {
    const node = document.getElementById('earth_latest_visitors')

    if (!node) {
        return
    }

    const rows = visits.slice(0, 12)

    if (!rows.length) {
        node.innerHTML = '<p>No repository-backed visits recorded yet.</p>'
        return
    }

    node.innerHTML = rows.map(visit => {
        const place = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Unknown region'
        const visitor = visit.isCurrent ? 'Current browser session' : (visit.visitor ? `Visitor ${visit.visitor}` : 'Repository record')
        return `
            <div class="earth-visitor-item">
                <span class="flag-chip">${escapeHtml(countryCode(visit.country))}</span>
                <span class="earth-visitor-meta">
                    <strong>${escapeHtml(place)}</strong>
                    <span>${escapeHtml(visitor)}</span>
                </span>
                <span class="earth-visitor-time">${escapeHtml(relativeTime(visit.time))}</span>
            </div>
        `
    }).join('')
}

function initThreeVisitorGlobe(canvas) {
    const THREE = window.THREE
    const globe = visitorEarthState.globe

    if (!THREE || globe.renderer) {
        return
    }

    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
    camera.position.set(0, 0, 3.9)

    const group = new THREE.Group()
    group.rotation.x = toRadians(-8)
    scene.add(group)

    const earthMaterial = new THREE.MeshPhongMaterial({
        map: createEarthTexture(THREE),
        specular: new THREE.Color(0x0f3a5f),
        shininess: 18
    })
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMaterial)
    group.add(earth)

    const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(1.012, 96, 96),
        new THREE.MeshLambertMaterial({
            map: createCloudTexture(THREE),
            transparent: true,
            opacity: 0.24,
            depthWrite: false
        })
    )
    group.add(clouds)

    const pinGroup = new THREE.Group()
    group.add(pinGroup)

    const ambient = new THREE.AmbientLight(0xffffff, 1.9)
    const sun = new THREE.DirectionalLight(0xffffff, 2.25)
    sun.position.set(-2.2, 1.4, 3.2)
    const rim = new THREE.DirectionalLight(0x60a5fa, 0.75)
    rim.position.set(2.8, -1.2, -2.4)
    scene.add(ambient, sun, rim)
    scene.add(createStarPoints(THREE))

    Object.assign(globe, {
        renderer,
        scene,
        camera,
        group,
        clouds,
        pinGroup,
        raycaster: new THREE.Raycaster(),
        pointer: new THREE.Vector2(-4, -4),
        pointerActive: false,
        targetScale: 1,
        scale: 1,
        interactivePins: []
    })

    focusThreeGlobe()
    attachGlobeInteractions(canvas)
    resizeThreeGlobe()
    syncGlobePins(collectEarthVisits())
    setText('visitor-log-status', 'Drag · zoom · hover visitor')
}

function resetThreeVisitorGlobe() {
    Object.assign(visitorEarthState.globe, {
        renderer: null,
        scene: null,
        camera: null,
        group: null,
        pinGroup: null,
        interactivePins: [],
        raycaster: null,
        pointer: null,
        pointerActive: false,
        dragging: false
    })
}

function createEarthTexture(THREE) {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    const ocean = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
    ocean.addColorStop(0, '#0b3d91')
    ocean.addColorStop(0.36, '#1261c4')
    ocean.addColorStop(0.68, '#071f57')
    ocean.addColorStop(1, '#02142d')
    ctx.fillStyle = ocean
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.globalAlpha = 0.28
    ctx.strokeStyle = '#8bd3ff'
    ctx.lineWidth = 1
    for (let lon = -150; lon <= 180; lon += 30) {
        const x = lonToTextureX(lon, canvas.width)
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, canvas.height)
        ctx.stroke()
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        const y = latToTextureY(lat, canvas.height)
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(canvas.width, y)
        ctx.stroke()
    }
    ctx.restore()

    landMasses().forEach((land, index) => {
        ctx.beginPath()
        land.points.forEach(([lat, lon], pointIndex) => {
            const x = lonToTextureX(lon, canvas.width)
            const y = latToTextureY(lat, canvas.height)
            if (pointIndex === 0) {
                ctx.moveTo(x, y)
            } else {
                ctx.lineTo(x, y)
            }
        })
        ctx.closePath()
        ctx.fillStyle = index % 2 ? '#b8a960' : '#4f9b5c'
        ctx.fill()
        ctx.strokeStyle = 'rgba(245, 245, 220, 0.52)'
        ctx.lineWidth = 2
        ctx.stroke()
    })

    const texture = new THREE.CanvasTexture(canvas)
    if (THREE.SRGBColorSpace) {
        texture.colorSpace = THREE.SRGBColorSpace
    }
    texture.anisotropy = 4
    return texture
}

function createCloudTexture(THREE) {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)'
    ctx.lineWidth = 11
    for (let index = 0; index < 12; index += 1) {
        const y = 80 + index * 32
        ctx.beginPath()
        for (let x = -40; x <= canvas.width + 40; x += 24) {
            const wave = Math.sin(x * 0.015 + index) * 9
            if (x === -40) {
                ctx.moveTo(x, y + wave)
            } else {
                ctx.lineTo(x, y + wave)
            }
        }
        ctx.stroke()
    }
    const texture = new THREE.CanvasTexture(canvas)
    if (THREE.SRGBColorSpace) {
        texture.colorSpace = THREE.SRGBColorSpace
    }
    return texture
}

function createStarPoints(THREE) {
    const geometry = new THREE.BufferGeometry()
    const positions = []
    let seed = 991
    const random = () => {
        seed = (seed * 48271) % 2147483647
        return (seed - 1) / 2147483646
    }

    for (let index = 0; index < 260; index += 1) {
        positions.push((random() - 0.5) * 7.8, (random() - 0.5) * 4.8, -2.4 - random() * 1.8)
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return new THREE.Points(geometry, new THREE.PointsMaterial({
        color: 0xdbeafe,
        size: 0.012,
        transparent: true,
        opacity: 0.78
    }))
}

function attachGlobeInteractions(canvas) {
    const globe = visitorEarthState.globe

    if (globe.interactionsAttached) {
        return
    }

    canvas.addEventListener('pointerdown', event => {
        globe.dragging = true
        globe.lastPointer = { x: event.clientX, y: event.clientY }
        canvas.setPointerCapture(event.pointerId)
    })

    canvas.addEventListener('pointermove', event => {
        updateGlobePointer(event)
        if (!globe.dragging || !globe.group) {
            return
        }

        const deltaX = event.clientX - globe.lastPointer.x
        const deltaY = event.clientY - globe.lastPointer.y
        globe.group.rotation.y += deltaX * 0.0065
        globe.group.rotation.x = clamp(globe.group.rotation.x + deltaY * 0.0045, -1.05, 1.05)
        globe.lastPointer = { x: event.clientX, y: event.clientY }
        hideGlobeTooltip()
    })

    canvas.addEventListener('pointerup', event => {
        globe.dragging = false
        if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId)
        }
    })

    canvas.addEventListener('pointercancel', () => {
        globe.dragging = false
    })

    canvas.addEventListener('pointerleave', () => {
        globe.pointerActive = false
        globe.dragging = false
        hideGlobeTooltip()
    })

    canvas.addEventListener('wheel', event => {
        event.preventDefault()
        globe.targetScale = clamp(globe.targetScale + (event.deltaY > 0 ? -0.08 : 0.08), 0.82, 1.42)
    }, { passive: false })

    globe.interactionsAttached = true
}

function updateGlobePointer(event) {
    const globe = visitorEarthState.globe
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    globe.pointer.x = (x / rect.width) * 2 - 1
    globe.pointer.y = -(y / rect.height) * 2 + 1
    globe.pointerActive = true
    globe.pointerScreen = { x, y }
}

function syncGlobePins(visits) {
    const THREE = window.THREE
    const globe = visitorEarthState.globe

    if (!THREE || !globe.pinGroup) {
        return
    }

    while (globe.pinGroup.children.length) {
        globe.pinGroup.remove(globe.pinGroup.children[0])
    }

    globe.interactivePins = []
    visits.slice(0, 18).forEach((visit, index) => {
        if (!Number.isFinite(visit.latitude) || !Number.isFinite(visit.longitude)) {
            return
        }

        const base = latLonToVector3(THREE, visit.latitude, visit.longitude, 1.03)
        const pinMaterial = new THREE.MeshBasicMaterial({ color: visit.isCurrent ? 0xfacc15 : 0xef4444 })
        const pin = new THREE.Mesh(new THREE.SphereGeometry(visit.isCurrent ? 0.035 : 0.025, 18, 18), pinMaterial)
        pin.position.copy(base)
        pin.userData.visit = visit
        globe.pinGroup.add(pin)
        globe.interactivePins.push(pin)

        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: createPinGlowTexture(THREE, visit.isCurrent ? '#facc15' : '#ef4444'),
            transparent: true,
            opacity: visit.isCurrent ? 0.72 : 0.5,
            depthWrite: false
        }))
        glow.position.copy(latLonToVector3(THREE, visit.latitude, visit.longitude, 1.04))
        glow.scale.set(visit.isCurrent ? 0.28 : 0.18, visit.isCurrent ? 0.28 : 0.18, 1)
        glow.userData.visit = visit
        globe.pinGroup.add(glow)

        if (visit.isCurrent || index < 2) {
            const label = createGlobeLabel(THREE, visit)
            label.position.copy(latLonToVector3(THREE, visit.latitude, visit.longitude, 1.2))
            globe.pinGroup.add(label)
        }
    })

    focusThreeGlobe()
}

function createPinGlowTexture(THREE, color) {
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createRadialGradient(48, 48, 4, 48, 48, 46)
    gradient.addColorStop(0, color)
    gradient.addColorStop(0.34, `${color}99`)
    gradient.addColorStop(1, `${color}00`)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(48, 48, 46, 0, Math.PI * 2)
    ctx.fill()
    return new THREE.CanvasTexture(canvas)
}

function createGlobeLabel(THREE, visit) {
    const label = [visit.city, visit.region || visit.country].filter(Boolean).join(', ') || 'Visitor'
    const text = label.slice(0, 24)
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 96
    const ctx = canvas.getContext('2d')
    ctx.font = '700 30px Inter, sans-serif'
    const textWidth = Math.min(340, ctx.measureText(text).width + 44)
    const x = (canvas.width - textWidth) / 2
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)'
    roundRect(ctx, x, 20, textWidth, 48, 9)
    ctx.fill()
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.5)'
    ctx.stroke()
    ctx.fillStyle = '#e0f2fe'
    ctx.fillText(text, x + 22, 53)

    const texture = new THREE.CanvasTexture(canvas)
    if (THREE.SRGBColorSpace) {
        texture.colorSpace = THREE.SRGBColorSpace
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false
    }))
    sprite.scale.set(0.72, 0.18, 1)
    return sprite
}

function drawThreeVisitorGlobe() {
    const globe = visitorEarthState.globe

    if (!globe.renderer || !globe.scene || !globe.camera || !globe.group) {
        return false
    }

    resizeThreeGlobe()

    if (!globe.dragging) {
        globe.group.rotation.y += 0.0022
        if (globe.clouds) {
            globe.clouds.rotation.y += 0.0007
        }
    }

    globe.scale += (globe.targetScale - globe.scale) * 0.08
    globe.group.scale.setScalar(globe.scale)
    updateGlobeHover()
    globe.renderer.render(globe.scene, globe.camera)
    return true
}

function resizeThreeGlobe() {
    const globe = visitorEarthState.globe

    if (!globe.renderer || !globe.camera) {
        return
    }

    const canvas = globe.renderer.domElement
    const width = Math.max(120, Math.floor(canvas.clientWidth || canvas.getBoundingClientRect().width || 240))
    const height = Math.max(120, Math.floor(canvas.clientHeight || canvas.getBoundingClientRect().height || 240))
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)

    globe.renderer.setPixelRatio(pixelRatio)
    globe.renderer.setSize(width, height, false)
    globe.camera.aspect = width / height
    globe.camera.updateProjectionMatrix()
}

function updateGlobeHover() {
    const globe = visitorEarthState.globe

    if (!globe.pointerActive || globe.dragging || !globe.interactivePins.length) {
        hideGlobeTooltip()
        return
    }

    globe.raycaster.setFromCamera(globe.pointer, globe.camera)
    const [hit] = globe.raycaster.intersectObjects(globe.interactivePins, false)

    if (!hit || !hit.object.userData.visit) {
        hideGlobeTooltip()
        return
    }

    showGlobeTooltip(hit.object.userData.visit, globe.pointerScreen)
}

function showGlobeTooltip(visit, pointer) {
    const tooltip = document.getElementById('visitor-earth-tooltip')

    if (!tooltip || !pointer) {
        return
    }

    const place = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Unknown region'
    tooltip.textContent = `${place} · ${relativeTime(visit.time)}`
    tooltip.style.display = 'block'
    tooltip.style.left = `${Math.max(18, Math.min(pointer.x, tooltip.parentElement.clientWidth - 18))}px`
    tooltip.style.top = `${Math.max(18, pointer.y - 12)}px`
}

function hideGlobeTooltip() {
    const tooltip = document.getElementById('visitor-earth-tooltip')

    if (tooltip) {
        tooltip.style.display = 'none'
    }
}

function focusThreeGlobe() {
    const globe = visitorEarthState.globe

    if (!globe.group || globe.dragging) {
        return
    }

    const focus = collectEarthVisits().find(visit => Number.isFinite(visit.longitude))
    if (focus && !globe.hasFocused) {
        globe.group.rotation.y = toRadians(Number(focus.longitude) + 180)
        globe.hasFocused = true
    }
}

function latLonToVector3(THREE, latitudeValue, longitudeValue, radius) {
    const latitude = toRadians(Number(latitudeValue))
    const longitude = toRadians(Number(longitudeValue) + 180)
    return new THREE.Vector3(
        -radius * Math.sin(longitude) * Math.cos(latitude),
        radius * Math.sin(latitude),
        radius * Math.cos(longitude) * Math.cos(latitude)
    )
}

function lonToTextureX(lon, width) {
    return ((Number(lon) + 180) / 360) * width
}

function latToTextureY(lat, height) {
    return ((90 - Number(lat)) / 180) * height
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
}

function drawVisitorEarth() {
    if (drawThreeVisitorGlobe()) {
        requestAnimationFrame(drawVisitorEarth)
        return
    }

    const canvas = document.getElementById('visitor-earth-canvas')

    if (!canvas) {
        visitorEarthState.animationStarted = false
        return
    }

    const ctx = canvas.getContext('2d')
    const size = resizeEarthCanvas(canvas)
    const width = size.width
    const height = size.height
    const now = Date.now()
    const radius = Math.min(width * 0.43, height * 0.45)
    const centerX = width * 0.5
    const centerY = height * 0.5
    const centerLon = earthFocusLongitude() + Math.sin(now * 0.00008) * 6
    const centerLat = 8

    ctx.clearRect(0, 0, width, height)
    drawStars(ctx, width, height)
    drawEarthHalo(ctx, centerX, centerY, radius)
    drawEarthSphere(ctx, centerX, centerY, radius)

    ctx.save()
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.clip()
    drawEarthGrid(ctx, centerX, centerY, radius, centerLon, centerLat)
    drawLandmasses(ctx, centerX, centerY, radius, centerLon, centerLat)
    drawCloudBands(ctx, centerX, centerY, radius)
    ctx.restore()

    drawEarthShadow(ctx, centerX, centerY, radius)
    drawVisitPins(ctx, centerX, centerY, radius, centerLon, centerLat, collectEarthVisits())

    requestAnimationFrame(drawVisitorEarth)
}

function earthFocusLongitude() {
    const focus = collectEarthVisits().find(visit => Number.isFinite(visit.longitude))
    return focus ? Number(focus.longitude) : 24
}

function resizeEarthCanvas(canvas) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(320, Math.floor(rect.width || 900))
    const height = Math.max(320, Math.floor(rect.height || 520))
    const pixelWidth = Math.floor(width * ratio)
    const pixelHeight = Math.floor(height * ratio)

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
    }

    const ctx = canvas.getContext('2d')
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    return { width, height }
}

function buildStarField(count) {
    let seed = 7291
    const random = () => {
        seed = (seed * 16807) % 2147483647
        return (seed - 1) / 2147483646
    }

    return Array.from({ length: count }, () => ({
        x: random(),
        y: random(),
        radius: 0.35 + random() * 1.1,
        alpha: 0.22 + random() * 0.62
    }))
}

function drawStars(ctx, width, height) {
    ctx.save()
    visitorEarthState.stars.forEach(star => {
        ctx.globalAlpha = star.alpha
        ctx.beginPath()
        ctx.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2)
        ctx.fillStyle = '#e2e8f0'
        ctx.fill()
    })
    ctx.restore()
}

function drawEarthHalo(ctx, x, y, radius) {
    const glow = ctx.createRadialGradient(x, y, radius * 0.8, x, y, radius * 1.46)
    glow.addColorStop(0, 'rgba(56, 189, 248, 0.16)')
    glow.addColorStop(0.42, 'rgba(59, 130, 246, 0.11)')
    glow.addColorStop(1, 'rgba(59, 130, 246, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, y, radius * 1.46, 0, Math.PI * 2)
    ctx.fill()
}

function drawEarthSphere(ctx, x, y, radius) {
    const ocean = ctx.createRadialGradient(x - radius * 0.38, y - radius * 0.33, radius * 0.1, x, y, radius)
    ocean.addColorStop(0, '#7dd3fc')
    ocean.addColorStop(0.2, '#1d4ed8')
    ocean.addColorStop(0.58, '#0f2e68')
    ocean.addColorStop(1, '#061323')
    ctx.fillStyle = ocean
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(147, 197, 253, 0.28)'
    ctx.stroke()
}

function drawEarthGrid(ctx, x, y, radius, centerLon, centerLat) {
    ctx.save()
    ctx.strokeStyle = 'rgba(191, 219, 254, 0.14)'
    ctx.lineWidth = 0.8

    for (let lat = -60; lat <= 60; lat += 30) {
        drawProjectedLine(ctx, x, y, radius, centerLon, centerLat, Array.from({ length: 121 }, (_, i) => [lat, -180 + i * 3]))
    }

    for (let lon = -180; lon <= 180; lon += 30) {
        drawProjectedLine(ctx, x, y, radius, centerLon, centerLat, Array.from({ length: 81 }, (_, i) => [-80 + i * 2, lon]))
    }

    ctx.restore()
}

function drawLandmasses(ctx, x, y, radius, centerLon, centerLat) {
    landMasses().forEach((land, index) => {
        ctx.beginPath()
        let started = false

        land.points.forEach(([lat, lon]) => {
            const point = projectGlobePoint(lat, lon, x, y, radius, centerLon, centerLat)
            if (!point || point.visibility < 0.05) {
                started = false
                return
            }
            if (!started) {
                ctx.moveTo(point.x, point.y)
                started = true
            } else {
                ctx.lineTo(point.x, point.y)
            }
        })

        ctx.closePath()
        const gradient = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius)
        gradient.addColorStop(0, index % 2 ? '#d9c37a' : '#3f8f55')
        gradient.addColorStop(0.58, index % 2 ? '#7f9d58' : '#7ca95c')
        gradient.addColorStop(1, '#6f4f2d')
        ctx.fillStyle = gradient
        ctx.globalAlpha = 0.92
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = 'rgba(240, 253, 250, 0.18)'
        ctx.lineWidth = 0.8
        ctx.stroke()
    })
}

function drawCloudBands(ctx, x, y, radius) {
    ctx.save()
    ctx.globalAlpha = 0.15
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = radius * 0.035
    for (let i = -2; i <= 2; i += 1) {
        ctx.beginPath()
        ctx.ellipse(x - radius * 0.08, y + i * radius * 0.2, radius * 0.9, radius * 0.08, -0.22, Math.PI * 0.05, Math.PI * 0.92)
        ctx.stroke()
    }
    ctx.restore()
}

function drawEarthShadow(ctx, x, y, radius) {
    const shadow = ctx.createRadialGradient(x + radius * 0.36, y + radius * 0.08, radius * 0.18, x + radius * 0.26, y + radius * 0.06, radius * 1.1)
    shadow.addColorStop(0, 'rgba(2, 6, 23, 0)')
    shadow.addColorStop(0.58, 'rgba(2, 6, 23, 0.1)')
    shadow.addColorStop(1, 'rgba(2, 6, 23, 0.78)')
    ctx.fillStyle = shadow
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
}

function drawProjectedLine(ctx, x, y, radius, centerLon, centerLat, points) {
    let started = false
    ctx.beginPath()
    points.forEach(([lat, lon]) => {
        const point = projectGlobePoint(lat, lon, x, y, radius, centerLon, centerLat)
        if (!point || point.visibility < 0.02) {
            started = false
            return
        }
        if (!started) {
            ctx.moveTo(point.x, point.y)
            started = true
        } else {
            ctx.lineTo(point.x, point.y)
        }
    })
    ctx.stroke()
}

function drawVisitPins(ctx, x, y, radius, centerLon, centerLat, visits) {
    visits.slice(0, 18).forEach((visit, index) => {
        if (!Number.isFinite(visit.latitude) || !Number.isFinite(visit.longitude)) {
            return
        }

        const point = projectGlobePoint(visit.latitude, visit.longitude, x, y, radius, centerLon, centerLat)
        if (!point || point.visibility < 0.04) {
            return
        }

        const pinSize = visit.isCurrent ? 5 : 3.5
        ctx.save()
        ctx.globalAlpha = Math.min(1, 0.35 + point.visibility)
        ctx.fillStyle = visit.isCurrent ? '#facc15' : '#ef4444'
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(point.x, point.y, pinSize, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(point.x, point.y, pinSize * 2.8, 0, Math.PI * 2)
        ctx.fillStyle = visit.isCurrent ? 'rgba(250, 204, 21, 0.18)' : 'rgba(239, 68, 68, 0.14)'
        ctx.fill()

        if (index < 3 || visit.isCurrent) {
            drawPinLabel(ctx, point.x, point.y, visit)
        }
        ctx.restore()
    })
}

function drawPinLabel(ctx, x, y, visit) {
    const label = [visit.city, visit.region || visit.country].filter(Boolean).join(', ') || visit.country || 'Visitor'
    const text = label.slice(0, 28)
    ctx.font = '700 11px Inter, sans-serif'
    const width = Math.min(170, ctx.measureText(text).width + 24)
    const boxX = Math.max(8, x - width / 2)
    const boxY = Math.max(8, y - 38)

    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)'
    roundRect(ctx, boxX, boxY, width, 26, 5)
    ctx.fill()
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.3)'
    ctx.stroke()
    ctx.fillStyle = '#dbeafe'
    ctx.fillText(text, boxX + 12, boxY + 17)
}

function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + width - radius, y)
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
    ctx.lineTo(x + width, y + height - radius)
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
    ctx.lineTo(x + radius, y + height)
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
}

function projectGlobePoint(latitudeValue, longitudeValue, x, y, radius, centerLon, centerLat) {
    const latitude = Number(latitudeValue)
    const longitude = Number(longitudeValue)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null
    }

    const lat = toRadians(latitude)
    const lon = toRadians(longitude - centerLon)
    const center = toRadians(centerLat)
    const visibility = Math.sin(center) * Math.sin(lat) + Math.cos(center) * Math.cos(lat) * Math.cos(lon)

    return {
        x: x + radius * Math.cos(lat) * Math.sin(lon),
        y: y - radius * (Math.cos(center) * Math.sin(lat) - Math.sin(center) * Math.cos(lat) * Math.cos(lon)),
        visibility
    }
}

function landMasses() {
    return [
        { points: [[36, -17], [32, 2], [31, 32], [16, 43], [-2, 41], [-17, 36], [-34, 26], [-35, 18], [-24, 14], [-7, 10], [6, -4], [18, -16], [36, -17]] },
        { points: [[72, -11], [67, 22], [54, 45], [51, 77], [61, 103], [56, 132], [42, 145], [23, 122], [8, 105], [7, 77], [25, 60], [33, 38], [43, 15], [55, -5], [72, -11]] },
        { points: [[12, 44], [24, 50], [26, 67], [20, 88], [7, 100], [-7, 109], [-9, 126], [-1, 137], [16, 122], [22, 100], [18, 78], [12, 44]] },
        { points: [[31, -117], [48, -126], [70, -100], [62, -73], [45, -60], [29, -83], [15, -92], [7, -78], [18, -66], [28, -80], [31, -117]] },
        { points: [[11, -79], [5, -67], [-8, -72], [-23, -67], [-39, -60], [-54, -70], [-42, -76], [-20, -81], [0, -79], [11, -79]] },
        { points: [[-12, 113], [-18, 130], [-28, 152], [-40, 145], [-35, 118], [-24, 112], [-12, 113]] },
        { points: [[72, -53], [82, -28], [76, -16], [65, -36], [62, -52], [72, -53]] }
    ]
}

function coordinatesForLocation(country, region, city) {
    const key = String(country || '').trim().toLowerCase()
    const regionKey = `${country || ''} ${region || ''} ${city || ''}`.toLowerCase()
    const precise = [
        [/beijing|北京/, { latitude: 39.9042, longitude: 116.4074 }],
        [/shanghai|上海/, { latitude: 31.2304, longitude: 121.4737 }],
        [/anhui|hefei|合肥|安徽/, { latitude: 31.8612, longitude: 117.2857 }],
        [/new york/, { latitude: 40.7128, longitude: -74.006 }],
        [/california|san francisco|los angeles/, { latitude: 36.7783, longitude: -119.4179 }],
        [/tokyo|東京|东京/, { latitude: 35.6762, longitude: 139.6503 }],
        [/moscow|москва/, { latitude: 55.7558, longitude: 37.6173 }],
        [/frankfurt|germany|deutschland/, { latitude: 50.1109, longitude: 8.6821 }]
    ].find(([pattern]) => pattern.test(regionKey))

    if (precise) {
        return precise[1]
    }

    const countries = {
        cn: { latitude: 35.8617, longitude: 104.1954 },
        china: { latitude: 35.8617, longitude: 104.1954 },
        '中国': { latitude: 35.8617, longitude: 104.1954 },
        us: { latitude: 39.8283, longitude: -98.5795 },
        usa: { latitude: 39.8283, longitude: -98.5795 },
        'united states': { latitude: 39.8283, longitude: -98.5795 },
        jp: { latitude: 36.2048, longitude: 138.2529 },
        japan: { latitude: 36.2048, longitude: 138.2529 },
        ru: { latitude: 61.524, longitude: 105.3188 },
        russia: { latitude: 61.524, longitude: 105.3188 },
        de: { latitude: 51.1657, longitude: 10.4515 },
        germany: { latitude: 51.1657, longitude: 10.4515 },
        fr: { latitude: 46.2276, longitude: 2.2137 },
        france: { latitude: 46.2276, longitude: 2.2137 },
        gb: { latitude: 55.3781, longitude: -3.436 },
        uk: { latitude: 55.3781, longitude: -3.436 },
        'united kingdom': { latitude: 55.3781, longitude: -3.436 },
        sg: { latitude: 1.3521, longitude: 103.8198 },
        singapore: { latitude: 1.3521, longitude: 103.8198 },
        au: { latitude: -25.2744, longitude: 133.7751 },
        australia: { latitude: -25.2744, longitude: 133.7751 }
    }

    return countries[key] || null
}

function numberOrFallback(value, fallback) {
    const number = Number(value)
    if (Number.isFinite(number)) {
        return number
    }
    return Number.isFinite(Number(fallback)) ? Number(fallback) : null
}

function countryCode(country) {
    const value = String(country || '').trim()
    const codes = {
        china: 'CN',
        '中国': 'CN',
        'united states': 'US',
        usa: 'US',
        japan: 'JP',
        russia: 'RU',
        germany: 'DE',
        france: 'FR',
        'united kingdom': 'GB',
        singapore: 'SG',
        australia: 'AU'
    }

    if (/^[a-z]{2}$/i.test(value)) {
        return value.toUpperCase()
    }
    return codes[value.toLowerCase()] || value.slice(0, 2).toUpperCase() || '--'
}

function relativeTime(value) {
    const time = new Date(value).getTime()
    if (!Number.isFinite(time)) {
        return 'now'
    }

    const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
    if (minutes < 1) {
        return 'now'
    }
    if (minutes < 60) {
        return `${minutes}m`
    }
    const hours = Math.round(minutes / 60)
    if (hours < 24) {
        return `${hours}h`
    }
    return `${Math.round(hours / 24)}d`
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[character]))
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;')
}

function toRadians(degrees) {
    return degrees * Math.PI / 180
}

function submitVisitorEvent(data, statusNode) {
    const endpoint = window.VISITOR_STATS_ENDPOINT

    if (!endpoint) {
        if (statusNode) {
            statusNode.textContent = 'Drag · zoom · hover visitor'
        }
        return
    }

    const payload = {
        url: window.location.href,
        path: window.location.pathname,
        referrer: document.referrer || '',
        city: data.city || '',
        region: data.region || '',
        country: data.country || '',
        latitude: data.latitude || '',
        longitude: data.longitude || '',
        timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    }

    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Collector unavailable')
            }
            return response.json()
        })
        .then(result => {
            if (result && result.stats) {
                applyRepositoryStats(result.stats)
            }
            if (statusNode) {
                statusNode.textContent = 'Visit recorded · drag · hover'
            }
        })
        .catch(() => {
            if (statusNode) {
                statusNode.textContent = 'Live counters ready · drag · hover'
            }
        })
}
