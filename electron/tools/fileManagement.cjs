const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_DEPTH = 5
const MAX_RESULTS = 100
const PREVIEW_TTL_MS = 10 * 60 * 1000

class FileManagement {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'snowy-approved-folders.json')
    this.previews = new Map()
    this.undoPlans = new Map()
  }

  read() {
    try {
      const items = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return Array.isArray(items) ? items.filter((item) => item?.id && item?.path && fs.existsSync(item.path)) : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error(`Snowy could not read approved folders: ${error.message}`)
    }
  }

  save(items) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  addFolder(folderPath) {
    const resolved = fs.realpathSync(folderPath)
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Choose a folder, not a file.')
    const items = this.read()
    const existing = items.find((item) => item.path.toLowerCase() === resolved.toLowerCase())
    if (existing) return { approved: true, folderId: existing.id, name: existing.name }
    if (items.length >= 20) throw new Error('Snowy can remember at most 20 approved folders.')
    const item = { id: randomUUID(), path: resolved, name: path.basename(resolved) || resolved }
    items.push(item)
    this.save(items)
    return { approved: true, folderId: item.id, name: item.name }
  }

  listFolders() { return this.read().map(({ id, name }) => ({ id, name })) }

  getFolder(id) {
    const folder = this.read().find((item) => item.id === String(id || ''))
    if (!folder) throw new Error('That folder is not approved. Ask Snowy to choose it first.')
    const root = fs.realpathSync(folder.path)
    if (!fs.statSync(root).isDirectory()) throw new Error('The approved folder is no longer available.')
    return { ...folder, path: root }
  }

  listFiles(folderId) {
    const folder = this.getFolder(folderId)
    const files = []
    const visit = (directory, depth) => {
      if (depth > MAX_DEPTH || files.length >= MAX_RESULTS) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(fullPath, depth + 1)
        else if (entry.isFile()) {
          const stat = fs.statSync(fullPath)
          files.push({ name: entry.name, relativePath: path.relative(folder.path, fullPath), size: stat.size })
          if (files.length >= MAX_RESULTS) break
        }
      }
    }
    visit(folder.path, 0)
    return { folder: folder.name, files, truncated: files.length >= MAX_RESULTS }
  }

  searchFiles(folderId, queryValue) {
    const query = String(queryValue || '').trim().toLocaleLowerCase()
    if (!query || query.length > 200) throw new Error('File search needs 1 to 200 characters.')
    const result = this.listFiles(folderId)
    return { ...result, files: result.files.filter((file) => file.name.toLocaleLowerCase().includes(query) || file.relativePath.toLocaleLowerCase().includes(query)) }
  }

  previewOrganization(folderId) {
    const folder = this.getFolder(folderId)
    const destinationRoot = path.join(folder.path, 'Snowy Organized')
    const entries = fs.readdirSync(folder.path, { withFileTypes: true })
    const reserved = new Set()
    const plan = []
    const projectMarkers = ['Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', '.git', '.sln', '.csproj', '.xcodeproj', '.xcworkspace']
    const hasPackageManifest = fs.existsSync(path.join(folder.path, 'package.json'))
      && ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].some((name) => fs.existsSync(path.join(folder.path, name)))
    if (hasPackageManifest || projectMarkers.some((name) => fs.existsSync(path.join(folder.path, name)))) {
      return { folder: folder.name, moves: [], totalMoves: 0, truncated: false, blocked: true, message: 'This folder looks like a software project. Snowy stopped to avoid moving files that could break it.' }
    }
    const categoryFor = (name) => {
      const extension = path.extname(name).toLowerCase()
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic'].includes(extension)) return 'Images'
      if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(extension)) return 'Videos'
      if (['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'].includes(extension)) return 'Audio'
      if (['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt'].includes(extension)) return 'Documents'
      if (['.xls', '.xlsx', '.csv', '.ods'].includes(extension)) return 'Spreadsheets'
      if (['.ppt', '.pptx', '.odp'].includes(extension)) return 'Presentations'
      if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(extension)) return 'Archives'
      if (['.js', '.jsx', '.ts', '.tsx', '.py', '.c', '.cpp', '.cs', '.html', '.css', '.json', '.yml', '.yaml'].includes(extension)) return 'Code'
      if (['.exe', '.msi', '.msix', '.apk'].includes(extension)) return 'Installers'
      return 'Other'
    }
    let protectedCount = 0
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.') || /(?:api[-_]?key|secret|credential|token|password|private[-_]?key)/i.test(entry.name) || ['.env', '.key', '.pem', '.p12', '.pfx', '.keystore'].includes(path.extname(entry.name).toLowerCase())) { protectedCount += 1; continue }
      const category = categoryFor(entry.name)
      const categoryFolder = path.join(destinationRoot, category)
      let name = entry.name
      let destination = path.join(categoryFolder, name)
      let suffix = 2
      while (fs.existsSync(destination) || reserved.has(destination.toLowerCase())) {
        const extension = path.extname(entry.name)
        const stem = extension ? entry.name.slice(0, -extension.length) : entry.name
        name = `${stem} (${suffix})${extension}`
        destination = path.join(categoryFolder, name)
        suffix += 1
      }
      const relativeDestination = path.join('Snowy Organized', category, name)
      if (path.relative(folder.path, destination).startsWith('..')) throw new Error('The proposed organization would leave the approved folder.')
      reserved.add(destination.toLowerCase())
      plan.push({ name: entry.name, from: entry.name, to: relativeDestination, source: path.join(folder.path, entry.name), destination })
      if (plan.length >= MAX_RESULTS) break
    }
    const previewId = randomUUID()
    this.previews.set(previewId, { folderId, folderName: folder.name, folderPath: folder.path, plan, createdAt: Date.now() })
    for (const [id, preview] of this.previews) if (Date.now() - preview.createdAt > PREVIEW_TTL_MS) this.previews.delete(id)
    return {
      previewId,
      folder: folder.name,
      moves: plan.map(({ name, from, to }) => ({ name, from, to })),
      totalMoves: plan.length,
      protectedSkipped: protectedCount,
      truncated: plan.length >= MAX_RESULTS,
      destinationFolder: 'Snowy Organized',
      message: plan.length ? 'Review this plan. Snowy will move files only after you approve it in the confirmation dialog.' : 'There are no top-level files to organize in this folder.',
    }
  }

  applyOrganization(previewId) {
    const preview = this.previews.get(String(previewId || ''))
    if (!preview || Date.now() - preview.createdAt > PREVIEW_TTL_MS) throw new Error('That organization preview expired. Create a fresh preview first.')
    const folder = this.getFolder(preview.folderId)
    const moved = []
    const skipped = []
    for (const item of preview.plan) {
      if (!fs.existsSync(item.source)) { skipped.push({ name: item.name, reason: 'Source file no longer exists.' }); continue }
      if (!fs.lstatSync(item.source).isFile()) { skipped.push({ name: item.name, reason: 'Source is no longer a regular file.' }); continue }
      if (fs.existsSync(item.destination)) { skipped.push({ name: item.name, reason: 'Destination now exists; no file was overwritten.' }); continue }
      const relativeDestination = path.relative(folder.path, item.destination)
      if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) { skipped.push({ name: item.name, reason: 'Destination is outside the approved folder.' }); continue }
      const categoryDirectory = path.dirname(item.destination)
      const organizationRoot = path.join(folder.path, 'Snowy Organized')
      if (fs.existsSync(organizationRoot) && fs.lstatSync(organizationRoot).isSymbolicLink()) throw new Error('Snowy stopped because the destination folder is a symbolic link.')
      if (fs.existsSync(categoryDirectory) && fs.lstatSync(categoryDirectory).isSymbolicLink()) throw new Error('Snowy stopped because a destination category is a symbolic link.')
      fs.mkdirSync(categoryDirectory, { recursive: true })
      try {
        fs.renameSync(item.source, item.destination)
        moved.push({ name: item.name, to: path.relative(folder.path, item.destination) })
      } catch (error) {
        skipped.push({ name: item.name, reason: error.message || 'Move failed.' })
      }
    }
    this.previews.delete(String(previewId))
    const undoId = moved.length ? randomUUID() : undefined
    if (undoId) {
      this.undoPlans.set(undoId, { folderId: preview.folderId, folderPath: folder.path, moved: moved.map((item) => ({ source: path.join(folder.path, item.name), destination: path.resolve(folder.path, item.to), name: item.name })) })
      while (this.undoPlans.size > 10) this.undoPlans.delete(this.undoPlans.keys().next().value)
    }
    return { moved, skipped, totalMoved: moved.length, ...(undoId ? { undoId } : {}) }
  }

  undoOrganization(undoId) {
    const plan = this.undoPlans.get(String(undoId || ''))
    if (!plan) throw new Error('That file organization can no longer be undone from this session.')
    const folder = this.getFolder(plan.folderId)
    if (folder.path !== plan.folderPath) throw new Error('The approved folder path changed; Snowy stopped the undo.')
    const moved = []
    const skipped = []
    for (const item of plan.moved) {
      const relativeDestination = path.relative(folder.path, item.destination)
      const relativeSource = path.relative(folder.path, item.source)
      if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination) || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
        skipped.push({ name: item.name, reason: 'The file is no longer inside the approved folder.' })
        continue
      }
      const organizationRoot = path.join(folder.path, 'Snowy Organized')
      const categoryDirectory = path.dirname(item.destination)
      if ((fs.existsSync(organizationRoot) && fs.lstatSync(organizationRoot).isSymbolicLink()) || (fs.existsSync(categoryDirectory) && fs.lstatSync(categoryDirectory).isSymbolicLink())) {
        skipped.push({ name: item.name, reason: 'A destination folder is now a symbolic link.' })
        continue
      }
      if (!fs.existsSync(item.destination) || !fs.lstatSync(item.destination).isFile()) { skipped.push({ name: item.name, reason: 'The organized file is missing or is no longer a regular file.' }); continue }
      if (fs.existsSync(item.source)) { skipped.push({ name: item.name, reason: 'The original filename now exists; Snowy did not overwrite it.' }); continue }
      try { fs.renameSync(item.destination, item.source); moved.push(item.name) }
      catch (error) { skipped.push({ name: item.name, reason: error.message || 'Undo move failed.' }) }
    }
    this.undoPlans.delete(String(undoId))
    return { moved, skipped, totalMoved: moved.length }
  }
}

module.exports = { FileManagement }
