export type Revision = number
export type Tab = 'month' | 'all'
export type Lang = 'en' | 'fr' | 'de' | 'hy' | 'ar' | 'es' | 'pt'

declare module 'claude-code' {
  interface PluginState {
    'token-maxxing': { revision: Revision; tab: Tab; lang: Lang }
  }
}
