const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_ITEMS = 500
const MAX_TEXT_LENGTH = 300

function cleanText(value, label = 'To-do item') {
  const text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (!text || text.length > MAX_TEXT_LENGTH) throw new Error(`${label} must contain 1 to ${MAX_TEXT_LENGTH} characters.`)
  return text
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

class TodoStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'snowy-todos.json')
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(value)) throw new Error('The to-do list has an invalid format.')
      return value.filter((item) => item?.id && typeof item.text === 'string' && typeof item.completed === 'boolean')
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error(`Snowy could not read the saved to-do list and left it untouched: ${error.message}`)
    }
  }

  write(items) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch { /* Nothing temporary remains to clean up. */ }
      throw new Error(`Snowy could not safely save the to-do list: ${error.message}`)
    }
  }

  add(textValue) {
    const text = cleanText(textValue)
    const items = this.read()
    if (items.length >= MAX_ITEMS) throw new Error(`Snowy can keep up to ${MAX_ITEMS} to-do items.`)
    const duplicate = items.find((item) => !item.completed && normalize(item.text) === normalize(text))
    if (duplicate) return { added: false, duplicate: true, item: duplicate, message: 'That item is already on the to-do list.' }
    const item = { id: randomUUID(), text, completed: false, createdAt: new Date().toISOString(), completedAt: null }
    items.push(item)
    this.write(items)
    return { added: true, item }
  }

  list(includeCompleted = false) {
    const items = this.read().filter((item) => includeCompleted || !item.completed)
    return { items: items.slice(-100), total: items.length, truncated: items.length > 100 }
  }

  find(queryValue, items) {
    const query = cleanText(queryValue, 'To-do item search')
    const exactId = items.filter((item) => item.id === query)
    if (exactId.length === 1) return exactId[0]
    const normalized = normalize(query)
    const exactText = items.filter((item) => normalize(item.text) === normalized)
    const matches = exactText.length ? exactText : items.filter((item) => normalize(item.text).includes(normalized))
    if (!matches.length) return null
    if (matches.length > 1) throw new Error(`More than one to-do item matches “${query}”. Please name the exact item.`)
    return matches[0]
  }

  complete(query) {
    const items = this.read()
    const item = this.find(query, items.filter((entry) => !entry.completed))
    if (!item) return { completed: false, message: 'No open to-do item matched that description.' }
    item.completed = true
    item.completedAt = new Date().toISOString()
    this.write(items)
    return { completed: true, item }
  }

  remove(query) {
    const items = this.read()
    const item = this.find(query, items)
    if (!item) return { removed: false, message: 'No to-do item matched that description.' }
    this.write(items.filter((entry) => entry.id !== item.id))
    return { removed: true, item }
  }
}

module.exports = { TodoStore }
