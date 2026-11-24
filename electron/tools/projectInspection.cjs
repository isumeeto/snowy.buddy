const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', 'vendor'])
const SECRET_NAME = /(^\.env(?:\.|$)|api[-_]?key|secret|credential|token|password|private[-_]?key)/i

async function inspectProject(fileManagement, folderId) {
  const folder = fileManagement.getFolder(folderId)
  const files = []
  let truncated = false
  const visit = (directory, depth) => {
    if (depth > 3) return
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SECRET_NAME.test(entry.name)) continue
      const relativePath = path.relative(folder.path, path.join(directory, entry.name))
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) visit(path.join(directory, entry.name), depth + 1)
      } else if (entry.isFile()) {
        files.push(relativePath)
        if (files.length >= 100) { truncated = true; return }
      }
      if (truncated) return
    }
  }
  visit(folder.path, 0)

  let git
  try {
    const result = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'status', '--short', '--branch', '--ignore-submodules=all'], {
      cwd: folder.path,
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    git = { available: true, status: result.stdout.trim().slice(0, 12000) || 'Working tree clean.' }
  } catch (error) {
    const details = String(error.stderr || error.message || '')
    git = { available: false, status: /not a git repository/i.test(details) ? 'This approved folder is not a Git repository.' : `Git status could not be read: ${details.slice(0, 300)}` }
  }
  return { folder: folder.name, files, truncated, git, mode: 'read_only' }
}

module.exports = { inspectProject }
