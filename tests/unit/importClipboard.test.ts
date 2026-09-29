import { describe, expect, it, vi } from 'vitest'
import { clearImportedKeyClipboard } from '../../src/main/privacy/clipboard'

describe('imported key clipboard cleanup', () => {
  it('clears only the still-matching current clipboard', () => {
    const clipboard = { readText: vi.fn(() => ' public-test-key\n'), writeText: vi.fn() }
    clearImportedKeyClipboard(clipboard, 'public-test-key')
    expect(clipboard.writeText).toHaveBeenCalledWith('')
    clipboard.writeText.mockClear()
    clipboard.readText.mockReturnValue('new-public-copy')
    clearImportedKeyClipboard(clipboard, 'public-test-key')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
  it('clipboard failure does not fail the import', () => {
    expect(() => clearImportedKeyClipboard({ readText: () => { throw new Error('Unavailable') }, writeText: vi.fn() }, 'key')).not.toThrow()
  })
})
