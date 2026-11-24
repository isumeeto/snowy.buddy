export {}

declare global {
  interface Window {
    companion: {
      close: () => Promise<void>
      getApiKey: () => Promise<string>
      createSessionToken: () => Promise<string>
      setCompact: (compact: boolean) => Promise<boolean>
      setPetHover: (hovered: boolean) => void
      addTodo: (text: string) => Promise<{ added: boolean; item?: { id: string; text: string; completed: boolean } }>
      listTodos: (includeCompleted: boolean) => Promise<{ items: Array<{ id: string; text: string; completed: boolean; createdAt: string; completedAt: string | null }>; total: number; truncated: boolean }>
      completeTodo: (query: string) => Promise<{ completed: boolean; item?: { id: string; text: string; completed: boolean } }>
      removeTodo: (query: string) => Promise<{ removed: boolean; item?: { id: string; text: string; completed: boolean } }>
      inspectAccessibility: (windowHint: string) => Promise<{ windows: Array<{ name: string; controls: Array<{ name: string; type: string; automationId: string; bounds: { x: number; y: number; width: number; height: number }; patterns: string[] }> }> }>
      typeText: (text: string, windowHint: string, controlName: string, controlType: string, recipient?: string) => Promise<{ typedCharacters: number; verified: boolean; window: string; field: string; recipientVerified?: boolean; screenshotFresh?: boolean }>
      webResearch: (query: string) => Promise<{ answer?: string; researchId?: string; sources?: Array<{ title: string; url: string }>; provider?: string; error?: string }>
      saveResearchReport: (researchId: string, title: string) => Promise<{ saved: boolean; path: string; title: string; format: 'HTML' }>
      setWhatsAppNotificationReading: (enabled: boolean) => Promise<{ enabled: boolean; source: string; opensChat: false }>
      onWhatsAppNotification: (callback: (data: { sender: string; message: string }) => void) => () => void
      chooseFileFolder: () => Promise<{ cancelled?: boolean; approved?: boolean; folderId?: string; name?: string }>
      listApprovedFolders: () => Promise<Array<{ id: string; name: string }>>
      listLocalFiles: (folderId: string) => Promise<{ folder: string; files: Array<{ name: string; relativePath: string; size: number }>; truncated: boolean }>
      searchLocalFiles: (folderId: string, query: string) => Promise<{ folder: string; files: Array<{ name: string; relativePath: string; size: number }>; truncated: boolean }>
      previewFileOrganization: (folderId: string) => Promise<{ previewId?: string; folder: string; moves: Array<{ name: string; from: string; to: string }>; totalMoves: number; blocked?: boolean; protectedSkipped?: number; message: string }>
      applyFileOrganization: (previewId: string) => Promise<{ applied: boolean; cancelled?: boolean; moved?: Array<{ name: string; to: string }>; skipped?: Array<{ name: string; reason: string }>; totalMoved?: number; message?: string }>
      prepareDownloadsOrganization: () => Promise<{ previewId?: string; folderId: string; folder: string; moves: Array<{ name: string; from: string; to: string }>; totalMoves: number; blocked?: boolean; explorerOpened: boolean; explorerError?: string; message: string }>
      createDailyAutomation: (time: string, query: string) => Promise<{ created: boolean; id: string; kind: string; time: string; query: string; nextRunAt: string; timezone: string }>
      listAutomations: () => Promise<Array<{ id: string; kind: string; time: string; query: string }>>
      cancelAutomation: (query: string) => Promise<{ cancelled: string; time: string }>
      onSystemOverload: (callback: (data: { overloaded: boolean; usage: number }) => void) => () => void
      onAutomationDue: (callback: (data: { message: string; automationId: string; sources: Array<{ title: string; url: string }> }) => void) => () => void
    }
  }
}
