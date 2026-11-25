export type Revision = number
export type Tab = 'month' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'token-maxxing': { revision: Revision; tab: Tab }
  }
}
