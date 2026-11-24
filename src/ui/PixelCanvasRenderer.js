const THEMES = {
  garden: { fg: '#65402F', bg: '#F5F1E6', name: 'CHESTNUT' },
  fern: { fg: '#795238', bg: '#F4EADF', name: 'COCOA' },
  moss: { fg: '#594434', bg: '#F7F0E1', name: 'WALNUT' },
}

const FONT = {
  A:['010','101','111','101','101'], B:['110','101','110','101','110'], C:['011','100','100','100','011'], D:['110','101','101','101','110'],
  E:['111','100','110','100','111'], F:['111','100','110','100','100'], G:['011','100','101','101','011'], H:['101','101','111','101','101'],
  I:['111','010','010','010','111'], J:['001','001','001','101','010'], K:['101','101','110','101','101'], L:['100','100','100','100','111'],
  M:['101','111','111','101','101'], N:['101','111','111','111','101'], O:['010','101','101','101','010'], P:['110','101','110','100','100'],
  Q:['010','101','101','111','011'], R:['110','101','110','101','101'], S:['011','100','010','001','110'], T:['111','010','010','010','010'],
  U:['101','101','101','101','111'], V:['101','101','101','101','010'], W:['101','101','111','111','101'], X:['101','101','010','101','101'],
  Y:['101','101','010','010','010'], Z:['111','001','010','100','111'],
  0:['111','101','101','101','111'], 1:['010','110','010','010','111'], 2:['110','001','010','100','111'], 3:['110','001','010','001','110'],
  4:['101','101','111','001','001'], 5:['111','100','110','001','110'], 6:['011','100','110','101','010'], 7:['111','001','010','010','010'],
  8:['010','101','010','101','010'], 9:['010','101','011','001','110'],
  '.':['000','000','000','000','010'], ',':['000','000','000','010','100'], ':':['000','010','000','010','000'],
  '!':['010','010','010','000','010'], '?':['110','001','010','000','010'], '-':['000','000','111','000','000'],
  "'":['010','010','000','000','000'], '"':['101','101','000','000','000'], '/':['001','001','010','100','100'],
  '+':['000','010','111','010','000'], '*':['000','101','010','101','000'], '_':['000','000','000','000','111'],
  '<':['001','010','100','010','001'], '>':['100','010','001','010','100'], '(':['001','010','010','010','001'], ')':['100','010','010','010','100'],
}
const TYPEWRITER_INTERVAL = 9

const pixel = (ctx, x, y, width, height, color) => {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height))
}

function drawText(ctx, text, x, y, color, maxChars = Infinity) {
  const chars = String(text).toUpperCase().slice(0, maxChars)
  for (let index = 0; index < chars.length; index += 1) {
    const glyph = FONT[chars[index]]
    if (!glyph) continue
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        if (glyph[row][col] === '1') pixel(ctx, x + index * 4 + col, y + row, 1, 1, color)
      }
    }
  }
}

function wrapText(text, width = 37) {
  const words = String(text).toUpperCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const chunks = word.match(new RegExp(`.{1,${width}}`, 'g')) || ['']
    for (const chunk of chunks) {
      if (line && `${line} ${chunk}`.length > width) {
        lines.push(line)
        line = chunk
      } else {
        line = line ? `${line} ${chunk}` : chunk
      }
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function steppedBox(ctx, x, y, width, height, color) {
  pixel(ctx, x + 2, y, width - 4, 1, color)
  pixel(ctx, x, y + 2, 1, height - 4, color)
  pixel(ctx, x + 1, y + 1, 1, 1, color)
  pixel(ctx, x + width - 1, y + 2, 1, height - 4, color)
  pixel(ctx, x + width - 2, y + 1, 1, 1, color)
  pixel(ctx, x + 2, y + height - 1, width - 4, 1, color)
  pixel(ctx, x + 1, y + height - 2, 1, 1, color)
  pixel(ctx, x + width - 2, y + height - 2, 1, 1, color)
}

export class PixelCanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: true })
    this.model = { companionState: 'IDLE', dialogueText: '', moodLevel: 4, theme: 'garden', connected: false }
    this.lastText = ''
    this.textStartedAt = performance.now()
    this.frame = 0
    this.running = true
    this.lastPaintAt = 0
    this.timer = null
    this.request = null
    this.ctx.imageSmoothingEnabled = false
    this.tick = this.tick.bind(this)
    this.queueFrame()
  }

  frameInterval() {
    return this.model.companionState === 'IDLE' ? 250 : 67
  }

  queueFrame() {
    if (!this.running || this.model.compact) return
    window.clearTimeout(this.timer)
    if (this.request !== null) cancelAnimationFrame(this.request)
    const delay = Math.max(0, this.lastPaintAt + this.frameInterval() - performance.now())
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.request = requestAnimationFrame(this.tick)
    }, delay)
  }

  setModel(model) {
    const nextText = String(model.dialogueText || '')
    if (nextText !== this.lastText && !nextText.startsWith(this.lastText)) this.textStartedAt = performance.now()
    if (!this.lastText && nextText) this.textStartedAt = performance.now()
    const shouldRedraw = model !== this.model || nextText !== this.lastText
    this.lastText = nextText
    this.model = model
    if (shouldRedraw) this.queueFrame()
  }

  tick(now) {
    if (!this.running) return
    this.frame += 1
    this.draw(now)
    this.lastPaintAt = now
    this.request = null
    if (!this.model.compact) this.queueFrame()
  }

  draw(now) {
    const ctx = this.ctx
    const { fg, bg } = THEMES[this.model.theme] || THEMES.garden
    const state = this.model.companionState || 'IDLE'
    ctx.imageSmoothingEnabled = false
    if (this.model.compact) {
      ctx.clearRect(0, 0, 160, 90)
      return
    }

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, 160, 90)

    // Status strip and crisp dividers.
    drawText(ctx, 'SNOWY', 3, 4, fg)
    this.drawLink(ctx, fg, bg, this.model.connected, now)
    drawText(ctx, 'MOOD', 40, 4, fg)
    steppedBox(ctx, 59, 2, 28, 9, fg)
    for (let i = 0; i < 5; i += 1) {
      const on = i < this.model.moodLevel
      pixel(ctx, 61 + i * 5, 4, 3, 5, on ? fg : bg)
      if (!on) pixel(ctx, 61 + i * 5, 4, 3, 1, fg)
    }
    const date = new Date()
    drawText(ctx, `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`, 94, 4, fg)
    this.drawMic(ctx, fg, bg, state === 'LISTENING', now)
    pixel(ctx, 0, 11, 160, 1, fg)

    // Sparse checker pixels add texture while preserving the 1-bit palette.
    for (let y = 15; y < 64; y += 4) {
      for (let x = 8 + (y % 8); x < 152; x += 8) pixel(ctx, x, y, 1, 1, fg)
    }
    this.drawAvatar(ctx, fg, bg, state, now)

    // Pixel dialogue pane with two-line pagination and a typewriter cursor.
    pixel(ctx, 0, 66, 160, 1, fg)
    steppedBox(ctx, 2, 68, 156, 20, fg)
    const elapsed = Math.max(0, now - this.textStartedAt)
    const chars = Math.min(this.lastText.length, Math.floor(elapsed / TYPEWRITER_INTERVAL))
    const shown = this.lastText.slice(0, chars)
    const lines = wrapText(shown, 37)
    const allLines = wrapText(this.lastText, 37)
    const pageCount = Math.max(1, Math.ceil(allLines.length / 2))
    const pageIndex = chars >= this.lastText.length && pageCount > 1
      ? Math.floor((elapsed - this.lastText.length * TYPEWRITER_INTERVAL) / 2800) % pageCount
      : Math.max(0, pageCount - 1)
    const visibleLines = lines.slice(pageIndex * 2, pageIndex * 2 + 2)
    drawText(ctx, visibleLines[0] || '', 6, 73, fg, 37)
    drawText(ctx, visibleLines[1] || '', 6, 81, fg, 37)
    const cursorOn = Math.floor(now / 400) % 2 === 0
    if (cursorOn) {
      const cursorLine = visibleLines[1] !== undefined ? 1 : 0
      const cursorText = visibleLines[cursorLine] || ''
      pixel(ctx, Math.min(153, 6 + cursorText.length * 4), cursorLine ? 81 : 73, 3, 5, fg)
    }
  }

  drawLink(ctx, fg, bg, connected, now) {
    const x = 29
    const blink = connected || Math.floor(now / 450) % 2 === 0
    pixel(ctx, x + 3, 7, 1, 1, blink ? fg : bg)
    pixel(ctx, x + 2, 6, 3, 1, fg)
    pixel(ctx, x + 1, 5, 5, 1, fg)
    pixel(ctx, x, 4, 7, 1, fg)
    pixel(ctx, x + 3, 9, 1, 1, fg)
  }

  drawMic(ctx, fg, bg, listening, now) {
    const x = 121
    const pulse = !listening || Math.floor(now / 250) % 2 === 0
    pixel(ctx, x + 2, 2, 3, 5, pulse ? fg : bg)
    pixel(ctx, x + 1, 6, 1, 2, fg)
    pixel(ctx, x + 5, 6, 1, 2, fg)
    pixel(ctx, x + 2, 8, 3, 1, fg)
    pixel(ctx, x + 3, 9, 1, 2, fg)
    pixel(ctx, x + 1, 11, 5, 1, fg)
  }

  drawCatIcon(ctx, fg, bg, now) {
    // Transparent idle badge: just Snowy's cat face.
    pixel(ctx, 53, 34, 12, 10, fg); pixel(ctx, 95, 34, 12, 10, fg)
    pixel(ctx, 58, 29, 10, 9, fg); pixel(ctx, 92, 29, 10, 9, fg)
    pixel(ctx, 58, 33, 44, 34, fg)
    const blink = Math.floor(now / 600) % 8 === 0
    pixel(ctx, 67, 43, 7, blink ? 2 : 7, bg); pixel(ctx, 86, 43, 7, blink ? 2 : 7, bg)
    pixel(ctx, 78, 54, 4, 3, bg)
    pixel(ctx, 76, 58, 3, 2, bg); pixel(ctx, 81, 58, 3, 2, bg)
    pixel(ctx, 48, 52, 13, 1, fg); pixel(ctx, 48, 57, 13, 1, fg)
    pixel(ctx, 99, 52, 13, 1, fg); pixel(ctx, 99, 57, 13, 1, fg)
  }

  drawAvatar(ctx, fg, bg, state, now) {
    const blink = state === 'IDLE' && now % 4300 > 4070
    const bob = state === 'IDLE' ? (Math.floor(now / 650) % 2) : 0
    const glance = state === 'IDLE' && Math.floor(now / 9000) % 2 === 1 ? 2 : 0
    const y = 28 + bob
    const leftX = 43 + glance
    const rightX = 95 + glance

    if (state === 'LISTENING') {
      for (let i = 0; i < 5; i += 1) {
        const h = 3 + ((Math.floor(now / 110 + i * 3) % 4) * 2)
        pixel(ctx, 22 + i * 3, 46 - h, 2, h, fg)
        pixel(ctx, 124 + i * 3, 46 - h, 2, h, fg)
      }
    }
    if (state === 'THINKING') {
      const dots = Math.floor(now / 180) % 8
      for (let i = 0; i < 8; i += 1) {
        const a = (i + dots) % 8
        pixel(ctx, 77 + (i % 3) * 3, 50 + Math.floor(i / 3) * 3, 1, 1, a < 3 ? fg : bg)
      }
    }
    if (['HAPPY', 'EXCITED', 'LOVE', 'LAUGHING'].includes(state)) {
      if (state === 'LAUGHING') {
        pixel(ctx, leftX + 2, y + 9, 8, 2, fg); pixel(ctx, leftX + 10, y + 5, 8, 2, fg); pixel(ctx, leftX + 18, y + 9, 4, 2, fg)
        pixel(ctx, rightX + 2, y + 9, 4, 2, fg); pixel(ctx, rightX + 6, y + 5, 8, 2, fg); pixel(ctx, rightX + 14, y + 9, 8, 2, fg)
      } else {
        // Stepped ^ ^ eyes, with occasional floating spark pixels.
        for (const ex of [leftX, rightX]) {
          pixel(ctx, ex, y + 7, 4, 2, fg); pixel(ctx, ex + 4, y + 3, 4, 2, fg); pixel(ctx, ex + 8, y, 6, 2, fg); pixel(ctx, ex + 14, y + 3, 4, 2, fg); pixel(ctx, ex + 18, y + 7, 4, 2, fg)
        }
      }
      if (Math.floor(now / 450) % 2 === 0 && state !== 'LAUGHING') {
        if (state === 'LOVE') {
          pixel(ctx, 45, 28, 2, 2, fg); pixel(ctx, 49, 28, 2, 2, fg); pixel(ctx, 46, 30, 4, 2, fg); pixel(ctx, 47, 32, 2, 1, fg)
          pixel(ctx, 116, 35, 2, 2, fg); pixel(ctx, 120, 35, 2, 2, fg); pixel(ctx, 117, 37, 4, 2, fg); pixel(ctx, 118, 39, 2, 1, fg)
        } else {
          pixel(ctx, 43, 27, 2, 2, fg); pixel(ctx, 118, 34, 2, 2, fg); pixel(ctx, 73, 21, 2, 2, fg)
        }
      }
    } else if (state === 'SLEEPING' || state === 'SLEEPY') {
      pixel(ctx, leftX, y + 8, 22, 3, fg); pixel(ctx, rightX, y + 8, 22, 3, fg)
      const z = ['Z', 'Z Z', 'Z Z Z'][Math.floor(now / 800) % 3]
      drawText(ctx, z, 111, 21, fg)
    } else if (state === 'ANGRY') {
      pixel(ctx, leftX, y + 1, 22, 4, fg); pixel(ctx, leftX + 3, y + 5, 17, 11, fg)
      pixel(ctx, rightX + 5, y + 1, 17, 4, fg); pixel(ctx, rightX, y + 5, 19, 11, fg)
    } else if (state === 'SURPRISED') {
      pixel(ctx, leftX + 3, y - 2, 16, 22, fg); pixel(ctx, rightX + 3, y - 2, 16, 22, fg)
      pixel(ctx, leftX + 8, y + 3, 6, 12, bg); pixel(ctx, rightX + 8, y + 3, 6, 12, bg)
    } else if (state === 'SAD' || state === 'WORRIED') {
      pixel(ctx, leftX, y + 7, 22, 9, fg); pixel(ctx, leftX + 3, y + 4, 16, 3, fg); pixel(ctx, rightX, y + 7, 22, 9, fg); pixel(ctx, rightX + 3, y + 4, 16, 3, fg)
      if (state === 'SAD' && Math.floor(now / 350) % 2 === 0) pixel(ctx, leftX + 8, y + 17, 3, 4, fg)
    } else if (state === 'BASHFUL') {
      pixel(ctx, leftX + 2, y + 11, 18, 3, fg); pixel(ctx, rightX + 2, y + 11, 18, 3, fg)
      pixel(ctx, leftX + 9, y + 11, 5, 3, bg); pixel(ctx, rightX + 9, y + 11, 5, 3, bg)
      pixel(ctx, 58, 51, 8, 2, fg); pixel(ctx, 94, 51, 8, 2, fg)
    } else if (state === 'SKEPTICAL') {
      pixel(ctx, leftX, y + 5, 22, 13, fg); pixel(ctx, rightX + 2, y + 10, 18, 4, fg)
      pixel(ctx, leftX + 7, y + 9, 7, 7, bg); pixel(ctx, rightX + 8, y + 10, 5, 2, bg)
      pixel(ctx, leftX + 3, y + 1, 19, 3, fg)
    } else if (state === 'WINK') {
      pixel(ctx, leftX, y + 8, 22, 3, fg); pixel(ctx, rightX, y + 2, 22, 17, fg)
    } else if (state === 'CURIOUS' || state === 'CONFUSED') {
      pixel(ctx, leftX, y + 6, 22, 16, fg); pixel(ctx, rightX + 3, y + 2, 16, 16, fg)
      if (state === 'CONFUSED') drawText(ctx, '?', 116, 24, fg)
    } else if (state === 'CALM') {
      pixel(ctx, leftX, y + 8, 22, 7, fg); pixel(ctx, rightX, y + 8, 22, 7, fg)
    } else if (!['HAPPY', 'SLEEPING'].includes(state)) {
      const eyeH = state === 'THINKING' ? 11 : state === 'LISTENING' ? 22 : 18
      const eyeY = state === 'THINKING' ? y + 4 : state === 'LISTENING' ? y - 3 : y
      if (blink) {
        pixel(ctx, leftX, eyeY + 8, 22, 3, fg); pixel(ctx, rightX, eyeY + 8, 22, 3, fg)
      } else {
        pixel(ctx, leftX, eyeY, 22, eyeH, fg); pixel(ctx, rightX, eyeY, 22, eyeH, fg)
        const pupilOffset = state === 'IDLE' ? 6 : 7
        pixel(ctx, leftX + pupilOffset, eyeY + 5, 6, 8, bg); pixel(ctx, rightX + pupilOffset, eyeY + 5, 6, 8, bg)
      }
    }

    if (['HAPPY', 'LOVE'].includes(state)) {
      pixel(ctx, 69, 48, 6, 3, fg); pixel(ctx, 75, 51, 10, 3, fg); pixel(ctx, 85, 48, 6, 3, fg)
    } else if (state === 'LAUGHING') {
      pixel(ctx, 71, 47, 5, 3, fg); pixel(ctx, 76, 50, 9, 6, fg); pixel(ctx, 85, 47, 5, 3, fg)
      pixel(ctx, 76, 50, 9, 2, bg); pixel(ctx, 77, 54, 7, 2, bg)
    } else if (state === 'BASHFUL') {
      pixel(ctx, 76, 50, 8, 3, fg)
    } else if (state === 'SKEPTICAL') {
      pixel(ctx, 75, 51, 10, 2, fg); pixel(ctx, 85, 49, 3, 2, fg)
    } else if (state === 'EXCITED') {
      pixel(ctx, 73, 47, 14, 9, fg); pixel(ctx, 77, 50, 7, 4, bg)
    } else if (state === 'SURPRISED') {
      pixel(ctx, 76, 46, 8, 2, fg); pixel(ctx, 74, 48, 2, 7, fg); pixel(ctx, 84, 48, 2, 7, fg); pixel(ctx, 76, 55, 8, 2, fg); pixel(ctx, 78, 50, 5, 4, bg)
    } else if (state === 'ANGRY') {
      pixel(ctx, 70, 52, 6, 3, fg); pixel(ctx, 76, 49, 9, 3, fg); pixel(ctx, 85, 52, 6, 3, fg)
    } else if (['SAD', 'WORRIED'].includes(state)) {
      pixel(ctx, 72, 52, 5, 3, fg); pixel(ctx, 77, 49, 8, 3, fg); pixel(ctx, 85, 52, 5, 3, fg)
    } else if (state === 'CONFUSED') {
      pixel(ctx, 72, 52, 6, 3, fg); pixel(ctx, 78, 50, 6, 3, fg); pixel(ctx, 84, 47, 7, 3, fg)
    } else if (state === 'SPEAKING') {
      const mouthWidth = [10, 21, 15][Math.floor(now / 120) % 3]
      const mouthHeight = [3, 9, 6][Math.floor(now / 120) % 3]
      pixel(ctx, 80 - Math.floor(mouthWidth / 2), 51 - Math.floor(mouthHeight / 2), mouthWidth, mouthHeight, fg)
    } else {
      const mouthWidth = ['SLEEPING', 'SLEEPY'].includes(state) ? 7 : 16
      pixel(ctx, 80 - Math.floor(mouthWidth / 2), 51, mouthWidth, state === 'SLEEPING' || state === 'SLEEPY' ? 2 : 3, fg)
    }
  }

  destroy() {
    this.running = false
    window.clearTimeout(this.timer)
    if (this.request !== null) cancelAnimationFrame(this.request)
  }
}

