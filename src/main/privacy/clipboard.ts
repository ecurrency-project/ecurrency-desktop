import type { Clipboard } from 'electron'

// Best effort for the current clipboard only. History, cloud copies and Linux
// PRIMARY are outside this operation. Do not await between comparison and clear.
export function clearImportedKeyClipboard(clipboard: Pick<Clipboard, 'readText' | 'writeText'>, wif: string): void {
  try {
    if (wif.trim() !== '' && clipboard.readText().trim() === wif.trim()) clipboard.writeText('')
  } catch { /* Clipboard availability must not turn a successful import into an error. */ }
}
