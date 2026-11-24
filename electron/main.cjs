const { app, BrowserWindow, Notification, clipboard, desktopCapturer, dialog, ipcMain, session, screen, shell, safeStorage } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { AssistantStore } = require('./assistantStore.cjs')
const { TodoStore } = require('./todoStore.cjs')
const { FileManagement } = require('./tools/fileManagement.cjs')
const { AutomationStore } = require('./automationStore.cjs')
const { inspectProject } = require('./tools/projectInspection.cjs')

const isDev = process.argv.includes('--dev')

// Allow the startup voice greeting to play without requiring an extra click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let companionWindow
let resourceMonitorTimer
let installedAppsCache = null
let installedAppsCacheTime = 0
let managedChromeProcess = null
let managedChromeTabId = null
const recentResearchResults = new Map()
let lastScreenCapture = null
let lastAccessibilitySnapshot = null
let whatsappNotificationTimer = null
let whatsappNotificationReadingEnabled = false
let petIsCompact = false
let petIsHovered = false
let reminderTimers = new Map()
let reminders = []
let seenWhatsAppNotifications = new Map()
let notificationPollErrorLogged = false
const geminiSearchStateFile = path.join(app.getPath('userData'), 'snowy-search-provider-state.json')
let geminiSearchUnavailableCategory = ''
let geminiSearchUnavailableUntil = (() => {
  try {
    const state = JSON.parse(fs.readFileSync(geminiSearchStateFile, 'utf8'))
    geminiSearchUnavailableCategory = String(state.category || '')
    return Number.isFinite(state.unavailableUntil) && state.unavailableUntil > Date.now() ? state.unavailableUntil : 0
  } catch { return 0 }
})()
const chromeDebugPort = 9222
const chromeProfilePath = path.join(app.getPath('userData'), 'managed-chrome-profile')
const geminiKeyFile = path.join(__dirname, '..', 'gemini-api-key.txt')
const encryptedGeminiKeyFile = path.join(app.getPath('userData'), 'gemini-api-key.enc')
const remindersFile = path.join(app.getPath('userData'), 'snowy-reminders.json')
const notificationPreferenceFile = path.join(app.getPath('userData'), 'snowy-notification-preference.json')
const assistantStore = new AssistantStore(app.getPath('userData'))
const todoStore = new TodoStore(app.getPath('userData'))
const fileManagement = new FileManagement(app.getPath('userData'))
const automationStore = new AutomationStore(app.getPath('userData'))
const automationTimers = new Map()

function readGeminiApiKey() {
  try {
    return fs.readFileSync(geminiKeyFile, 'utf8').trim()
  } catch {
    return ''
  }
}

function pauseGeminiSearch(reason, statusCode = 0, details = {}) {
  const text = `${String(reason || '')} ${String(details.quotaId || '')}`.toLowerCase()
  const retryDelay = String(details.retryDelay || '').match(/([\d.]+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/i)
  const retryMs = retryDelay
    ? Number(retryDelay[1]) * (/^h|hour/i.test(retryDelay[2]) ? 3600000 : /^m|min/i.test(retryDelay[2]) ? 60000 : 1000)
    : 0
  const isDailyQuota = /per.?day|daily|requests_per_day|requestsperday|rpd/.test(text)
  const isQuota = /quota|billing|exceeded.*limit/.test(text)
  const duration = retryMs > 0
    ? Math.min(Math.max(retryMs, 5000), 60 * 60 * 1000)
    : isDailyQuota
      ? 24 * 60 * 60 * 1000
      : isQuota
        ? 60 * 60 * 1000
        : statusCode === 429 || /rate limit/.test(text)
          ? 2 * 60 * 1000
          : 60 * 60 * 1000
  geminiSearchUnavailableUntil = Date.now() + duration
  geminiSearchUnavailableCategory = isDailyQuota ? 'daily_quota' : isQuota ? 'quota' : statusCode === 429 ? 'rate_limit' : 'provider_unavailable'
  try {
    fs.mkdirSync(path.dirname(geminiSearchStateFile), { recursive: true })
    const temporary = `${geminiSearchStateFile}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ unavailableUntil: geminiSearchUnavailableUntil, category: geminiSearchUnavailableCategory }), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, geminiSearchStateFile)
  } catch (error) {
    console.warn('Could not persist the Gemini Search cooldown:', error.message)
  }
}

async function researchWeb(queryValue) {
  const query = String(queryValue || '').trim()
  if (!query || query.length > 2000) return { error: 'Research questions must contain 1 to 2000 characters.' }
  if (Date.now() < geminiSearchUnavailableUntil) {
    return { ...(await researchFallback(query)), geminiSearchStatus: geminiSearchUnavailableCategory || 'cooldown' }
  }

  const currentTime = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long',
  }).format(new Date())

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const apiKey = readGeminiApiKey()
    if (!apiKey) return { ...(await researchFallback(query)), geminiSearchStatus: 'not_configured' }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Use live Google Search for this request. Current time in India: ${currentTime}. For current news or live facts, prioritize sources published in the last 24 hours, include publication dates, and do not present older information as current. Prefer primary and authoritative sources, distinguish confirmed facts from uncertainty, and say clearly if no recent reliable result was found. Summarize concisely.\n\nQuestion: ${query}` }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1800 },
      }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = payload.error?.message || `Gemini research request failed (${response.status}).`
      const errorDetails = payload.error?.details || []
      const retryInfo = errorDetails.find((item) => String(item['@type'] || '').endsWith('RetryInfo'))?.retryDelay || ''
      const quotaViolation = errorDetails.flatMap((item) => item.violations || []).find((item) => item.quotaId || item.quotaMetric)
      if (/quota|billing|permission|not available|not supported|rate limit/i.test(message)) {
        pauseGeminiSearch(message, response.status, { retryDelay: retryInfo, quotaId: `${quotaViolation?.quotaId || ''} ${quotaViolation?.quotaMetric || ''}` })
      }
      const geminiSearchStatus = /quota|billing/i.test(message) ? 'quota_limited' : 'unavailable'
      const fallback = await researchFallback(query)
      if (!fallback.error) return { ...fallback, geminiSearchStatus }
      return { error: `Live search is temporarily unavailable. Gemini reported: ${message}. Independent fallback searches also failed: ${fallback.error}`, provider: 'none available', geminiSearchStatus }
    }

    const candidate = payload.candidates?.[0]
    const answer = (candidate?.content?.parts || []).map((part) => part.text || '').join('').trim()
    const chunks = candidate?.groundingMetadata?.groundingChunks || []
    const sources = []
    const seen = new Set()
    for (const chunk of chunks) {
      const web = chunk.web || chunk.webSearchResult
      const url = web?.uri || web?.url
      if (!url || seen.has(url)) continue
      let parsedUrl
      try { parsedUrl = new URL(url) } catch { continue }
      if (parsedUrl.protocol !== 'https:') continue
      seen.add(url)
      sources.push({ title: String(web.title || parsedUrl.hostname).slice(0, 180), url: parsedUrl.toString() })
      if (sources.length >= 8) break
    }
    if (!answer || !sources.length) return { ...(await researchFallback(query)), geminiSearchStatus: 'grounding_returned_no_sources' }
    geminiSearchUnavailableUntil = 0
    geminiSearchUnavailableCategory = ''
    return { answer, sources, queries: candidate.groundingMetadata?.webSearchQueries || [], mode: 'grounded', provider: 'Gemini Google Search', geminiSearchStatus: 'available' }
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'Gemini web search timed out.' : error.message || 'Gemini web search failed.'
    pauseGeminiSearch(reason)
    const fallback = await researchFallback(query)
    if (!fallback.error) return { ...fallback, geminiSearchStatus: 'unavailable' }
    return { error: `Live search is temporarily unavailable. Gemini reported: ${reason}. Independent fallback searches also failed: ${fallback.error}`, provider: 'none available', geminiSearchStatus: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

function isNewsSearch(query) {
  return /\b(news|headlines?|breaking|current events|latest\s+(?:news|headlines?|developments?|updates?|on|about)|today(?:'s)?\s+(?:news|headlines?|developments?|updates?)|what(?:'s| is) happening|what happened)\b/i.test(query)
}

async function gdeltNewsFallback(query) {
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc')
  url.searchParams.set('query', query)
  url.searchParams.set('mode', 'artlist')
  url.searchParams.set('format', 'json')
  url.searchParams.set('maxrecords', '8')
  url.searchParams.set('timespan', '1d')
  url.searchParams.set('sort', 'datedesc')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'SnowyDesktopCompanion/0.1 (news search)' },
    })
    if (!response.ok) throw new Error(`GDELT returned HTTP ${response.status}.`)
    const payload = await response.json()
    const articles = (Array.isArray(payload.articles) ? payload.articles : []).flatMap((article) => {
      let parsedUrl
      try { parsedUrl = new URL(article.url) } catch { return [] }
      if (parsedUrl.protocol !== 'https:') return []
      const title = String(article.title || '').trim().slice(0, 240)
      if (!title) return []
      const rawDate = String(article.seendate || '')
      const parsedDate = rawDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
      const indexedAt = parsedDate
        ? new Date(Date.UTC(Number(parsedDate[1]), Number(parsedDate[2]) - 1, Number(parsedDate[3]), Number(parsedDate[4]), Number(parsedDate[5]), Number(parsedDate[6]))).toISOString()
        : ''
      return [{ title, url: parsedUrl.toString(), domain: String(article.domain || parsedUrl.hostname), indexedAt }]
    })
    const uniqueArticles = articles.filter((article, index, all) => all.findIndex((item) => item.url === article.url) === index).slice(0, 8)
    if (!uniqueArticles.length) return { error: 'GDELT returned no usable headlines from the last 24 hours.' }
    const sources = [
      ...uniqueArticles.map(({ title, url }) => ({ title, url })),
      { title: 'GDELT Project', url: 'https://www.gdeltproject.org/' },
    ]
    const answer = `Live news index results from GDELT, retrieved ${new Date().toISOString()}. These are headlines with GDELT index timestamps, not verified full-article summaries. Do not infer details beyond them. GDELT Project: https://www.gdeltproject.org/\n\n${uniqueArticles.map((article, index) => `${index + 1}. ${article.title}\nSource: ${article.domain}${article.indexedAt ? `; indexed ${article.indexedAt}` : ''}`).join('\n\n')}`
    return { answer, sources, queries: [query], mode: 'gdelt_news', provider: 'GDELT', searchedAt: new Date().toISOString() }
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'GDELT news search timed out.' : error.message || 'GDELT news search failed.' }
  } finally {
    clearTimeout(timer)
  }
}

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
}

async function googleNewsRssFallback(query) {
  const url = new URL('https://news.google.com/rss/search')
  url.searchParams.set('q', query)
  url.searchParams.set('hl', 'en-IN')
  url.searchParams.set('gl', 'IN')
  url.searchParams.set('ceid', 'IN:en')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/rss+xml, application/xml, text/xml' } })
    if (!response.ok) throw new Error(`Google News returned HTTP ${response.status}.`)
    const xml = await response.text()
    const articles = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).flatMap((match) => {
      const field = (name) => decodeXml(match[1].match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]).trim()
      const title = field('title').slice(0, 240)
      let articleUrl
      try { articleUrl = new URL(field('link')) } catch { return [] }
      if (!title || articleUrl.protocol !== 'https:') return []
      return [{ title, url: articleUrl.toString(), publishedAt: field('pubDate'), domain: articleUrl.hostname }]
    })
    if (!articles.length) return { error: 'Google News RSS returned no usable headlines.' }
    return {
      answer: `Live Google News RSS headlines retrieved ${new Date().toISOString()}. These are headlines and publisher timestamps, not verified article summaries. Do not infer details beyond the headlines.\n\n${articles.map((article, index) => `${index + 1}. ${article.title}\nSource: ${article.domain}${article.publishedAt ? `; published ${article.publishedAt}` : ''}`).join('\n\n')}`,
      sources: articles.map(({ title, url }) => ({ title, url })),
      queries: [query],
      mode: 'google_news_rss',
      provider: 'Google News RSS',
      searchedAt: new Date().toISOString(),
    }
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'Google News RSS search timed out.' : error.message || 'Google News RSS search failed.' }
  } finally {
    clearTimeout(timer)
  }
}

function decodeHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ').replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code))).replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16))).replace(/\s+/g, ' ').trim()
}

async function duckDuckGoHttpFallback(query) {
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36' },
    })
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}.`)
    const html = await response.text()
    const anchors = [...html.matchAll(/<a\b([^>]*\bclass=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)]
    const rows = anchors.slice(0, 12).flatMap((match, index) => {
      const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1]
      const title = decodeHtml(match[2]).slice(0, 180)
      let resultUrl
      try {
        resultUrl = new URL(decodeHtml(href), url)
        if (resultUrl.hostname.endsWith('duckduckgo.com') && resultUrl.searchParams.has('uddg')) resultUrl = new URL(resultUrl.searchParams.get('uddg'))
      } catch { return [] }
      if (resultUrl.protocol !== 'https:' || resultUrl.hostname.endsWith('duckduckgo.com') || !title) return []
      const nextAnchor = anchors[index + 1]?.index ?? html.length
      const cardText = html.slice(match.index, nextAnchor)
      const snippetMarkup = cardText.match(/<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] || ''
      return [{ title, url: resultUrl.toString(), snippet: decodeHtml(snippetMarkup).slice(0, 700) }]
    })
    const uniqueRows = rows.filter((row, index, all) => all.findIndex((item) => item.url === row.url) === index).slice(0, 8)
    if (!uniqueRows.length) throw new Error('DuckDuckGo returned no readable result links (it may have served a challenge page).')
    return {
      answer: `Search result snippets from DuckDuckGo, retrieved ${new Date().toISOString()}. These are leads, not full-page verification.\n\n${uniqueRows.map((row, index) => `${index + 1}. ${row.title}\n${row.snippet || 'No preview text was available.'}`).join('\n\n')}`,
      sources: uniqueRows.map(({ title, url }) => ({ title, url })),
      queries: [query],
      mode: 'duckduckgo_search',
      provider: 'DuckDuckGo HTML search',
      searchedAt: new Date().toISOString(),
    }
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'DuckDuckGo search timed out.' : error.message || 'DuckDuckGo search failed.' }
  } finally {
    clearTimeout(timer)
  }
}

async function researchFallback(query) {
  const failures = []
  if (isNewsSearch(query)) {
    const news = await gdeltNewsFallback(query)
    if (!news.error) return news
    failures.push(news.error)
    const rss = await googleNewsRssFallback(query)
    if (!rss.error) return rss
    failures.push(rss.error)
  }
  const directSearch = await duckDuckGoHttpFallback(query)
  if (!directSearch.error) return directSearch
  failures.push(directSearch.error)
  const browserSearch = await browserResearchFallback(query)
  if (!browserSearch.error) return browserSearch
  failures.push(browserSearch.error)
  return { error: `Gemini Search is unavailable. Independent fallback providers also failed: ${failures.join(' ')} Check the connection and try again.` }
}

async function browserResearchFallback(query) {
  const providers = [
    { name: 'Bing', url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
    { name: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(query)}` },
    { name: 'DuckDuckGo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
  ]
  const expression = `new Promise((resolve) => {
    const collect = () => {
      let rows = [];
      if (location.hostname.includes('bing.com')) {
        rows = Array.from(document.querySelectorAll('li.b_algo')).map((card) => ({ a: card.querySelector('h2 a'), snippet: card.querySelector('.b_caption p')?.innerText || card.querySelector('p')?.innerText || '' }));
      } else if (location.hostname.includes('google.com')) {
        rows = Array.from(document.querySelectorAll('a')).filter((a) => a.querySelector('h3')).map((a) => ({ a, snippet: (a.closest('.MjjYud') || a.parentElement?.parentElement)?.querySelector('.VwiC3b, [data-sncf]')?.innerText || '' }));
      } else {
        rows = Array.from(document.querySelectorAll('a.result__a')).map((a) => ({ a, snippet: a.closest('.result')?.querySelector('.result__snippet')?.innerText || '' }));
      }
      return rows.map(({a, snippet}) => ({ title: (a?.innerText || '').trim(), url: a?.href || '', snippet: (snippet || '').trim() })).filter((item) => item.title && item.url);
    };
    const until = Date.now() + 8500;
    const poll = () => { const rows = collect(); if (rows.length || Date.now() >= until) resolve(JSON.stringify(rows)); else setTimeout(poll, 300); };
    poll();
  })`

  for (const provider of providers) {
    let target
    try {
      await ensureManagedChrome()
      const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/new?${encodeURIComponent(provider.url)}`, { method: 'PUT' })
      if (!response.ok) throw new Error('Chrome could not open a temporary search tab.')
      target = await response.json()
      const result = await sendChromeCommand(target, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, 12000)
      let rows = []
      try { rows = JSON.parse(result.result?.value || '[]') } catch { rows = [] }
      const sources = []
      const seen = new Set()
      for (const row of rows) {
        let url
        try { url = new URL(row.url) } catch { continue }
        const host = url.hostname.toLowerCase()
        if (url.protocol !== 'https:' || host.endsWith('bing.com') || host.endsWith('google.com') || host.endsWith('duckduckgo.com') || seen.has(url.toString())) continue
        seen.add(url.toString())
        sources.push({ title: String(row.title).slice(0, 180), url: url.toString() })
        if (sources.length >= 8) break
      }
      const usableRows = rows.filter((row) => sources.some((source) => source.url === row.url)).slice(0, 8)
      if (sources.length) {
        const answer = `These are search-result snippets, not full-page verification. Use them as leads and check the linked sources for exact details.\n\n${usableRows.map((row, index) => `${index + 1}. ${row.title}\n${String(row.snippet || 'No preview text was available.').slice(0, 900)}`).join('\n\n')}`
        return { answer, sources, queries: [query], mode: 'browser_search', provider: provider.name }
      }
    } catch {
      // Try the next public search provider if this one is unavailable.
    } finally {
      if (target?.id) {
        try { await fetch(`http://127.0.0.1:${chromeDebugPort}/json/close/${target.id}`) } catch { /* Chrome may already have closed it. */ }
      }
    }
  }
  return { error: 'No public search provider returned usable source links. Check your internet connection and try again.' }
}

function runPowerShell(script, values, timeout = 12000) {
  const argsLiteral = JSON.stringify(values)
  const wrapped = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; $v = ConvertFrom-Json '${argsLiteral.replace(/'/g, "''")}'; try { ${script} } catch { [Console]::Out.WriteLine('SNOWY_ERROR:' + $_.Exception.Message); [Console]::Out.Flush(); exit 1 }`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', timeout, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('SNOWY_ERROR:'))
        const plainError = marker?.slice('SNOWY_ERROR:'.length).trim()
        reject(new Error(plainError || error.message || 'PowerShell action failed.'))
      }
      else resolve(stdout.trim())
    })
  })
}

async function getInstalledApps() {
  if (installedAppsCache && Date.now() - installedAppsCacheTime < 5 * 60 * 1000) return installedAppsCache
  const json = await runPowerShell("Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress", [], 20000)
  installedAppsCache = JSON.parse(json || '[]')
  if (!Array.isArray(installedAppsCache)) installedAppsCache = [installedAppsCache]
  installedAppsCacheTime = Date.now()
  return installedAppsCache
}

function normalizeAppName(value) { return String(value).toLowerCase().replace(/[^a-z0-9]/g, '') }

async function findChromeExecutable() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate))
  if (!found) throw new Error('Google Chrome was not found in its standard Windows install locations.')
  return found
}

async function ensureManagedChrome() {
  try {
    const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/version`)
    if (response.ok) return
  } catch { /* Start Snowy-managed Chrome below. */ }
  if (!managedChromeProcess || managedChromeProcess.exitCode !== null) {
    const chromePath = await findChromeExecutable()
    managedChromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${chromeDebugPort}`,
      `--user-data-dir=${chromeProfilePath}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: false })
    managedChromeProcess.unref()
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/version`)
      if (response.ok) return
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Snowy could not connect to its managed Chrome window.')
}

async function chromeTargets() {
  await ensureManagedChrome()
  const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json`)
  if (!response.ok) throw new Error('Could not read Chrome tabs.')
  return response.json()
}

async function sendChromeCommand(target, method, params = {}, timeoutMs = 10000) {
  if (typeof WebSocket === 'undefined') throw new Error('This Node runtime cannot connect to Chrome DevTools.')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const id = 1
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Chrome did not respond to the navigation request.')) }, timeoutMs)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id, method, params })), { once: true })
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.id !== id) return
      clearTimeout(timeout)
      socket.close()
      if (message.error) reject(new Error(message.error.message || 'Chrome rejected the request.'))
      else resolve(message.result || {})
    })
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not connect to the Chrome tab.')) }, { once: true })
  })
}

async function openManagedChromeTab(url) {
  await ensureManagedChrome(url)
  const pages = (await chromeTargets()).filter((item) => item.type === 'page' && !item.url.startsWith('devtools://'))
  const target = pages.find((item) => item.id === managedChromeTabId) || pages.find((item) => item.url === 'about:blank') || pages[0]
  if (!target) {
    const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!response.ok) throw new Error('Chrome refused to open a tab.')
    const created = await response.json()
    managedChromeTabId = created.id
    return created
  }
  managedChromeTabId = target.id
  await fetch(`http://127.0.0.1:${chromeDebugPort}/json/activate/${target.id}`).catch(() => {})
  await sendChromeCommand(target, 'Page.navigate', { url })
  return { ...target, url }
}

function rememberResearchResult(result) {
  if (!result || result.error || !result.answer) return result
  const researchId = require('node:crypto').randomUUID()
  recentResearchResults.set(researchId, { ...result, savedAt: new Date().toISOString() })
  while (recentResearchResults.size > 20) recentResearchResults.delete(recentResearchResults.keys().next().value)
  return { ...result, researchId }
}

function saveResearchReport(researchId, titleValue) {
  const result = recentResearchResults.get(String(researchId || ''))
  if (!result) throw new Error('That research result is no longer available. Ask Snowy to research it again, then save it.')
  const title = String(titleValue || result.query || 'Snowy Research').trim().slice(0, 120)
  const safeName = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '') || 'Snowy Research'
  const desktop = app.getPath('desktop')
  fs.mkdirSync(desktop, { recursive: true })
  let filename = `${safeName}.html`
  let target = path.join(desktop, filename)
  for (let suffix = 2; fs.existsSync(target); suffix += 1) {
    filename = `${safeName} (${suffix}).html`
    target = path.join(desktop, filename)
  }
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const sources = (Array.isArray(result.sources) ? result.sources : [])
    .filter((source) => { try { return new URL(source.url).protocol === 'https:' } catch { return false } })
    .map((source) => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a><span>${escapeHtml(new URL(source.url).hostname)}</span></li>`)
  const createdAt = escapeHtml(new Date().toLocaleString())
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#29241f;--muted:#766b61;--paper:#fbf8f2;--accent:#8a5944}*{box-sizing:border-box}body{margin:0;padding:48px 20px;background:#eee8dc;color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}.paper{max-width:820px;margin:0 auto;padding:clamp(24px,6vw,64px);background:var(--paper);border-radius:24px;box-shadow:0 12px 40px #3020121a}header{border-bottom:1px solid #ded5c8;padding-bottom:24px}h1{font-size:clamp(28px,5vw,42px);line-height:1.15;margin:0 0 16px}h2{margin:32px 0 10px;color:var(--accent);font-size:20px}.meta{display:grid;gap:5px;color:var(--muted);font-size:14px}.meta strong{color:var(--ink)}.summary{white-space:pre-wrap;overflow-wrap:anywhere}.sources{padding-left:22px}.sources li{margin:12px 0}.sources a{color:#75442f;text-underline-offset:3px}.sources span{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}footer{margin-top:40px;padding-top:14px;border-top:1px solid #ded5c8;color:var(--muted);font-size:12px}@media print{body{padding:0;background:white}.paper{max-width:none;padding:0;box-shadow:none;border-radius:0}a{color:inherit}}
</style></head><body><main class="paper"><header><h1>${escapeHtml(title)}</h1><div class="meta"><div><strong>Research question:</strong> ${escapeHtml(String(result.query || '').replace(/\r?\n/g, ' '))}</div><div><strong>Prepared:</strong> ${createdAt}</div><div><strong>Search provider:</strong> ${escapeHtml(result.provider || result.mode || 'unknown')}</div></div></header><section><h2>Research summary</h2><div class="summary">${escapeHtml(String(result.answer).trim())}</div></section><section><h2>Sources</h2>${sources.length ? `<ol class="sources">${sources.join('')}</ol>` : '<p>No source links were returned with this result.</p>'}</section><footer>Prepared by Snowy. Open source links to review the original material.</footer></main></body></html>`
  fs.writeFileSync(target, body, { encoding: 'utf8', flag: 'wx' })
  return { saved: true, path: target, title, format: 'HTML' }
}

async function searchBookMyShow(movieValue, cityValue = 'Kalaburagi') {
  const movie = String(movieValue || '').trim()
  if (!movie || movie.length > 160) throw new Error('Name the movie you want to check (up to 160 characters).')
  const city = String(cityValue || 'Kalaburagi').trim()
  const cityKey = /kalaburagi|kalburgi|gulbarga/i.test(city) ? 'kalaburagi-gulbarga' : ''
  if (!cityKey) throw new Error('This BookMyShow lookup currently supports Kalaburagi (Gulbarga).')
  const cityUrl = `https://in.bookmyshow.com/explore/home/${cityKey}`
  const tab = await openManagedChromeTab(cityUrl)
  await fetch(`http://127.0.0.1:${chromeDebugPort}/json/activate/${tab.id}`).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const targets = (await chromeTargets()).filter((item) => item.type === 'page')
  let target = targets.find((item) => item.id === managedChromeTabId)
  if (!target) throw new Error('The managed BookMyShow tab could not be found.')
  const scrape = async () => {
    const expression = `JSON.stringify({title:document.title,url:location.href,body:(document.body?.innerText||'').slice(0,12000),movies:Array.from(new Map(Array.from(document.querySelectorAll('a[href*="/movies/"]')).map(a=>({title:(a.innerText||a.getAttribute('aria-label')||'').trim(),href:a.href})).filter(x=>x.title&&x.href.startsWith('https://in.bookmyshow.com/')).map(x=>[x.href,x])).values()).slice(0,80)})`
    const evaluated = await sendChromeCommand(target, 'Runtime.evaluate', { expression, returnByValue: true })
    return JSON.parse(evaluated.result?.value || '{}')
  }
  let page = await scrape()
  for (let attempt = 0; attempt < 8 && !page.movies.length && page.body.length < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    page = await scrape()
  }
  const normalize = (value) => String(value || '').toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const query = normalize(movie)
  const matches = page.movies.filter((item) => {
    const title = normalize(item.title)
    return title === query || title.includes(query) || query.includes(title)
  })
  if (matches.length !== 1) return {
    city: 'Kalaburagi (Gulbarga)', movie, matched: false, candidateMovies: page.movies.slice(0, 20).map((item) => item.title),
    pageTitle: page.title, pageUrl: page.url, instruction: matches.length > 1 ? 'Several movie titles matched. Ask the user to clarify; do not open a guessed movie.' : 'No matching movie was listed on the Kalaburagi city page. Report that no match was found; do not search another tab or city automatically.',
  }
  const movieUrl = new URL(matches[0].href)
  if (movieUrl.protocol !== 'https:' || movieUrl.hostname !== 'in.bookmyshow.com') throw new Error('BookMyShow returned an unsafe movie link.')
  await sendChromeCommand(target, 'Page.navigate', { url: movieUrl.toString() })
  await new Promise((resolve) => setTimeout(resolve, 1800))
  target = (await chromeTargets()).find((item) => item.id === managedChromeTabId && item.type === 'page')
  if (!target) throw new Error('The BookMyShow movie page closed before availability could be read.')
  page = await scrape()
  for (let attempt = 0; attempt < 8 && page.body.length < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    page = await scrape()
  }
  return { city: 'Kalaburagi (Gulbarga)', movie: matches[0].title, matched: true, pageTitle: page.title, pageUrl: page.url, visibleAvailabilityText: page.body.slice(0, 8000), instruction: 'Summarize only showtimes or availability visibly shown on this BookMyShow page. If the page asks the user to choose a date/cinema or sign in, say so. Never book, select seats, or pay.' }
}

async function closeManagedChromeTab(target) {
  const needle = normalizeAppName(String(target || '').replace(/\b(tab|website|page)\b/ig, ' '))
  if (!needle) throw new Error('Please name the Chrome tab to close.')
  const pages = (await chromeTargets()).filter((item) => item.type === 'page' && !item.url.startsWith('devtools://'))
  const matches = pages.filter((item) => normalizeAppName(`${item.title} ${item.url}`).includes(needle))
  if (matches.length === 0) throw new Error(`I couldn't find an open Chrome tab matching “${target}” in Snowy’s Chrome window.`)
  if (matches.length > 1) throw new Error(`Several Chrome tabs match “${target}”. Please say more of the tab title.`)
  const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/close/${matches[0].id}`)
  if (!response.ok) throw new Error('Chrome could not close that tab.')
  return { closedTab: matches[0].title || matches[0].url }
}

async function getComputerStatus() {
  const script = "$cpus = @(Get-CimInstance Win32_Processor); $cpuLoad = ($cpus | Measure-Object -Property LoadPercentage -Average).Average; $os = Get-CimInstance Win32_OperatingSystem; $memTotal = $os.TotalVisibleMemorySize/1MB; $memFree = $os.FreePhysicalMemory/1MB; $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ drive=$_.DeviceID; sizeGB=[math]::Round($_.Size/1GB,1); freeGB=[math]::Round($_.FreeSpace/1GB,1); usedPercent=[math]::Round((1-$_.FreeSpace/$_.Size)*100,1) } }); $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name=$_.Name; memoryGB=if($_.AdapterRAM){[math]::Round($_.AdapterRAM/1GB,1)}else{$null}; driver=$_.DriverVersion; status=$_.Status } }); $gpuUse = @(); try { $gpuUse = @(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop | Select-Object -ExpandProperty CounterSamples | Where-Object { $_.CookedValue -gt 0 } | Group-Object InstanceName | ForEach-Object { [pscustomobject]@{ engine=$_.Name; usagePercent=[math]::Round(($_.Group | Measure-Object CookedValue -Sum).Sum,1) } }) } catch {}; $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; [pscustomobject]@{ cpuName=($cpus | Select-Object -First 1 -ExpandProperty Name); cpuCores=($cpus | Measure-Object -Property NumberOfCores -Sum).Sum; logicalProcessors=($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; cpuLoadPercent=[math]::Round($cpuLoad,1); memoryTotalGB=[math]::Round($memTotal,1); memoryUsedGB=[math]::Round(($memTotal-$memFree),1); memoryFreeGB=[math]::Round($memFree,1); memoryUsedPercent=[math]::Round((1-$memFree/$memTotal)*100,1); disks=$disks; gpus=$gpus; gpuEngines=$gpuUse; battery=if($battery){[pscustomobject]@{ chargePercent=$battery.EstimatedChargeRemaining; status=$battery.BatteryStatus }}else{$null} } | ConvertTo-Json -Depth 5 -Compress"
  const data = JSON.parse(await runPowerShell(script, [], 20000))
  return data
}

async function capturePrimaryScreen() {
  const display = screen.getPrimaryDisplay()
  // Preserve enough detail for small controls and chat rows to be readable.
  const scale = Math.min(1, 1920 / display.bounds.width, 1080 / display.bounds.height)
  const requestedSize = {
    width: Math.max(1, Math.round(display.bounds.width * scale)),
    height: Math.max(1, Math.round(display.bounds.height * scale)),
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: requestedSize })
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0]
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) throw new Error('Could not capture the primary display.')
  const size = source.thumbnail.getSize()
  const image = {
    mimeType: 'image/jpeg',
    data: source.thumbnail.toJPEG(92).toString('base64'),
    width: size.width,
    height: size.height,
  }
  lastScreenCapture = { width: image.width, height: image.height, bounds: display.bounds, scaleFactor: display.scaleFactor, capturedAt: Date.now() }
  return image
}

async function inspectAccessibility(windowHint = '') {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$allWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$windows = @()
foreach ($win in $allWindows) {
  try {
    $windowName = [regex]::Replace([string]$win.Current.Name, '[\\x00-\\x1F\\x7F]', ' ').Trim()
    if ($win.Current.IsOffscreen -or -not $windowName -or $windowName -like '*Snowy*') { continue }
    if ([string]$v[0] -and $windowName -notlike ('*' + [string]$v[0] + '*')) { continue }
    $controls = @()
    $descendants = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $limit = [Math]::Min($descendants.Count, 120)
    for ($i = 0; $i -lt $limit; $i++) {
      try {
        $element = $descendants.Item($i)
        $current = $element.Current
        $controlName = [regex]::Replace([string]$current.Name, '[\\x00-\\x1F\\x7F]', ' ').Trim()
        if ($current.IsOffscreen -or -not $controlName) { continue }
        $rect = $current.BoundingRectangle
        if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
        $patterns = @()
        foreach ($pattern in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.ValuePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern)) { $patternObject=$null; if ($element.TryGetCurrentPattern($pattern, [ref]$patternObject)) { $patterns += $pattern.ProgrammaticName } }
        $automationId = [regex]::Replace([string]$current.AutomationId, '[\\x00-\\x1F\\x7F]', ' ').Trim()
        $controls += [pscustomobject]@{ name=$controlName; type=$current.ControlType.ProgrammaticName.Split('.')[-1]; automationId=$automationId; bounds=@{ x=[Math]::Round($rect.X); y=[Math]::Round($rect.Y); width=[Math]::Round($rect.Width); height=[Math]::Round($rect.Height) }; patterns=$patterns }
      } catch {}
    }
    $windows += [pscustomobject]@{ name=$windowName; controls=$controls }
    if ($windows.Count -ge 8) { break }
  } catch {}
}
[pscustomobject]@{ windows=$windows } | ConvertTo-Json -Depth 7 -Compress
`
  const output = await runPowerShell(script, [String(windowHint || '')], 25000)
  const result = JSON.parse(output || '{"windows":[]}')
  lastAccessibilitySnapshot = { capturedAt: Date.now(), result }
  return result
}

async function accessibilityAction(windowHint, controlName, controlType, action) {
  const window = String(windowHint || '').trim()
  const name = String(controlName || '').trim()
  const type = String(controlType || '').trim()
  const kind = String(action || '').toLowerCase()
  if (!window || !name || !type) throw new Error('Name the application window and the exact control name and type from a recent accessibility inspection.')
  if (!['click', 'focus'].includes(kind)) throw new Error('Choose click or focus for the accessibility action. Use verified type_text to enter text.')
  if (!lastAccessibilitySnapshot || Date.now() - lastAccessibilitySnapshot.capturedAt > 15000) {
    throw new Error('Inspect the application controls immediately before acting; the previous accessibility snapshot is missing or expired.')
  }
  const matchingWindows = (lastAccessibilitySnapshot.result.windows || []).filter((item) => item.name.toLowerCase().includes(window.toLowerCase()))
  if (matchingWindows.length !== 1) throw new Error(`The recent inspection did not identify exactly one window matching ${window}. Inspect it again.`)
  const matchingControls = matchingWindows[0].controls.filter((item) => item.name === name && item.type === type)
  if (matchingControls.length !== 1) throw new Error(`The recent inspection did not identify exactly one ${type} control named ${name}. Inspect the application again.`)
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$matchingWindows = @($windows | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -like ('*' + [string]$v[0] + '*') })
if ($matchingWindows.Count -ne 1) { throw ('Expected one visible window matching ' + [string]$v[0] + ', found ' + $matchingWindows.Count + '.') }
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$v[1])
$matches = $matchingWindows[0].FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$items = @()
foreach ($item in $matches) { if (-not $item.Current.IsOffscreen -and (-not [string]$v[2] -or $item.Current.ControlType.ProgrammaticName.Split('.')[-1] -eq [string]$v[2])) { $items += $item } }
if ($items.Count -ne 1) { throw ('Expected one exact visible control named ' + [string]$v[1] + ', found ' + $items.Count + '. Inspect the accessibility tree and be more specific.') }
$item = $items[0]
if ([string]$v[3] -eq 'focus') { $item.SetFocus(); $result='focused' }
else {
  $invoke = $null
  if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
  else {
    $rect = $item.Current.BoundingRectangle
    $x = [int][Math]::Round($rect.X + $rect.Width / 2); $y = [int][Math]::Round($rect.Y + $rect.Height / 2)
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SnowyUiaMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'
    [SnowyUiaMouse]::SetCursorPos($x,$y) | Out-Null; [SnowyUiaMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [SnowyUiaMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  }
  $result='clicked'
}
[pscustomobject]@{ result=$result; window=$matchingWindows[0].Current.Name; control=$item.Current.Name; type=$item.Current.ControlType.ProgrammaticName.Split('.')[-1] } | ConvertTo-Json -Compress
`
  if (kind === 'click') {
    lastAccessibilitySnapshot = null
    lastScreenCapture = null
  }
  const output = await runPowerShell(script, [window, name, String(controlType || ''), kind], 15000)
  return JSON.parse(output)
}

async function getVisibleWhatsAppNotification() {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$found = $null
foreach ($win in $top) {
  try {
    $title = [regex]::Replace([string]$win.Current.Name, '[\\x00-\\x1F\\x7F]', ' ').Trim()
    $className = [string]$win.Current.ClassName
    if ($win.Current.IsOffscreen -or ($className -notmatch 'CoreWindow|Toast|Notification' -and $title -notmatch 'Notification|WhatsApp')) { continue }
    $windowBounds = $win.Current.BoundingRectangle
    if ($title -match 'Action Center|Notification Center' -or $windowBounds.Width -gt 900 -or $windowBounds.Height -gt 550) { continue }
    $items = @()
    $descendants = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt [Math]::Min($descendants.Count, 100); $i++) {
      try {
        $item = $descendants.Item($i)
        if ($item.Current.IsOffscreen -or $item.Current.ControlType.ProgrammaticName -ne 'ControlType.Text') { continue }
        $text = [regex]::Replace([string]$item.Current.Name, '[\\x00-\\x1F\\x7F]', ' ').Trim()
        if ($text -and $text -notmatch '^(Reply|Mark as read|Dismiss|Close|WhatsApp|Now|Just now|Today|Yesterday|[0-9]{1,2}:[0-9]{2}(\s*[AP]M)?|[0-9]+\s+(new\s+)?(messages?|updates?))$' -and -not $items.Contains($text)) { $items += $text }
      } catch {}
    }
    $allText = ($title + ' ' + ($items -join ' '))
    if ($allText -match '(?i)WhatsApp' -and $items.Count -ge 2) {
      $sender = [string]$items[0]
      if ($sender -match '^[+]?[0-9\s().-]{7,}$') { $sender = 'WhatsApp contact' }
      $message = ($items | Select-Object -Skip 1) -join ' '
      if ($message.Trim()) { $found = [pscustomobject]@{ sender=$sender; message=$message.Trim(); window=$title } }
      break
    }
  } catch {}
}
[pscustomobject]@{ notification=$found } | ConvertTo-Json -Depth 4 -Compress
`
  const output = await runPowerShell(script, [], 10000)
  return JSON.parse(output || '{"notification":null}').notification
}

function scheduleWhatsAppNotificationPoll(delayMs = 10000) {
  if (whatsappNotificationTimer) clearTimeout(whatsappNotificationTimer)
  if (!whatsappNotificationReadingEnabled) return
  whatsappNotificationTimer = setTimeout(async () => {
    try {
      const notification = await getVisibleWhatsAppNotification()
      if (notification && notification.message) {
        const key = `${notification.sender}|${notification.message}`.toLowerCase().replace(/\s+/g, ' ').trim()
        const now = Date.now()
        for (const [seenKey, seenAt] of seenWhatsAppNotifications) if (now - seenAt > 30 * 60 * 1000) seenWhatsAppNotifications.delete(seenKey)
        if (!seenWhatsAppNotifications.has(key)) {
          seenWhatsAppNotifications.set(key, now)
          while (seenWhatsAppNotifications.size > 100) seenWhatsAppNotifications.delete(seenWhatsAppNotifications.keys().next().value)
          if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('notification:whatsapp', notification)
        }
      }
    } catch (error) {
      if (!notificationPollErrorLogged) {
        notificationPollErrorLogged = true
        console.warn('WhatsApp notification check failed:', error.message)
      }
    } finally {
      scheduleWhatsAppNotificationPoll()
    }
  }, delayMs)
}

function setWhatsAppNotificationReading(enabled) {
  whatsappNotificationReadingEnabled = Boolean(enabled)
  fs.mkdirSync(path.dirname(notificationPreferenceFile), { recursive: true })
  fs.writeFileSync(notificationPreferenceFile, JSON.stringify({ whatsapp: whatsappNotificationReadingEnabled }), 'utf8')
  scheduleWhatsAppNotificationPoll()
  return { enabled: whatsappNotificationReadingEnabled, source: 'visible Windows WhatsApp notification banners', opensChat: false }
}

function loadWhatsAppNotificationPreference() {
  try {
    whatsappNotificationReadingEnabled = Boolean(JSON.parse(fs.readFileSync(notificationPreferenceFile, 'utf8')).whatsapp)
  } catch {
    // Notification scanning is opt-in; the user can enable it by asking Snowy.
    whatsappNotificationReadingEnabled = false
  }
  scheduleWhatsAppNotificationPoll()
}

function saveReminders() {
  fs.mkdirSync(path.dirname(remindersFile), { recursive: true })
  fs.writeFileSync(remindersFile, JSON.stringify(reminders, null, 2), 'utf8')
}

function scheduleReminder(reminder) {
  const delay = Math.max(0, reminder.dueAt - Date.now())
  const timer = setTimeout(() => {
    reminderTimers.delete(reminder.id)
    reminders = reminders.filter((item) => item.id !== reminder.id)
    saveReminders()
    if (Notification.isSupported()) new Notification({ title: 'Snowy reminder', body: reminder.message }).show()
    if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('reminder:due', { message: reminder.message })
  }, delay)
  reminderTimers.set(reminder.id, timer)
}

function loadReminders() {
  try {
    const saved = JSON.parse(fs.readFileSync(remindersFile, 'utf8'))
    reminders = Array.isArray(saved) ? saved.filter((item) => item?.id && item?.message && Number.isFinite(item.dueAt) && item.dueAt > Date.now()) : []
  } catch {
    reminders = []
  }
  for (const reminder of reminders) scheduleReminder(reminder)
}

function createReminder(minutesValue, messageValue) {
  const minutes = Number(minutesValue)
  const message = String(messageValue || '').trim()
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('Reminder time must be between 1 minute and 7 days from now.')
  if (!message || message.length > 240) throw new Error('Reminder text must contain 1 to 240 characters.')
  if (reminders.length >= 50) throw new Error('Snowy can keep up to 50 pending reminders. Clear one before adding another.')
  const reminder = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dueAt: Date.now() + minutes * 60000, message }
  reminders.push(reminder)
  saveReminders()
  scheduleReminder(reminder)
  return { scheduled: true, message, dueAt: new Date(reminder.dueAt).toISOString() }
}

function listReminders() {
  return reminders.map(({ message, dueAt }) => ({ message, dueAt: new Date(dueAt).toISOString() }))
}

function cancelReminder(messageValue) {
  const query = String(messageValue || '').trim().toLowerCase()
  if (!query) throw new Error('Name the reminder to cancel.')
  const matches = reminders.filter((item) => item.message.toLowerCase().includes(query))
  if (matches.length !== 1) throw new Error(`Found ${matches.length} matching reminders. Say more of the reminder text.`)
  const [reminder] = matches
  clearTimeout(reminderTimers.get(reminder.id))
  reminderTimers.delete(reminder.id)
  reminders = reminders.filter((item) => item.id !== reminder.id)
  saveReminders()
  return { cancelled: reminder.message }
}

function nextLocalTime(time) {
  const [hours, minutes] = time.split(':').map(Number)
  const now = new Date()
  const next = new Date(now)
  next.setHours(hours, minutes, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next
}

function scheduleAutomation(automation) {
  clearTimeout(automationTimers.get(automation.id))
  const delay = Math.max(1000, nextLocalTime(automation.time).getTime() - Date.now())
  const timer = setTimeout(async () => {
    scheduleAutomation(automation)
    let message
    try {
      const result = await researchWeb(automation.query)
      message = result.error
        ? `Your daily search for ${automation.query} could not run: ${result.error}`
        : `Daily search for ${automation.query}: ${result.answer}`
      automation.sources = result.sources || []
    } catch (error) {
      message = `Your daily search for ${automation.query} could not run: ${error.message || 'unknown error'}`
    }
    const notice = { message: String(message).slice(0, 1800), automationId: automation.id, sources: automation.sources || [] }
    if (Notification.isSupported()) new Notification({ title: 'Snowy daily automation', body: notice.message.slice(0, 240) }).show()
    if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('automation:due', notice)
  }, delay)
  automationTimers.set(automation.id, timer)
}

function createDailyResearchAutomation(time, query) {
  const created = automationStore.createDailyResearch(time, query)
  scheduleAutomation(created)
  return { ...created, nextRunAt: nextLocalTime(created.time).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
}

function cancelAutomation(query) {
  const result = automationStore.cancel(query)
  clearTimeout(automationTimers.get(result.id))
  automationTimers.delete(result.id)
  return { cancelled: result.cancelled, time: result.time }
}

async function chooseFileFolder() {
  const result = await dialog.showOpenDialog(companionWindow, { title: 'Choose a folder Snowy may search', properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths?.[0]) return { cancelled: true }
  return fileManagement.addFolder(result.filePaths[0])
}

async function prepareDownloadsOrganization() {
  const downloadsPath = app.getPath('downloads')
  const approvedFolder = fileManagement.addFolder(downloadsPath)
  let openError = ''
  try { openError = await shell.openPath(downloadsPath) } catch (error) { openError = error.message || 'Windows Explorer could not be opened.' }
  const preview = fileManagement.previewOrganization(approvedFolder.folderId)
  return {
    ...preview,
    folderId: approvedFolder.folderId,
    explorerOpened: !openError,
    ...(openError ? { explorerError: openError } : {}),
  }
}

async function applyOrganizationWithConfirmation(previewId) {
  const preview = fileManagement.previews.get(String(previewId || ''))
  if (!preview || Date.now() - preview.createdAt > 10 * 60 * 1000) throw new Error('That organization preview expired. Create a fresh preview first.')
  if (!preview.plan.length) return { applied: false, moved: [], skipped: [], message: 'There are no files to move.' }
  const choice = await dialog.showMessageBox(companionWindow, {
    type: 'question',
    title: 'Organize files with Snowy?',
    message: `Move ${preview.plan.length} files from “${preview.folderName}”?`,
    detail: `Snowy will move files into “Snowy Organized” inside the same approved folder. Existing files will not be overwritten.\n\n${preview.plan.slice(0, 12).map((item) => `${item.from}  →  ${path.relative(preview.folderPath, item.destination)}`).join('\n')}${preview.plan.length > 12 ? `\n…and ${preview.plan.length - 12} more.` : ''}`,
    buttons: ['Move files', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (choice.response !== 0) return { applied: false, cancelled: true, message: 'No files were moved.' }
  return { applied: true, ...fileManagement.applyOrganization(previewId) }
}

async function undoOrganizationWithConfirmation(undoId) {
  const plan = fileManagement.undoPlans.get(String(undoId || ''))
  if (!plan) throw new Error('That file organization can no longer be undone from this session.')
  const choice = await dialog.showMessageBox(companionWindow, {
    type: 'question', title: 'Undo Snowy file organization?',
    message: `Move up to ${plan.moved.length} files back to their original locations?`,
    detail: 'Snowy will only restore a file when its original filename is still free. Existing files will never be overwritten.',
    buttons: ['Undo moves', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
  })
  if (choice.response !== 0) return { undone: false, cancelled: true, message: 'No files were moved.' }
  return { undone: true, ...fileManagement.undoOrganization(undoId) }
}

function readClipboardText() {
  const text = clipboard.readText().trim()
  if (!text) return { empty: true }
  return { text: text.slice(0, 4000), truncated: text.length > 4000 }
}

async function clickScreen(xValue, yValue, button = 'left', clickCount = 1) {
  if (!lastScreenCapture || Date.now() - lastScreenCapture.capturedAt > 60000) {
    return { clicked: false, needsFreshCapture: true, screen: await capturePrimaryScreen(), instruction: 'The old screen coordinates expired. A fresh screen image is attached; inspect it before trying another click.' }
  }
  const x = Number(xValue)
  const y = Number(yValue)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= lastScreenCapture.width || y >= lastScreenCapture.height) {
    throw new Error(`Click coordinates must be inside the latest ${lastScreenCapture.width}×${lastScreenCapture.height} screen capture.`)
  }
  const screenX = Math.round((lastScreenCapture.bounds.x + x * lastScreenCapture.bounds.width / lastScreenCapture.width) * lastScreenCapture.scaleFactor)
  const screenY = Math.round((lastScreenCapture.bounds.y + y * lastScreenCapture.bounds.height / lastScreenCapture.height) * lastScreenCapture.scaleFactor)
  const isRight = button === 'right'
  const count = Math.max(1, Math.min(2, Number(clickCount) || 1))
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SnowyMouseInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y, bool right, int count) {
    SetCursorPos(x, y);
    uint down = right ? 0x0008u : 0x0002u;
    uint up = right ? 0x0010u : 0x0004u;
    for (int i = 0; i < count; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }
}
'@
[SnowyMouseInput]::Click([int]$v[0], [int]$v[1], ([string]$v[2] -eq 'right'), [int]$v[3])
`
  await runPowerShell(script, [screenX, screenY, isRight ? 'right' : 'left', count], 8000)
  lastScreenCapture = null
  return { clicked: true, x, y, button: isRight ? 'right' : 'left' }
}

async function typeText(textValue, windowHintValue, controlNameValue, controlTypeValue, recipientValue = '') {
  const value = String(textValue || '')
  if (!value || value.length > 2000) throw new Error('Text must contain between 1 and 2000 characters.')
  const windowHint = String(windowHintValue || '').trim()
  const controlName = String(controlNameValue || '').trim()
  const controlType = String(controlTypeValue || '').trim()
  const recipient = String(recipientValue || '').trim()
  if (!windowHint || !controlName || !controlType) throw new Error('Inspect the app first and provide its window name and exact text-field name and type.')
  if (!['Edit', 'Document', 'ComboBox'].includes(controlType)) throw new Error('The selected UI control is not a supported text field. Inspect the current app and select its text composer.')
  if (!lastAccessibilitySnapshot || Date.now() - lastAccessibilitySnapshot.capturedAt > 15000) throw new Error('The app controls have not been inspected recently. Inspect them immediately before typing.')

  const normalizeText = (text) => String(text || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const matchingWindows = (lastAccessibilitySnapshot.result.windows || []).filter((item) => item.name.toLocaleLowerCase().includes(windowHint.toLocaleLowerCase()))
  if (matchingWindows.length !== 1) throw new Error(`The latest inspection did not identify exactly one window matching “${windowHint}”.`)
  const matchingFields = matchingWindows[0].controls.filter((item) => item.name === controlName && item.type === controlType)
  if (matchingFields.length !== 1) throw new Error(`The latest inspection did not identify exactly one ${controlType} field named “${controlName}”. Inspect again.`)

  const isWhatsApp = /whats\s*app/i.test(windowHint) || /whats\s*app/i.test(matchingWindows[0].name)
  let recipientVerified = false
  if (isWhatsApp) {
    if (!recipient) throw new Error('For WhatsApp, provide the exact recipient whose open chat header you verified.')
    if (!lastScreenCapture || Date.now() - lastScreenCapture.capturedAt > 15000) throw new Error('Capture and inspect the current WhatsApp screen immediately before typing.')
    if (lastAccessibilitySnapshot.capturedAt < lastScreenCapture.capturedAt) throw new Error('Capture the current screen first, then inspect WhatsApp controls before typing.')
    const recipientNeedle = normalizeText(recipient)
    recipientVerified = matchingWindows[0].controls.some((item) => {
      const visibleName = normalizeText(item.name)
      return visibleName === recipientNeedle || visibleName.includes(recipientNeedle)
    })
    if (!recipientVerified) throw new Error(`The latest WhatsApp controls do not show “${recipient}”. Do not type into a different chat.`)
  }

  lastAccessibilitySnapshot = null
  const screenCapture = lastScreenCapture
  lastScreenCapture = null
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct SnowyKeyboardInput { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct SnowyInputUnion { [FieldOffset(0)] public SnowyKeyboardInput Keyboard; }
[StructLayout(LayoutKind.Sequential)] public struct SnowyInput { public uint Type; public SnowyInputUnion Union; }
public static class SnowyTextInput {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, SnowyInput[] inputs, int size);
  public static void TypeText(string text) {
    foreach (char ch in text) {
      SnowyInput down = new SnowyInput { Type = 1, Union = new SnowyInputUnion { Keyboard = new SnowyKeyboardInput { ScanCode = ch, Flags = 0x0004 } } };
      SnowyInput up = new SnowyInput { Type = 1, Union = new SnowyInputUnion { Keyboard = new SnowyKeyboardInput { ScanCode = ch, Flags = 0x0006 } } };
      SnowyInput[] pair = new SnowyInput[] { down, up };
      if (SendInput(2, pair, Marshal.SizeOf(typeof(SnowyInput))) != 2) throw new InvalidOperationException("Windows did not accept the text input.");
    }
  }
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$allWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$matchingWindows = @()
foreach ($candidate in $allWindows) { if (-not $candidate.Current.IsOffscreen -and $candidate.Current.Name -like ('*' + [string]$v[1] + '*')) { $matchingWindows += $candidate } }
if ($matchingWindows.Count -ne 1) { throw ('Expected exactly one visible app window matching ' + [string]$v[1] + ', found ' + $matchingWindows.Count + '.') }
$window = $matchingWindows[0]
if ([string]$v[4]) {
  $recipientMatches = @()
  $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($candidate in $controls) { if (-not $candidate.Current.IsOffscreen -and ([string]$candidate.Current.Name).IndexOf([string]$v[4], [StringComparison]::OrdinalIgnoreCase) -ge 0) { $recipientMatches += $candidate } }
  if ($recipientMatches.Count -eq 0) { throw ('The visible WhatsApp window no longer shows recipient ' + [string]$v[4] + '.') }
}
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$v[2])
$matches = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$fields = @()
foreach ($candidate in $matches) { if (-not $candidate.Current.IsOffscreen -and $candidate.Current.ControlType.ProgrammaticName.Split('.')[-1] -eq [string]$v[3]) { $fields += $candidate } }
if ($fields.Count -ne 1) { throw ('Expected one visible text field named ' + [string]$v[2] + ', found ' + $fields.Count + '.') }
$window.SetFocus()
$field = $fields[0]
$field.SetFocus()
Start-Sleep -Milliseconds 120
$foreground = [System.Windows.Automation.AutomationElement]::FromHandle([SnowyTextInput]::GetForegroundWindow())
if (-not $foreground -or $foreground.Current.Name -notlike ('*' + [string]$v[1] + '*')) { throw 'The requested app is not the active window. Snowy did not type.' }
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
$focusedType = $focused.Current.ControlType.ProgrammaticName.Split('.')[-1]
$withinField = $false
$node = $focused
for ($depth = 0; $depth -lt 12 -and $node; $depth++) { if ($node.Equals($field)) { $withinField = $true; break }; $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node) }
if (-not $withinField) { throw 'Windows did not focus the selected text field. Snowy did not type.' }
[SnowyTextInput]::TypeText([string]$v[0])
Start-Sleep -Milliseconds 250
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
$observed = ''
$valuePattern = $null
if ($field.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { $observed = [string]$valuePattern.Current.Value }
if (-not $observed) {
  $textPattern = $null
  if ($field.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) { $observed = $textPattern.DocumentRange.GetText(4000) }
}
$verified = $observed.Contains([string]$v[0])
[pscustomobject]@{ typedCharacters=([string]$v[0]).Length; verified=$verified; window=$foreground.Current.Name; field=$field.Current.Name; recipientVerified=([bool][string]$v[4]) } | ConvertTo-Json -Compress
`
  const output = await runPowerShell(script, [value, windowHint, controlName, controlType, recipient], 20000)
  return { ...JSON.parse(output), ...(isWhatsApp ? { recipientVerified, screenshotFresh: Boolean(screenCapture) } : {}) }
}

async function pressKey(keyName) {
  const keyCodes = { ENTER: 0x0D, TAB: 0x09, ESCAPE: 0x1B, SPACE: 0x20, BACKSPACE: 0x08, ARROWDOWN: 0x28, ARROWUP: 0x26 }
  const code = keyCodes[String(keyName || '').toUpperCase()]
  if (!code) throw new Error('That key is not available for remote key presses.')
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct SnowyKeyInput { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct SnowyMouseData { public int X; public int Y; public uint Data; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct SnowyHardwareData { public uint Message; public ushort ParamL; public ushort ParamH; }
[StructLayout(LayoutKind.Explicit)] public struct SnowyUnion { [FieldOffset(0)] public SnowyKeyInput Keyboard; [FieldOffset(0)] public SnowyMouseData Mouse; [FieldOffset(0)] public SnowyHardwareData Hardware; }
[StructLayout(LayoutKind.Sequential)] public struct SnowyInputData { public uint Type; public SnowyUnion Union; }
public static class SnowyKeySender {
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, SnowyInputData[] inputs, int size);
  public static void Press(ushort key) {
    SnowyInputData down = new SnowyInputData { Type = 1, Union = new SnowyUnion { Keyboard = new SnowyKeyInput { VirtualKey = key } } };
    SnowyInputData up = new SnowyInputData { Type = 1, Union = new SnowyUnion { Keyboard = new SnowyKeyInput { VirtualKey = key, Flags = 2 } } };
    SnowyInputData[] pair = new SnowyInputData[] { down, up };
    if (SendInput(2, pair, Marshal.SizeOf(typeof(SnowyInputData))) != 2) throw new InvalidOperationException("Windows did not accept the key press.");
  }
}
'@
$keyCode = [System.Convert]::ToUInt16($v[0])
[SnowyKeySender]::Press($keyCode)
`
  await runPowerShell(script, [code], 8000)
  return { pressed: String(keyName).toUpperCase() }
}

async function manageDesktop(action, target) {
  const name = String(target || '').trim()
  if (!name || name.length > 100) throw new Error('Please say the application or website name.')
  if (action === 'open_app') {
    const apps = await getInstalledApps()
    const needle = normalizeAppName(name)
    const exact = apps.filter((item) => normalizeAppName(item.Name) === needle)
    const matches = exact.length ? exact : apps.filter((item) => normalizeAppName(item.Name).includes(needle) || needle.includes(normalizeAppName(item.Name)))
    if (!matches.length) throw new Error(`I couldn't find “${name}” in the Windows Start menu app list.`)
    if (matches.length > 1) throw new Error(`I found several apps matching “${name}”: ${matches.slice(0, 5).map((item) => item.Name).join(', ')}. Please say the full app name.`)
    await runPowerShell("Start-Process ('shell:AppsFolder\\' + [string]$v[0])", [matches[0].AppID], 8000)
    return { opened: matches[0].Name }
  }
  if (action === 'close_app') {
    const normalizedName = normalizeAppName(name.replace(/\.exe$/i, ''))
    const browserNames = ['browser', 'chrome', 'googlechrome', 'edge', 'microsoftedge', 'firefox', 'brave', 'opera', 'vivaldi']
    if (browserNames.includes(normalizedName)) {
      const result = await runPowerShell(
        "$p = @(Get-Process -Name chrome,msedge,firefox,brave,opera,vivaldi -ErrorAction SilentlyContinue); if ($p.Count -eq 0) { throw 'No supported browser is currently running.' }; $names = @($p | ForEach-Object { $_.ProcessName } | Select-Object -Unique); foreach ($item in $p) { if ($item.MainWindowHandle -ne 0) { [void]$item.CloseMainWindow() } }; Start-Sleep -Milliseconds 700; $remaining = @($p | Where-Object { -not $_.HasExited }); if ($remaining.Count -gt 0) { $remaining | Stop-Process -Force -ErrorAction SilentlyContinue }; [pscustomobject]@{ closedProcesses = $names; count = $p.Count } | ConvertTo-Json -Compress",
        [],
        10000,
      )
      return { closed: 'browser', processes: result }
    }
    const result = await runPowerShell(
      "$n = ([string]$v[0] -replace '(?i)\\.exe$', '' -replace '[^a-zA-Z0-9]', '').ToLowerInvariant(); if ($n -eq 'taskmanager') { $n = 'taskmgr' }; $p = @(Get-Process | Where-Object { $x = ($_.ProcessName -replace '[^a-zA-Z0-9]', '').ToLowerInvariant(); $title = ($_.MainWindowTitle -replace '[^a-zA-Z0-9]', '').ToLowerInvariant(); ($x -eq $n -or $x -eq ($n + 'app') -or ($title -and $title.Contains($n))) }); if ($p.Count -eq 0) { throw ('No running application window matched ' + $v[0] + '. Try its exact app name.') }; $names = @($p | ForEach-Object { $_.ProcessName } | Select-Object -Unique); foreach ($item in $p) { if ($item.MainWindowHandle -ne 0) { [void]$item.CloseMainWindow() } }; Start-Sleep -Milliseconds 700; $remaining = @($p | Where-Object { -not $_.HasExited }); if ($remaining.Count -gt 0) { $remaining | Stop-Process -Force -ErrorAction SilentlyContinue }; [pscustomobject]@{ closedProcesses = $names; count = $p.Count } | ConvertTo-Json -Compress",
      [name.replace(/\.exe$/i, '')],
      10000,
    )
    return { closed: name, details: result }
  }
  if (action === 'open_website') {
    const knownSites = { youtube: 'https://www.youtube.com', google: 'https://www.google.com', wikipedia: 'https://www.wikipedia.org', reddit: 'https://www.reddit.com', github: 'https://github.com' }
    const candidate = /^https?:\/\//i.test(name)
      ? name
      : knownSites[name.toLowerCase()]
        || (/^[a-z0-9-]+\.[a-z]{2,}(\/.*)?$/i.test(name) ? `https://${name}` : `https://www.google.com/search?q=${encodeURIComponent(name)}`)
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be opened.')
    const tab = await openManagedChromeTab(url.toString())
    return { opened: url.toString(), title: tab.title }
  }
  if (action === 'close_browser_tab') {
    if (['chrome', 'googlechrome', 'edge', 'microsoftedge', 'firefox', 'brave', 'opera', 'vivaldi'].includes(normalizeAppName(name.replace(/\.exe$/i, '')))) {
      return manageDesktop('close_app', name)
    }
    return closeManagedChromeTab(name)
  }
  throw new Error('Unsupported desktop action.')
}

async function playYouTube(queryValue) {
  const query = String(queryValue || '').trim()
  if (!query || query.length > 200) throw new Error('Please say the song or artist to play.')
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  const tab = await openManagedChromeTab(url)
  await new Promise((resolve) => setTimeout(resolve, 3200))
  const pages = (await chromeTargets()).filter((item) => item.type === 'page')
  const target = pages.find((item) => item.id === managedChromeTabId)
  if (!target) throw new Error('The YouTube tab is no longer open.')
  const resultsExpression = `JSON.stringify(Array.from(document.querySelectorAll('ytd-video-renderer')).slice(0, 20).map((item) => { const titleEl=item.querySelector('#video-title'); const channelEl=item.querySelector('#channel-name'); const link=titleEl?.href || ''; const id=new URL(link, location.origin).searchParams.get('v'); const title=(titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(); const channel=(channelEl?.textContent || '').trim(); const ad=!!item.querySelector('ytd-ad-slot-renderer, #ad-badge, .badge-style-type-ad'); return {id,title,channel,ad}; }).filter((item) => item.id && item.title))`
  const result = await sendChromeCommand(target, 'Runtime.evaluate', { expression: resultsExpression, returnByValue: true })
  let results = []
  try { results = JSON.parse(result.result?.value || '[]') } catch { /* Search page is still loading or returned no readable results. */ }
  const ignored = new Set(['play', 'song', 'music', 'youtube', 'video', 'please', 'the', 'a', 'on', 'in', 'from', 'official', 'audio', 'lyrics', 'with', 'and', 'to'])
  const terms = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((term) => term.length > 1 && !ignored.has(term))
  const ranked = results.filter((item) => !item.ad).map((item) => {
    const text = `${item.title} ${item.channel}`.toLowerCase()
    const matched = terms.filter((term) => text.includes(term)).length
    const titleMatched = terms.filter((term) => item.title.toLowerCase().includes(term)).length
    return { ...item, score: terms.length ? (matched + titleMatched) / (2 * terms.length) : 0 }
  }).sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (!best || best.score < 0.55) {
    return { resultsOpened: true, url, candidates: ranked.slice(0, 5).map(({ title, channel }) => ({ title, channel })), instruction: 'No clear exact song match was found. Leave the search results open and ask the user to clarify; do not start a possibly wrong song.' }
  }
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(best.id)}`
  await openManagedChromeTab(watchUrl)
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const verifyPages = (await chromeTargets()).filter((item) => item.type === 'page')
  const verifyTarget = verifyPages.find((item) => item.id === managedChromeTabId)
  const verify = verifyTarget && await sendChromeCommand(verifyTarget, 'Runtime.evaluate', {
    expression: `JSON.stringify({title:document.title,playing:!!(document.querySelector('video') && !document.querySelector('video').paused && document.querySelector('video').currentTime > 0),ad:!!document.querySelector('#movie_player.ad-showing, .video-ads.ytp-ad-module:not(:empty)'),currentTime:document.querySelector('video')?.currentTime || 0})`,
    returnByValue: true,
  })
  let playback = {}
  try { playback = JSON.parse(verify?.result?.value || '{}') } catch { /* Keep verification unavailable. */ }
  return {
    opened: true,
    url: watchUrl,
    matchedTitle: best.title,
    matchedChannel: best.channel,
    matchConfidence: Math.round(best.score * 100),
    playbackVerified: Boolean(playback.playing && !playback.ad),
    advertisement: Boolean(playback.ad),
    instruction: playback.ad
      ? 'The selected YouTube video is showing an advertisement. Do not say the requested song has started; wait for the ad or tell the user an ad is playing.'
      : playback.playing
        ? 'The selected video is playing. Confirm the matched title and artist/channel in a short natural response.'
        : 'The exact result was opened, but playback could not be verified. Explain this instead of claiming success.',
  }
}

async function playSpotify(queryValue) {
  const query = String(queryValue || '').trim()
  if (!query || query.length > 200) throw new Error('Please say the song or artist to play.')
  const url = `https://open.spotify.com/search/${encodeURIComponent(query)}`
  const tab = await openManagedChromeTab(url)
  return {
    resultsOpened: true,
    title: tab.title || 'Spotify search results',
    url,
    instruction: 'Spotify search results are open. Inspect the screen and choose the exact matching song and artist, avoiding sponsored content. Verify playback before saying it is playing.',
  }
}

function checkSystemResources() {
  try {
    const mem = process.getSystemMemoryInfo()
    if (mem && mem.total > 0) {
      const usedMem = mem.total - mem.free
      const usagePercent = Math.round((usedMem / mem.total) * 100)
      const overloaded = usagePercent >= 85
      if (companionWindow && !companionWindow.isDestroyed()) {
        companionWindow.webContents.send('system:overload', {
          overloaded,
          usage: usagePercent,
        })
      }
    }
  } catch {
    // Ignore if not supported on the host platform
  }
}

function setPetHover(hovered) {
  if (!petIsCompact) return
  petIsHovered = Boolean(hovered)
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.setIgnoreMouseEvents(!petIsHovered, { forward: true })
  }
}

function clampWindowPosition(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
  const area = display.workArea
  return {
    x: Math.max(area.x, Math.min(Math.round(x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(y), area.y + area.height - height)),
  }
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const windowWidth = 150
  const windowHeight = 116
  const x = Math.round(primaryDisplay.workArea.x + (primaryDisplay.workArea.width - windowWidth) / 2)
  const y = primaryDisplay.workArea.y + 18

  const window = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    backgroundColor: '#00000000',
    transparent: true,
    frame: false,
    resizable: false,
    fullscreen: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  companionWindow = window

  window.once('ready-to-show', () => {
    window.show()
    checkSystemResources()
  })

  if (isDev) {
    const pixelSocket = process.env.SNOWY_PIXEL_SOCKET
    window.loadURL(`http://127.0.0.1:5173${pixelSocket ? `?pixelSocket=${encodeURIComponent(pixelSocket)}` : ''}`)
  } else {
    const pixelSocket = process.env.SNOWY_PIXEL_SOCKET
    window.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: pixelSocket ? { pixelSocket } : {},
    })
  }
}

async function speakOfflineGreeting() {
  if (process.platform !== 'win32') throw new Error('Offline speech is only configured for Windows.')
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$femaleVoices = @($synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Female })
$voice = $femaleVoices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-IN' } | Select-Object -First 1
if (-not $voice) { $voice = $femaleVoices | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if (-not $voice) { throw 'No installed female Windows speech voice is available for the offline greeting.' }
$synth.SelectVoice($voice.VoiceInfo.Name)
$synth.Rate = 0
$synth.Volume = 100
$synth.Speak([string]$v[0])
`
  await runPowerShell(script, ["Hello, Sumit sir. I'm here and ready to help. Please connect to the internet so I can help you further."], 20000)
  return { spoken: true }
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock()
if (!ownsSingleInstanceLock) app.quit()

if (ownsSingleInstanceLock) {
app.on('second-instance', () => {
  if (!companionWindow || companionWindow.isDestroyed()) return
  if (companionWindow.isMinimized()) companionWindow.restore()
  companionWindow.show()
  companionWindow.focus()
})

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    })
  }
  if (!fs.existsSync(geminiKeyFile) && safeStorage.isEncryptionAvailable() && fs.existsSync(encryptedGeminiKeyFile)) {
    const recoveredKey = safeStorage.decryptString(fs.readFileSync(encryptedGeminiKeyFile))
    fs.writeFileSync(geminiKeyFile, `${recoveredKey}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  ipcMain.handle('companion:close', () => app.quit())
  ipcMain.handle('companion:set-compact', (_event, compact) => {
    if (!companionWindow || companionWindow.isDestroyed()) return false
    petIsCompact = Boolean(compact)
    petIsHovered = false
    const width = compact ? 92 : 150
    const height = compact ? 112 : 116
    const bounds = companionWindow.getBounds()
    const position = clampWindowPosition(bounds.x, bounds.y, width, height)
    companionWindow.setBounds({ x: position.x, y: position.y, width, height })
    companionWindow.setIgnoreMouseEvents(petIsCompact, { forward: true })
    return Boolean(compact)
  })
  ipcMain.on('pet:hover', (_event, hovered) => setPetHover(hovered))

  console.log(`Gemini API key file: ${geminiKeyFile}`)
  ipcMain.handle('voice:get-api-key', readGeminiApiKey)
  ipcMain.handle('voice:create-session-token', readGeminiApiKey)
  ipcMain.handle('voice:speak-offline-greeting', () => speakOfflineGreeting())
  ipcMain.handle('research:web', async (_event, query) => rememberResearchResult({ ...(await researchWeb(query)), query: String(query || '').trim() }))
  ipcMain.handle('research:save-report', (_event, researchId, title) => saveResearchReport(researchId, title))
  ipcMain.handle('bookmyshow:search', (_event, movie, city) => searchBookMyShow(movie, city))
  ipcMain.handle('files:choose-folder', () => chooseFileFolder())
  ipcMain.handle('files:list-folders', () => fileManagement.listFolders())
  ipcMain.handle('project:inspect', (_event, folderId) => inspectProject(fileManagement, folderId))
  ipcMain.handle('files:list', (_event, folderId) => fileManagement.listFiles(folderId))
  ipcMain.handle('files:search', (_event, folderId, query) => fileManagement.searchFiles(folderId, query))
  ipcMain.handle('files:organize-preview', (_event, folderId) => fileManagement.previewOrganization(folderId))
  ipcMain.handle('files:organize-apply', (_event, previewId) => applyOrganizationWithConfirmation(previewId))
  ipcMain.handle('files:organize-undo', (_event, undoId) => undoOrganizationWithConfirmation(undoId))
  ipcMain.handle('files:prepare-downloads-organization', () => prepareDownloadsOrganization())
  ipcMain.handle('automation:create-daily-research', (_event, time, query) => createDailyResearchAutomation(time, query))
  ipcMain.handle('automation:list', () => automationStore.list())
  ipcMain.handle('automation:cancel', (_event, query) => cancelAutomation(query))
  ipcMain.handle('browser:open-external', async (_event, value) => {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') throw new Error('Only HTTPS source links can be opened.')
    await shell.openExternal(url.toString())
    return { opened: url.toString() }
  })
  ipcMain.handle('memory:remember', (_event, text, category) => assistantStore.remember(text, category))
  ipcMain.handle('memory:recall', (_event, query) => assistantStore.recall(query))
  ipcMain.handle('memory:forget', (_event, query) => assistantStore.forget(query))
  ipcMain.handle('todo:add', (_event, text) => todoStore.add(text))
  ipcMain.handle('todo:list', (_event, includeCompleted) => todoStore.list(Boolean(includeCompleted)))
  ipcMain.handle('todo:complete', (_event, query) => todoStore.complete(query))
  ipcMain.handle('todo:remove', (_event, query) => todoStore.remove(query))
  ipcMain.handle('skill:save', (_event, name, description, steps) => assistantStore.saveSkill(name, description, steps))
  ipcMain.handle('skill:list', () => assistantStore.listSkills())
  ipcMain.handle('skill:get', (_event, name) => assistantStore.getSkill(name))
  ipcMain.handle('desktop:command', (_event, action, target) => manageDesktop(action, target))
  ipcMain.handle('desktop:play-youtube', (_event, query) => playYouTube(query))
  ipcMain.handle('desktop:play-spotify', (_event, query) => playSpotify(query))
  ipcMain.handle('screen:capture', () => capturePrimaryScreen())
  ipcMain.handle('screen:inspect-accessibility', (_event, windowHint) => inspectAccessibility(windowHint))
  ipcMain.handle('screen:accessibility-action', (_event, windowHint, name, controlType, action) => accessibilityAction(windowHint, name, controlType, action))
  ipcMain.handle('desktop:click-screen', (_event, x, y, button, clickCount) => clickScreen(x, y, button, clickCount))
  ipcMain.handle('desktop:type-text', (_event, text, windowHint, controlName, controlType, recipient) => typeText(text, windowHint, controlName, controlType, recipient))
  ipcMain.handle('desktop:press-key', (_event, key) => pressKey(key))
  ipcMain.handle('system:get-status', () => getComputerStatus())
  ipcMain.handle('system:read-clipboard', () => readClipboardText())
  ipcMain.handle('reminder:create', (_event, minutes, message) => createReminder(minutes, message))
  ipcMain.handle('reminder:list', () => listReminders())
  ipcMain.handle('reminder:cancel', (_event, message) => cancelReminder(message))
  ipcMain.handle('notification:set-whatsapp-reading', (_event, enabled) => setWhatsAppNotificationReading(enabled))

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => (
    webContents === companionWindow?.webContents && permission === 'media'
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnly = details.mediaTypes?.includes('audio') && !details.mediaTypes?.includes('video')
    callback(webContents === companionWindow?.webContents && permission === 'media' && audioOnly)
  })

  createWindow()
  loadReminders()
  for (const automation of automationStore.read()) scheduleAutomation(automation)
  loadWhatsAppNotificationPreference()

  // Memory overload warnings do not need a frequent poll; reduce idle wakeups.
  resourceMonitorTimer = setInterval(checkSystemResources, 30000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
}

app.on('window-all-closed', () => {
  if (resourceMonitorTimer) clearInterval(resourceMonitorTimer)
  if (process.platform !== 'darwin') app.quit()
})
