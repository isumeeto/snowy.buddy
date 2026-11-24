const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_MEMORIES = 200
const MAX_SKILLS = 50
const MAX_MEMORY_LENGTH = 500
const MAX_SKILL_LENGTH = 8000

function cleanText(value, maxLength, label) {
  const text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (!text || text.length > maxLength) throw new Error(`${label} must contain 1 to ${maxLength} characters.`)
  return text
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

class AssistantStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'snowy-assistant-data.json')
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved assistant data has an invalid format.')
      return {
        memories: Array.isArray(value.memories) ? value.memories.filter((item) => item?.id && item?.text) : [],
        skills: Array.isArray(value.skills) ? value.skills.filter((item) => item?.id && item?.name && item?.content) : [],
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { memories: [], skills: [] }
      throw new Error(`Snowy could not read saved assistant data and will leave it untouched: ${error.message}`)
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch { /* No temp file to clean up. */ }
      throw new Error(`Snowy could not safely save assistant data: ${error.message}`)
    }
  }

  remember(textValue, categoryValue = 'preference') {
    const text = cleanText(textValue, MAX_MEMORY_LENGTH, 'Memory')
    if (/\b(password|passcode|api key|access token|private key|one[- ]time code|\botp\b|secret key)\b/i.test(text)) {
      throw new Error('Snowy will not store passwords, keys, or authentication codes in memory.')
    }
    const category = ['preference', 'fact', 'workflow'].includes(String(categoryValue).toLowerCase())
      ? String(categoryValue).toLowerCase()
      : 'preference'
    const data = this.read()
    const existing = data.memories.find((item) => normalize(item.text) === normalize(text))
    const now = new Date().toISOString()
    if (existing) {
      existing.category = category
      existing.text = text
      existing.updatedAt = now
    } else {
      data.memories.push({ id: randomUUID(), category, text, createdAt: now, updatedAt: now })
      if (data.memories.length > MAX_MEMORIES) data.memories.splice(0, data.memories.length - MAX_MEMORIES)
    }
    this.write(data)
    return { saved: true, category, text }
  }

  recall(queryValue = '') {
    const data = this.read()
    const query = normalize(queryValue)
    let memories = data.memories
    if (query) {
      const terms = query.split(' ').filter((term) => term.length > 1)
      memories = memories
        .map((item) => {
          const text = normalize(`${item.category} ${item.text}`)
          const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0)
          return { ...item, score }
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    } else {
      memories = memories.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    }
    return memories.slice(0, 10).map(({ category, text, updatedAt }) => ({ category, text, updatedAt }))
  }

  forget(queryValue) {
    const query = normalize(cleanText(queryValue, MAX_MEMORY_LENGTH, 'Memory search'))
    const data = this.read()
    const exact = data.memories.filter((item) => normalize(item.text) === query)
    const matches = exact.length ? exact : data.memories.filter((item) => normalize(item.text).includes(query))
    if (!matches.length) return { deleted: false, message: 'No matching memory was found.' }
    if (matches.length > 1) return { deleted: false, needsClarification: true, matches: matches.map((item) => item.text) }
    data.memories = data.memories.filter((item) => item.id !== matches[0].id)
    this.write(data)
    return { deleted: true, text: matches[0].text }
  }

  saveSkill(nameValue, descriptionValue, contentValue) {
    const name = cleanText(nameValue, 80, 'Skill name')
    const description = cleanText(descriptionValue, 240, 'Skill description')
    const content = cleanText(contentValue, MAX_SKILL_LENGTH, 'Skill steps')
    const data = this.read()
    const existing = data.skills.find((item) => normalize(item.name) === normalize(name))
    const skill = { id: existing?.id || randomUUID(), name, description, content, updatedAt: new Date().toISOString() }
    if (existing) Object.assign(existing, skill)
    else data.skills.push(skill)
    if (data.skills.length > MAX_SKILLS) throw new Error(`Snowy can store at most ${MAX_SKILLS} skills. Remove an old skill first.`)
    this.write(data)
    return { saved: true, name, description }
  }

  listSkills() {
    return this.read().skills.map(({ name, description, updatedAt }) => ({ name, description, updatedAt }))
  }

  getSkill(nameValue) {
    const query = normalize(cleanText(nameValue, 80, 'Skill name'))
    const skills = this.read().skills
    const exact = skills.filter((item) => normalize(item.name) === query)
    const matches = exact.length ? exact : skills.filter((item) => normalize(item.name).includes(query))
    if (matches.length !== 1) {
      return matches.length
        ? { found: false, needsClarification: true, matches: matches.map((item) => item.name) }
        : { found: false, message: 'No matching saved skill was found.' }
    }
    const { name, description, content } = matches[0]
    return { found: true, name, description, steps: content }
  }
}

module.exports = { AssistantStore }
