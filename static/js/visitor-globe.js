/* global THREE */
(function () {
    'use strict'

    const CURRENT_KEY = 'visitor.current-location.v1'
    const PROVIDER_KEY = 'visitor.mapmyvisitors-points.v1'
    const REPORTED_KEY = 'visitor.collector-reported.v1'
    const MAX_CACHE_AGE = 6 * 60 * 60 * 1000

    function safeStorage(storage, action, key, value) {
        try {
            return storage[action](key, value)
        } catch {
            return null
        }
    }

    function validCoordinate(value, min, max) {
        if (value === '' || value === null || value === undefined) return null
        const number = Number(value)
        return Number.isFinite(number) && number >= min && number <= max ? number : null
    }

    function normalizeVisit(visit, options) {
        if (!visit || typeof visit !== 'object') return null
        const latitude = validCoordinate(visit.latitude ?? visit.lat, -90, 90)
        const longitude = validCoordinate(visit.longitude ?? visit.lon, -180, 180)
        if (latitude === null || longitude === null) return null
        return {
            latitude,
            longitude,
            city: String(visit.city || '').slice(0, 80),
            region: String(visit.region || '').slice(0, 80),
            country: String(visit.country || '').slice(0, 80),
            source: String(visit.source || visit.provider || options?.source || 'Repository').slice(0, 40),
            timestamp: String(visit.timestamp || visit.time || ''),
            isCurrent: Boolean(visit.isCurrent || options?.isCurrent),
            approximate: visit.approximate !== false
        }
    }

    function dedupeVisits(visits) {
        const seen = new Set()
        return (Array.isArray(visits) ? visits : []).map(visit => normalizeVisit(visit)).filter(visit => {
            if (!visit) return false
            const key = [visit.latitude.toFixed(3), visit.longitude.toFixed(3), visit.timestamp.slice(0, 16), visit.source].join('|')
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
    }

    function writeCurrentLocation(visit) {
        const normalized = normalizeVisit(visit, { isCurrent: true })
        if (!normalized) return null
        const payload = JSON.stringify(normalized)
        safeStorage(window.sessionStorage, 'setItem', CURRENT_KEY, payload)
        safeStorage(window.localStorage, 'setItem', CURRENT_KEY, payload)
        return normalized
    }

    function readCurrentLocation() {
        for (const storage of [window.sessionStorage, window.localStorage]) {
            try {
                const parsed = JSON.parse(storage.getItem(CURRENT_KEY) || 'null')
                const visit = normalizeVisit(parsed, { isCurrent: true })
                if (visit && Date.now() - new Date(visit.timestamp).getTime() < MAX_CACHE_AGE) return visit
            } catch {}
        }
        return null
    }

    async function fetchJson(url, timeout) {
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), timeout)
        try {
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error(`Geo provider returned ${response.status}`)
            return await response.json()
        } finally {
            window.clearTimeout(timer)
        }
    }

    async function locateCurrent() {
        const providers = [
            {
                name: 'Kamero Geo',
                url: 'https://geo.kamero.ai/api/geo',
                map: data => ({ city: data.city, region: data.countryRegion, country: data.country, latitude: data.latitude, longitude: data.longitude })
            },
            {
                name: 'country.is',
                url: 'https://api.country.is/?fields=city,continent,subdivision,location,asn',
                map: data => ({ city: data.city, region: data.subdivision, country: data.country, latitude: data.location?.latitude, longitude: data.location?.longitude })
            },
            {
                name: 'APIP',
                url: 'https://apip.cc/json',
                map: data => ({ city: data.City, region: data.RegionName, country: data.CountryName, latitude: data.Latitude, longitude: data.Longitude })
            }
        ]
        for (const provider of providers) {
            try {
                const data = provider.map(await fetchJson(provider.url, 2600))
                const visit = normalizeVisit(Object.assign(data, {
                    source: provider.name,
                    timestamp: new Date().toISOString(),
                    isCurrent: true,
                    approximate: true
                }))
                if (visit) return writeCurrentLocation(visit)
            } catch {}
        }
        return readCurrentLocation()
    }

    function cacheProviderVisits(visits) {
        const rows = dedupeVisits(visits).slice(0, 100)
        safeStorage(window.localStorage, 'setItem', PROVIDER_KEY, JSON.stringify(rows))
        return rows
    }

    function readProviderVisits() {
        try {
            return dedupeVisits(JSON.parse(window.localStorage.getItem(PROVIDER_KEY) || '[]'))
        } catch {
            return []
        }
    }

    function collectorEndpoint() {
        const value = String(window.VISITOR_STATS_ENDPOINT || '').trim()
        try {
            const url = new URL(value)
            return url.protocol === 'https:' ? url.href.replace(/\/$/, '') : ''
        } catch {
            return ''
        }
    }

    async function reportVisitOnce(visit) {
        const endpoint = collectorEndpoint()
        if (!endpoint || !visit || window.sessionStorage.getItem(REPORTED_KEY)) return { state: endpoint ? 'skipped' : 'unconfigured' }
        window.sessionStorage.setItem(REPORTED_KEY, 'pending')
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    latitude: visit.latitude,
                    longitude: visit.longitude,
                    city: visit.city,
                    region: visit.region,
                    country: visit.country,
                    source: visit.source,
                    timestamp: visit.timestamp,
                    path: `${window.location.pathname}${window.location.search}`.slice(0, 180),
                    referrer: document.referrer.slice(0, 300),
                    device_type: window.matchMedia('(max-width: 700px)').matches ? 'mobile' : 'desktop'
                })
            })
            if (!response.ok) throw new Error(`Collector returned ${response.status}`)
            window.sessionStorage.setItem(REPORTED_KEY, 'sent')
            return { state: 'connected', status: response.status }
        } catch (error) {
            window.sessionStorage.removeItem(REPORTED_KEY)
            return { state: 'error', error: String(error.message || error) }
        }
    }

    async function collectorHealth() {
        const endpoint = collectorEndpoint()
        if (!endpoint) return { state: 'unconfigured' }
        try {
            const response = await fetch(`${endpoint}/health`, { cache: 'no-store' })
            if (!response.ok) throw new Error(`Collector returned ${response.status}`)
            const data = await response.json()
            return { state: data.connected ? 'connected' : 'error', data }
        } catch (error) {
            return { state: 'error', error: String(error.message || error) }
        }
    }

    class VisitorGlobe {
        constructor(options) {
            this.canvas = options.canvas
            this.canvas.visitorGlobe = this
            this.tooltip = options.tooltip || null
            this.stage = options.stage || this.canvas.parentElement
            this.visits = []
            this.pins = []
            this.pulses = []
            this.pointer = new THREE.Vector2(-4, -4)
            this.raycaster = new THREE.Raycaster()
            this.activePointers = new Map()
            this.dragging = false
            this.pointerActive = false
            this.targetScale = 0.94
            this.scale = 0.94
            this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
            this.init()
        }

        init() {
            const mobile = window.matchMedia('(max-width: 700px)').matches
            const segments = mobile ? 48 : 72
            this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true })
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.35 : 2))
            this.renderer.setClearColor(0x000000, 0)
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping
            this.renderer.toneMappingExposure = 0.72
            if (THREE.SRGBColorSpace) this.renderer.outputColorSpace = THREE.SRGBColorSpace
            else this.renderer.outputEncoding = THREE.sRGBEncoding
            this.scene = new THREE.Scene()
            this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
            this.camera.position.set(0, 0, 3.9)
            this.group = new THREE.Group()
            this.group.rotation.x = -8 * Math.PI / 180
            this.scene.add(this.group)

            const texture = new THREE.TextureLoader().load('static/assets/img/earth_atmos_2048.jpg')
            if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace
            else texture.encoding = THREE.sRGBEncoding
            texture.anisotropy = 4
            const earth = new THREE.Mesh(new THREE.SphereGeometry(1, segments, segments), new THREE.MeshStandardMaterial({ map: texture, color: 0xe8f1f8, roughness: 0.96, metalness: 0 }))
            this.group.add(earth)
            const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.035, segments, segments), new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.08, side: THREE.BackSide, depthWrite: false }))
            this.group.add(atmosphere)
            this.pinGroup = new THREE.Group()
            this.group.add(this.pinGroup)
            const ambient = new THREE.HemisphereLight(0xdbeafe, 0x07111f, 1.15)
            const sun = new THREE.DirectionalLight(0xfff4dd, 0.72)
            sun.position.set(-2.2, 1.4, 3.2)
            const rim = new THREE.DirectionalLight(0x60a5fa, 0.22)
            rim.position.set(2.8, -1.2, -2.4)
            this.scene.add(ambient, sun, rim, this.createStars())
            this.attachInteractions()
            this.resize()
            window.addEventListener('resize', () => this.resize())
            this.renderer.setAnimationLoop(time => this.draw(time))
            if (this.stage) this.stage.dataset.globeReady = 'true'
        }

        createStars() {
            const positions = []
            let seed = 991
            const random = () => ((seed = seed * 48271 % 2147483647) - 1) / 2147483646
            for (let index = 0; index < 260; index += 1) positions.push((random() - 0.5) * 7.8, (random() - 0.5) * 4.8, -2.4 - random() * 1.8)
            const geometry = new THREE.BufferGeometry()
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
            return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xdbeafe, size: 0.012, transparent: true, opacity: 0.78 }))
        }

        vector(latitude, longitude, radius) {
            const lat = Number(latitude) * Math.PI / 180
            const lon = (Number(longitude) + 180) * Math.PI / 180
            return new THREE.Vector3(-radius * Math.cos(lon) * Math.cos(lat), radius * Math.sin(lat), radius * Math.sin(lon) * Math.cos(lat))
        }

        setVisits(visits) {
            this.visits = dedupeVisits(visits).slice(0, 100)
            while (this.pinGroup.children.length) this.pinGroup.remove(this.pinGroup.children[0])
            this.pins = []
            this.pulses = []
            this.visits.forEach((visit, index) => {
                const color = visit.isCurrent ? 0xfacc15 : 0xfb7185
                const position = this.vector(visit.latitude, visit.longitude, 1.035)
                const material = new THREE.MeshBasicMaterial({ color })
                const pin = new THREE.Mesh(new THREE.SphereGeometry(visit.isCurrent ? 0.035 : 0.024, 16, 16), material)
                pin.position.copy(position)
                pin.userData.visit = visit
                this.pinGroup.add(pin)
                this.pins.push(pin)
                const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture(visit.isCurrent ? '#facc15' : '#fb7185'), transparent: true, opacity: 0.52, depthWrite: false }))
                glow.position.copy(this.vector(visit.latitude, visit.longitude, 1.055))
                glow.userData.visit = visit
                glow.userData.baseScale = visit.isCurrent ? 0.25 : 0.16
                glow.scale.setScalar(glow.userData.baseScale)
                this.pinGroup.add(glow)
                if (visit.isCurrent || index < 3) this.pulses.push(glow)
            })
            if (this.stage) {
                this.stage.dataset.renderedPoints = String(this.pins.length)
                this.stage.dataset.currentPoint = String(this.visits.some(visit => visit.isCurrent))
            }
            const current = this.visits.find(visit => visit.isCurrent) || this.visits[0]
            if (current && !this.focused) {
                this.group.rotation.y = (-current.longitude - 90) * Math.PI / 180
                this.focused = true
            }
        }

        glowTexture(color) {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 96
            const context = canvas.getContext('2d')
            const gradient = context.createRadialGradient(48, 48, 4, 48, 48, 46)
            gradient.addColorStop(0, color)
            gradient.addColorStop(0.34, `${color}99`)
            gradient.addColorStop(1, `${color}00`)
            context.fillStyle = gradient
            context.fillRect(0, 0, 96, 96)
            return new THREE.CanvasTexture(canvas)
        }

        attachInteractions() {
            const pointerDistance = () => {
                const points = Array.from(this.activePointers.values())
                return points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : null
            }
            this.canvas.addEventListener('pointerdown', event => {
                this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
                this.lastPointer = { x: event.clientX, y: event.clientY }
                this.lastPinchDistance = pointerDistance()
                this.dragging = true
                this.canvas.setPointerCapture(event.pointerId)
            })
            this.canvas.addEventListener('pointermove', event => {
                const rect = this.canvas.getBoundingClientRect()
                this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
                this.pointerScreen = { x: event.clientX - rect.left, y: event.clientY - rect.top }
                this.pointerActive = true
                if (!this.activePointers.has(event.pointerId)) return
                this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
                if (this.activePointers.size > 1) {
                    const distance = pointerDistance()
                    if (distance && this.lastPinchDistance) this.targetScale = clamp(this.targetScale + (distance - this.lastPinchDistance) * 0.003, 0.72, 1.12)
                    this.lastPinchDistance = distance
                    return
                }
                this.group.rotation.y += (event.clientX - this.lastPointer.x) * 0.0065
                this.group.rotation.x = clamp(this.group.rotation.x + (event.clientY - this.lastPointer.y) * 0.0045, -1.05, 1.05)
                this.lastPointer = { x: event.clientX, y: event.clientY }
            })
            const finish = event => {
                this.activePointers.delete(event.pointerId)
                this.dragging = this.activePointers.size > 0
                if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
            }
            this.canvas.addEventListener('pointerup', finish)
            this.canvas.addEventListener('pointercancel', finish)
            this.canvas.addEventListener('pointerleave', () => { this.pointerActive = false; this.hideTooltip() })
            this.canvas.addEventListener('wheel', event => {
                event.preventDefault()
                this.targetScale = clamp(this.targetScale + (event.deltaY > 0 ? -0.06 : 0.06), 0.72, 1.12)
            }, { passive: false })
            this.canvas.addEventListener('keydown', event => {
                const moves = {
                    ArrowLeft: () => { this.group.rotation.y -= 0.12 },
                    ArrowRight: () => { this.group.rotation.y += 0.12 },
                    ArrowUp: () => { this.group.rotation.x = clamp(this.group.rotation.x - 0.1, -1.05, 1.05) },
                    ArrowDown: () => { this.group.rotation.x = clamp(this.group.rotation.x + 0.1, -1.05, 1.05) },
                    '+': () => { this.targetScale = clamp(this.targetScale + 0.06, 0.72, 1.12) },
                    '-': () => { this.targetScale = clamp(this.targetScale - 0.06, 0.72, 1.12) }
                }
                if (moves[event.key]) { event.preventDefault(); moves[event.key]() }
            })
        }

        draw(time) {
            this.resize()
            if (!this.dragging && !this.reducedMotion) this.group.rotation.y += 0.0022
            this.scale += (this.targetScale - this.scale) * 0.08
            this.group.scale.setScalar(this.scale)
            this.pulses.forEach((pulse, index) => {
                const wave = this.reducedMotion ? 0 : (Math.sin(time * 0.004 + index) + 1) * 0.5
                const size = pulse.userData.baseScale * (1 + wave * 0.22)
                pulse.scale.set(size, size, 1)
            })
            this.updateTooltip()
            this.renderer.render(this.scene, this.camera)
        }

        resize() {
            const width = Math.max(120, Math.floor(this.canvas.clientWidth || 320))
            const height = Math.max(120, Math.floor(this.canvas.clientHeight || 240))
            if (this.canvas.width !== width || this.canvas.height !== height) this.renderer.setSize(width, height, false)
            this.camera.aspect = width / height
            this.camera.updateProjectionMatrix()
        }

        updateTooltip() {
            if (!this.tooltip || !this.pointerActive || this.dragging || !this.pins.length) return this.hideTooltip()
            this.raycaster.setFromCamera(this.pointer, this.camera)
            const hit = this.raycaster.intersectObjects(this.pins, false)[0]
            if (!hit) return this.hideTooltip()
            const visit = hit.object.userData.visit
            const place = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Location unavailable'
            const date = new Date(visit.timestamp)
            const time = Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString()
            this.tooltip.textContent = `${place} · ${time} · ${visit.source}`
            this.tooltip.style.display = 'block'
            this.tooltip.style.left = `${clamp(this.pointerScreen.x, 18, this.stage.clientWidth - 18)}px`
            this.tooltip.style.top = `${Math.max(18, this.pointerScreen.y - 12)}px`
        }

        hideTooltip() {
            if (this.tooltip) this.tooltip.style.display = 'none'
        }
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value))
    }

    window.VisitorData = {
        normalizeVisit,
        dedupeVisits,
        locateCurrent,
        readCurrentLocation,
        writeCurrentLocation,
        cacheProviderVisits,
        readProviderVisits,
        collectorEndpoint,
        collectorHealth,
        reportVisitOnce
    }
    window.VisitorGlobe = VisitorGlobe
})()
