import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyWithAutoClear } from '../../src/renderer/lib/clipboard'

function fakeClipboard(initial = '') {
  const state = { value: initial }
  return {
    state,
    writeText: async (t: string): Promise<void> => {
      state.value = t
    },
    readText: async (): Promise<string> => state.value,
  }
}

describe('copyWithAutoClear', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes immediately and wipes after the delay when still ours', async () => {
    const clip = fakeClipboard()
    await copyWithAutoClear('seed words', { clearAfterMs: 1000, clipboard: clip })
    expect(clip.state.value).toBe('seed words')
    await vi.advanceTimersByTimeAsync(1000)
    expect(clip.state.value).toBe('')
  })

  it('does NOT wipe if the clipboard changed in the meantime', async () => {
    const clip = fakeClipboard()
    await copyWithAutoClear('seed words', { clearAfterMs: 1000, clipboard: clip })
    clip.state.value = 'something the user copied'
    await vi.advanceTimersByTimeAsync(1000)
    expect(clip.state.value).toBe('something the user copied')
  })
})
