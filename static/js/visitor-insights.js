const VISITOR_STATS_URL = 'data/visitor-stats.json'

window.addEventListener('DOMContentLoaded', () => {
    const refreshButton = document.getElementById('refresh-dashboard')
    const range = document.getElementById('time-range')

    if (range) {
        range.title = 'Unavailable: visitor-stats.json contains aggregates but no historical time-series buckets.'
    }
    if (refreshButton) {
        refreshButton.addEventListener('click', loadDashboard)
    }

    observeVercount()
    loadDashboard()
})

async function loadDashboard() {
    const button = document.getElementById('refresh-dashboard')
    setDashboardState('loading', 'Loading data')
    if (button) {
        button.disabled = true
        button.setAttribute('aria-busy', 'true')
    }

    try {
        const response = await fetch(`${VISITOR_STATS_URL}?t=${Date.now()}`, { cache: 'no-store' })
        if (!response.ok) {
            throw new Error(`Visitor data returned ${response.status}`)
        }
        const data = await response.json()
        renderDashboard(data)
        const hasRecords = Number(data.total_visits || 0) > 0 || Number(data.unique_visitors || 0) > 0 ||
            Object.keys(data.countries || {}).length > 0 || Object.keys(data.regions || {}).length > 0 ||
            (Array.isArray(data.recent_visits) && data.recent_visits.length > 0)
        setDashboardState(hasRecords ? 'ready' : 'empty', hasRecords ? 'Data loaded' : 'Connected · no records yet')
        setSourceStatus('repository', hasRecords ? 'ready' : 'empty', hasRecords
            ? 'Repository aggregate loaded successfully.'
            : 'Connected successfully; the current aggregate contains zero visits.')
    } catch {
        renderLoadFailure()
        setDashboardState('error', 'Data unavailable')
        setSourceStatus('repository', 'error', 'Could not load data/visitor-stats.json. Try Refresh.')
    } finally {
        if (button) {
            button.disabled = false
            button.removeAttribute('aria-busy')
        }
    }
}

function renderDashboard(data) {
    const countries = normaliseCounts(data.countries)
    const regions = normaliseCounts(data.regions)
    const recentVisits = Array.isArray(data.recent_visits) ? data.recent_visits : []

    setText('repository-total', formatNumber(data.total_visits))
    setText('repository-unique', formatNumber(data.unique_visitors))
    setText('country-count', formatNumber(countries.length))
    setText('region-count', formatNumber(regions.length))
    setText('data-updated-at', formatTimestamp(data.updated_at, 'Not recorded'))
    setText('privacy-copy', data.meta && data.meta.privacy
        ? data.meta.privacy
        : 'No privacy metadata is included in the current repository snapshot.')

    renderRanking('country-ranking', 'countries-total', countries, 'country')
    renderRanking('region-ranking', 'regions-total', regions, 'region')
    renderRecentVisitors(recentVisits)
    renderWorldMap(recentVisits)
    updateAvailability(data)
}

function normaliseCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return []
    }
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
        container.appendChild(createEmptyState(`No ${label} counts yet`, `The repository ${label} aggregate is currently empty.`))
        return
    }

    const max = items[0].count
    items.slice(0, 10).forEach(item => {
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
        bar.style.width = `${Math.max(2, (item.count / max) * 100)}%`
        track.appendChild(bar)
        const count = document.createElement('span')
        count.className = 'ranking-value'
        count.textContent = formatNumber(item.count)
        row.append(name, track, count)
        container.appendChild(row)
    })
}

function renderRecentVisitors(visits) {
    const list = document.getElementById('recent-visitors')
    if (!list) return

    list.replaceChildren()
    setText('recent-count', `${formatNumber(visits.length)} entries`)
    if (!visits.length) {
        const item = document.createElement('li')
        item.appendChild(createEmptyState('No recent visits yet', 'The bounded recent-visits array is currently empty.'))
        list.appendChild(item)
        return
    }

    visits.slice(0, 12).forEach(visit => {
        const item = document.createElement('li')
        const dot = document.createElement('span')
        dot.className = 'timeline-dot'
        const place = document.createElement('span')
        place.className = 'timeline-place'
        const title = document.createElement('strong')
        title.textContent = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Location unavailable'
        const detail = document.createElement('span')
        const hasCoordinates = Number.isFinite(Number(visit.latitude)) && Number.isFinite(Number(visit.longitude))
        detail.textContent = hasCoordinates ? `${Number(visit.latitude).toFixed(2)}, ${Number(visit.longitude).toFixed(2)}` : 'Coordinates unavailable'
        place.append(title, detail)
        const time = document.createElement('time')
        time.dateTime = visit.time || ''
        time.textContent = formatTimestamp(visit.time, 'Time unavailable')
        item.append(dot, place, time)
        list.appendChild(item)
    })
}

function renderWorldMap(visits) {
    const layer = document.getElementById('map-points')
    const empty = document.getElementById('map-empty')
    if (!layer || !empty) return

    layer.replaceChildren()
    const points = visits.filter(visit => {
        const latitude = Number(visit.latitude)
        const longitude = Number(visit.longitude)
        return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    })

    empty.hidden = points.length > 0
    points.slice(0, 30).forEach((visit, index) => {
        const longitude = Number(visit.longitude)
        const latitude = Number(visit.latitude)
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        circle.setAttribute('cx', String(((longitude + 180) / 360) * 1000))
        circle.setAttribute('cy', String(((90 - latitude) / 180) * 420))
        circle.setAttribute('r', index === 0 ? '8' : '6')
        if (index === 0) circle.classList.add('is-recent')
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
        title.textContent = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Recorded visitor'
        circle.appendChild(title)
        layer.appendChild(circle)
    })
}

function updateAvailability(data) {
    document.querySelectorAll('[data-source-field]').forEach(card => {
        const fields = card.dataset.sourceField.split(',')
        const available = fields.every(field => Object.prototype.hasOwnProperty.call(data, field))
        card.classList.toggle('is-missing', !available)
        const badge = card.querySelector('.availability-state')
        if (badge) badge.textContent = available ? 'Available' : 'Schema missing'
    })
}

function observeVercount() {
    const ids = ['vercount_value_page_pv', 'vercount_value_site_pv', 'vercount_value_site_uv']
    const nodes = ids.map(id => document.getElementById(id)).filter(Boolean)
    if (!nodes.length) return

    const check = () => {
        const values = nodes.map(node => node.textContent.trim())
        const populated = values.some(value => /^\d[\d,]*$/.test(value))
        if (populated) {
            setSourceStatus('vercount', 'ready', 'Live Vercount nodes populated for this page and site.')
        }
        return populated
    }
    if (check()) return

    const observer = new MutationObserver(() => {
        if (check()) observer.disconnect()
    })
    nodes.forEach(node => observer.observe(node, { childList: true, characterData: true, subtree: true }))
    window.setTimeout(() => {
        observer.disconnect()
        if (!check()) setSourceStatus('vercount', 'empty', 'Live counters did not populate in this environment; no substitute values are shown.')
    }, 8000)
}

function renderLoadFailure() {
    ;['repository-total', 'repository-unique', 'country-count', 'region-count'].forEach(id => setText(id, '—'))
    setText('data-updated-at', 'Unavailable')
    setText('privacy-copy', 'Repository privacy metadata is unavailable while the data request is failing.')
    const countries = document.getElementById('country-ranking')
    const regions = document.getElementById('region-ranking')
    const recent = document.getElementById('recent-visitors')
    if (countries) countries.replaceChildren(createEmptyState('Country data unavailable', 'Refresh to retry the repository request.'))
    if (regions) regions.replaceChildren(createEmptyState('Region data unavailable', 'Refresh to retry the repository request.'))
    if (recent) recent.replaceChildren(createEmptyState('Recent visits unavailable', 'Refresh to retry the repository request.'))
    renderWorldMap([])
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
