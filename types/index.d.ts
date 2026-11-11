/** Okno limitu předplatného, které je nejblíž vyčerpání. */
export type LimitInfo = {
  kind: string
  pct: number
  /** Kdy se okno obnoví, ms od epochy; null když to API neřeklo. */
  resetsAt: number | null
  /** Délka okna v ms (5 h, 7 dní…); null když není známá. */
  windowMs: number | null
}

/** Složka, na kterou se dá kliknout. */
export type Folder = { label: string; path: string }

/** Co řádek ukazuje; obnovuje se po každém tahu a každých 30 s. */
export type Snapshot = {
  model: string
  contextPct: number | null
  limit: LimitInfo | null
  isSubscriber: boolean
  project: Folder
  worktree: string | null
  /** Odkládací složka Clauda, jen když v ní něco je. */
  scratch: (Folder & { count: number }) | null
}

/** Poslední odpověď, která četla nebo zapisovala do mezipaměti. */
export type CacheMark = { at: number; ttlMs: number; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'stavovy-radek': {
      snap: Shaped<Snapshot | null>
      cache: Shaped<CacheMark | null>
      tick: number
      folder: Shaped<Folder | null>
      /** Kreslit pruh i v terminálu (chybí Node.js pro statusline.cjs). */
      terminalBand: boolean
    }
  }
}
