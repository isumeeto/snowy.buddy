const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function clean(value, max, label) {
  const text = String(value || '').trim()
  if (!text || text.length > max) throw new Error(`${label} must contain 1 to ${max} characters.`)
  return text
}

class AutomationStore {
  constructor(userDataPath) { this.filePath = path.join(userDataPath, 'snowy-automations.json') }
  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return Array.isArray(data) ? data.filter((item) => item?.id && item?.query && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)) : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error(`Snowy could not read automations: ${error.message}`)
    }
  }
  write(items) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.filePath)
  }
  createDailyResearch(timeValue, queryValue) {
    const time = clean(timeValue, 5, 'Time')
    const query = clean(queryValue, 500, 'Research topic')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Use 24-hour local time, for example 08:30.')
    const items = this.read()
    if (items.length >= 20) throw new Error('Snowy can keep up to 20 daily automations.')
    if (items.some((item) => item.time === time && item.query.toLowerCase() === query.toLowerCase())) throw new Error('That daily automation already exists.')
    const item = { id: randomUUID(), kind: 'daily_research', time, query, createdAt: new Date().toISOString() }
    items.push(item)
    this.write(items)
    return { created: true, id: item.id, kind: item.kind, time, query }
  }
  list() { return this.read().map(({ id, kind, time, query }) => ({ id, kind, time, query })) }
  cancel(queryValue) {
    const query = clean(queryValue, 500, 'Automation description').toLowerCase()
    const items = this.read()
    const matches = items.filter((item) => item.id === query || item.query.toLowerCase().includes(query))
    if (matches.length !== 1) throw new Error(matches.length ? 'More than one automation matches; say its exact topic.' : 'No matching automation was found.')
    this.write(items.filter((item) => item.id !== matches[0].id))
    return { cancelled: matches[0].query, time: matches[0].time, id: matches[0].id }
  }
}

module.exports = { AutomationStore }
