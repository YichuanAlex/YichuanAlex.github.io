const content_dir = 'contents/'
const config_file = 'config.yml'
const section_names = ['home', 'research', 'publications', 'experience', 'skills', 'awards', 'blog']

window.addEventListener('DOMContentLoaded', () => {
    loadConfig()
    loadMarkdownSections()
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
    section_names.forEach((name) => {
        fetch(content_dir + name + '.md')
            .then(response => response.text())
            .then(markdown => {
                const node = document.getElementById(name + '-md')
                if (node) {
                    node.innerHTML = marked.parse(markdown)
                }
            })
            .catch(error => console.log(error))
    })
}

function initVisitorStats() {
    const regionNode = document.getElementById('visitor-region')
    const globeNode = document.getElementById('visitor-globe')
    const statusNode = document.getElementById('visitor-log-status')

    if (!regionNode || !globeNode) {
        return
    }

    getVisitorRegion()
        .then(data => {
            const parts = [data.city, data.region, data.country].filter(Boolean)
            const location = parts.length ? parts.join(', ') : 'Approximate region unavailable'
            const timezone = data.timezone ? ` · ${data.timezone}` : ''
            regionNode.textContent = `${location}${timezone}`
            plotVisitorPoint(globeNode, data.latitude, data.longitude)
            submitVisitorEvent(data, statusNode)
        })
        .catch(() => {
            regionNode.textContent = 'Approximate region unavailable'
            submitVisitorEvent({}, statusNode)
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
    const regions = data.regions || {}
    const regionRows = Object.entries(regions)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 5)

    setText('repo_total_visits', Number(data.total_visits || 0).toLocaleString())
    setText('repo_unique_visitors', Number(data.unique_visitors || 0).toLocaleString())
    setText('repo_top_region', regionRows.length ? regionRows[0][0] : 'Pending')
    setText('repo_region_list', regionRows.length ? regionRows.map(([region, count]) => `${region}: ${count}`).join(' · ') : 'No repository-backed visits recorded yet.')
    setText('repo_updated_at', data.updated_at ? new Date(data.updated_at).toLocaleString() : 'Pending')
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
        return chain.catch(() => fetch(provider.url)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Geo provider unavailable')
                }
                return response.json()
            })
            .then(provider.normalize)
            .then(data => {
                if (!data || data.country === undefined) {
                    throw new Error('Geo provider returned incomplete data')
                }
                return data
            }))
    }, Promise.reject())
}

function plotVisitorPoint(globeNode, latitudeValue, longitudeValue) {
    const latitude = Number(latitudeValue)
    const longitude = Number(longitudeValue)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return
    }

    const x = ((longitude + 180) / 360) * 100
    const y = ((90 - latitude) / 180) * 100
    globeNode.style.setProperty('--pin-x', `${Math.max(6, Math.min(94, x))}%`)
    globeNode.style.setProperty('--pin-y', `${Math.max(6, Math.min(94, y))}%`)
}

function submitVisitorEvent(data, statusNode) {
    const endpoint = window.VISITOR_STATS_ENDPOINT

    if (!endpoint) {
        if (statusNode) {
            statusNode.textContent = 'Repository-backed logging is configured in the codebase. Deploy the collector endpoint to start writing aggregate visits into data/visitor-stats.json.'
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
                statusNode.textContent = 'This visit was sent to the repository-backed aggregate logger. Raw IP addresses are not stored.'
            }
        })
        .catch(() => {
            if (statusNode) {
                statusNode.textContent = 'Live counters are available. Repository-backed logging is temporarily unavailable.'
            }
        })
}
