/* global VisitorData, VisitorGlobe */
const VISITOR_STATS_URL = 'data/visitor-stats.json'
let dashboardGlobe = null
let repositoryData = {}

window.addEventListener('DOMContentLoaded', () => {
    const refreshButton = document.getElementById('refresh-dashboard')
    if (refreshButton) refreshButton.addEventListener('click', loadDashboard)
    initGlobe()
    observeVercount()
    checkCollector()
    loadDashboard()
    loadCurrentPoint()
})

function initGlobe() {
    const canvas = document.getElementById('insights-earth-canvas')
    if (!canvas || !window.THREE || !window.VisitorGlobe) return
    dashboardGlobe = new VisitorGlobe({
        canvas,
        stage: document.getElementById('insights-earth-stage'),
        tooltip: document.getElementById('insights-earth-tooltip')
    })
    updateGlobe()
}

async function loadCurrentPoint() {
    const cached = VisitorData.readCurrentLocation()
    if (cached) updateGlobe(cached)
    const current = await VisitorData.locateCurrent()
    if (current) {
        updateGlobe(current)
        await VisitorData.reportVisitOnce(current)
    }
}

function allVisits(current) {
    const recent = Array.isArray(repositoryData.recent_visits) ? repositoryData.recent_visits : []
    const provider = VisitorData.readProviderVisits()
    const active = current || VisitorData.readCurrentLocation()
    return VisitorData.dedupeVisits([active, ...recent, ...provider].filter(Boolean).map(visit => Object.assign({}, visit, {
        isCurrent: Boolean(visit.isCurrent || visit === active),
        source: visit.source || visit.provider || (visit === active ? 'Current session' : 'Repository')
    })))
}

function updateGlobe(current) {
    const visits = allVisits(current)
    if (dashboardGlobe) dashboardGlobe.setVisits(visits)
    setText('visible-points', formatNumber(visits.length))
    const empty = document.getElementById('map-empty')
    if (empty) {
        empty.hidden = visits.length > 0
        empty.textContent = 'No geocoded current or historical visits are available.'
    }
    const stage = document.getElementById('insights-earth-stage')
    if (stage) stage.setAttribute('aria-busy', 'false')
    renderRecentVisitors(visits)
}

async function loadDashboard() {
    const button = document.getElementById('refresh-dashboard')
    setDashboardState('loading', 'Loading data')
    if (button) {
        button.disabled = true
        button.setAttribute('aria-busy', 'true')
    }
    try {
        const response = await fetch(`${VISITOR_STATS_URL}?t=${Date.now()}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`Visitor data returned ${response.status}`)
        repositoryData = await response.json()
        renderDashboard(repositoryData)
        const hasRecords = hasRepositoryRecords(repositoryData)
        setDashboardState(hasRecords ? 'ready' : 'empty', hasRecords ? 'Repository data loaded' : 'Read-only snapshot · empty')
        setSourceStatus('repository', hasRecords ? 'ready' : 'empty', hasRecords
            ? 'Repository Read-only · stored aggregate and visits available.'
            : 'Repository Read-only/empty · JSON is reachable but contains no recorded visits.')
    } catch {
        repositoryData = {}
        renderLoadFailure()
        setDashboardState('error', 'Repository unavailable')
        setSourceStatus('repository', 'error', 'Repository Error · data/visitor-stats.json could not be read.')
    } finally {
        if (button) {
            button.disabled = false
            button.removeAttribute('aria-busy')
        }
        updateGlobe()
    }
}

function hasRepositoryRecords(data) {
    return Number(data.total_visits || 0) > 0 || Number(data.unique_visitors || 0) > 0 ||
        Object.keys(data.countries || {}).length > 0 || Object.keys(data.regions || {}).length > 0 ||
        (Array.isArray(data.recent_visits) && data.recent_visits.length > 0)
}

function renderDashboard(data) {
    const countries = normaliseCounts(data.countries)
    const regions = normaliseCounts(data.regions)
    setText('repository-total', formatNumber(data.total_visits))
    setText('repository-unique', formatNumber(data.unique_visitors))
    setText('country-count', formatNumber(countries.length))
    setText('data-updated-at', formatTimestamp(data.updated_at, 'Not recorded'))
    setText('privacy-copy', data.meta?.privacy || 'No privacy metadata is included in the repository snapshot.')
    renderRanking('country-ranking', 'countries-total', countries, 'country')
    renderRanking('region-ranking', 'regions-total', regions, 'region')
    renderAggregate('daily-visits', data.daily_visits, 'Waiting for Collector daily data.', true)
    renderAggregate('top-pages', data.pages, 'Waiting for Collector page data.')
    renderAggregate('top-referrers', data.referrers, 'Waiting for Collector referrer data.')
    renderAggregate('device-breakdown', data.devices, 'Waiting for Collector device data.')
    configureRange(data.daily_visits)
}

function normaliseCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.entries(value)
        .map(([label, count]) => ({ label, count: Math.max(0, Number(count) || 0) }))
        .filter(item => item.label && item.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

function renderRanking(containerId, totalId, items, label) {
    const container = document.getElementById(containerId)
    if (!container) return
    const total = items.reduce((sum, item) => sum + item.count, 0)
    setText(totalId, `${formatNumber(total)} records`)
    container.replaceChildren()
    if (!items.length) {
        container.appendChild(createEmptyState(`No ${label} counts yet`, `The repository ${label} aggregate is empty.`))
        return
    }
    const max = items[0].count
    items.slice(0, 10).forEach(item => container.appendChild(createDataRow(item, max)))
}

function renderAggregate(id, value, waiting, chronological) {
    const container = document.getElementById(id)
    if (!container) return
    container.replaceChildren()
    let items = normaliseCounts(value)
    if (chronological) items = items.sort((a, b) => a.label.localeCompare(b.label)).slice(-14)
    else items = items.slice(0, 8)
    if (!items.length) {
        container.appendChild(createEmptyState('No Collector data yet', waiting))
        return
    }
    const max = Math.max(...items.map(item => item.count))
    items.forEach(item => container.appendChild(createDataRow(item, max)))
}

function createDataRow(item, max) {
    const row = document.createElement('div')
    row.className = 'ranking-row'
    const name = document.createElement('span')
    name.className = 'ranking-label'
    name.textContent = item.label
    name.title = item.label
    const track = document.createElement('span')
    track.className = 'ranking-track'
    const bar = document.createElement('span')
    bar.className = 'ranking-bar'
    bar.style.width = `${Math.max(2, item.count / max * 100)}%`
    track.appendChild(bar)
    const count = document.createElement('span')
    count.className = 'ranking-value'
    count.textContent = formatNumber(item.count)
    row.append(name, track, count)
    return row
}

function renderRecentVisitors(visits) {
    const list = document.getElementById('recent-visitors')
    if (!list) return
    list.replaceChildren()
    setText('recent-count', `${formatNumber(visits.length)} entries`)
    if (!visits.length) {
        const item = document.createElement('li')
        item.appendChild(createEmptyState('No real location points yet', 'The current location providers and stored recent visits have no coordinates.'))
        list.appendChild(item)
        return
    }
    visits.slice(0, 12).forEach(visit => {
        const item = document.createElement('li')
        const dot = document.createElement('span')
        dot.className = `timeline-dot${visit.isCurrent ? ' is-current' : ''}`
        const place = document.createElement('span')
        place.className = 'timeline-place'
        const title = document.createElement('strong')
        title.textContent = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Location unavailable'
        const detail = document.createElement('span')
        detail.textContent = `${visit.latitude.toFixed(2)}, ${visit.longitude.toFixed(2)} · ${visit.source}`
        place.append(title, detail)
        const time = document.createElement('time')
        time.dateTime = visit.timestamp || ''
        time.textContent = formatTimestamp(visit.timestamp, 'Time unavailable')
        item.append(dot, place, time)
        list.appendChild(item)
    })
}

async function checkCollector() {
    const result = await VisitorData.collectorHealth()
    const labels = {
        unconfigured: ['empty', 'Collector Unconfigured · no HTTPS endpoint is set, so no request was sent.'],
        connected: ['ready', 'Collector Connected · health check confirms repository access.'],
        error: ['error', 'Collector Error · configured endpoint did not report a healthy repository connection.']
    }
    const [state, text] = labels[result.state] || labels.error
    setSourceStatus('collector', state, text)
}

function observeVercount() {
    const production = window.location.hostname.toLowerCase() === 'yichuanalex.github.io'
    const ids = ['vercount_value_page_pv', 'vercount_value_site_pv', 'vercount_value_site_uv']
    const nodes = ids.map(id => document.getElementById(id)).filter(Boolean)
    if (!production) {
        nodes.forEach(node => { node.textContent = 'Preview unavailable' })
        setText('vercount-preview-note', 'Local preview unavailable; Vercount values are intentionally ignored off yichuanalex.github.io.')
        setSourceStatus('vercount', 'empty', 'Vercount Preview unavailable · live values are accepted only on yichuanalex.github.io.')
        return
    }
    const check = () => {
        const populated = nodes.some(node => /^\d[\d,]*$/.test(node.textContent.trim()))
        if (populated) setSourceStatus('vercount', 'ready', 'Vercount Connected · production-host counters populated.')
        return populated
    }
    if (check()) return
    const observer = new MutationObserver(() => { if (check()) observer.disconnect() })
    nodes.forEach(node => observer.observe(node, { childList: true, characterData: true, subtree: true }))
    window.setTimeout(() => {
        observer.disconnect()
        if (!check()) setSourceStatus('vercount', 'error', 'Vercount Error · production counters did not populate.')
    }, 8000)
}

function configureRange(dailyVisits) {
    const range = document.getElementById('time-range')
    if (!range) return
    range.disabled = normaliseCounts(dailyVisits).length === 0
    range.title = range.disabled ? 'Waiting for Collector daily_visits data.' : 'All repository daily buckets are displayed.'
}

function renderLoadFailure() {
    ;['repository-total', 'repository-unique', 'country-count'].forEach(id => setText(id, '—'))
    setText('data-updated-at', 'Unavailable')
    setText('privacy-copy', 'Repository privacy metadata is unavailable while the data request is failing.')
    renderRanking('country-ranking', 'countries-total', [], 'country')
    renderRanking('region-ranking', 'regions-total', [], 'region')
    ;['daily-visits', 'top-pages', 'top-referrers', 'device-breakdown'].forEach(id => renderAggregate(id, {}, 'Repository request failed.'))
}

function createEmptyState(title, detail) {
    const node = document.createElement('div')
    node.className = 'empty-state'
    const strong = document.createElement('strong')
    strong.textContent = title
    const text = document.createElement('span')
    text.textContent = detail
    node.append(strong, text)
    return node
}

function setSourceStatus(source, state, message) {
    const dot = document.getElementById(`${source}-source-dot`)
    const status = document.getElementById(`${source}-source-status`)
    if (dot) dot.className = `source-dot is-${state}`
    if (status) status.textContent = message
}

function setDashboardState(state, label) {
    const node = document.getElementById('dashboard-state')
    if (!node) return
    node.className = `status-pill is-${state}`
    node.textContent = label
}

function setText(id, value) {
    const node = document.getElementById(id)
    if (node) node.textContent = value
}

function formatNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number.toLocaleString() : '0'
}

function formatTimestamp(value, fallback) {
    if (!value) return fallback
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString()
}
