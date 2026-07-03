// Copy sensitive text (a recovery phrase) to the clipboard, then wipe it.
//
// The OS clipboard is shared: other apps and clipboard-history managers can read
// it. So we don't leave the seed sitting there — after a short window we overwrite
// it, but ONLY if it still holds exactly what we wrote, so we never clobber
// something the user copied in the meantime. Best-effort: a read failure (e.g. the
// window lost focus) just skips the wipe. Plain, non-secret copies (addresses,
// txids) don't use this.

interface ClipboardLike {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

export const CLIPBOARD_CLEAR_MS = 60_000

export async function copyWithAutoClear(
  text: string,
  opts: { clearAfterMs?: number; clipboard?: ClipboardLike } = {},
): Promise<void> {
  const clip = opts.clipboard ?? navigator.clipboard
  const clearAfterMs = opts.clearAfterMs ?? CLIPBOARD_CLEAR_MS
  await clip.writeText(text)
  setTimeout(() => {
    void clip
      .readText()
      .then((current) => {
        if (current === text) void clip.writeText('')
      })
      .catch(() => {})
  }, clearAfterMs)
}
