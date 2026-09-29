import type { SweepSession } from './sweep'

// Ownership starts before key derivation, so cancel/lock also reaches a key
// created after cancellation. An old dialog cannot dispose a newer scan.
export class SweepSlot {
  private generation = 0
  private owner: string | null = null
  private pending = false
  session: SweepSession | null = null

  dispose(owner?: string): void {
    if (owner !== undefined && owner !== this.owner) return
    this.generation++
    this.session?.dispose()
    this.session = null
    this.owner = null
    this.pending = false
  }
  cancelPending(owner: string): void { if (this.pending) this.dispose(owner) }
  disposeSession(session: SweepSession): void { if (this.session === session) this.dispose() }
  async scan(owner: string, create: () => Promise<SweepSession>): Promise<{ address: string; balanceAtomic: string }> {
    this.dispose()
    this.owner = owner
    this.pending = true
    const generation = this.generation
    let session: SweepSession | undefined
    try {
      session = await create()
      if (generation !== this.generation) throw new Error('Key scan cancelled. Start again.')
      this.session = session
      const balance = await session.scanBalance()
      if (generation !== this.generation) throw new Error('Key scan cancelled. Start again.')
      return { address: session.address, ...balance }
    } catch (error) {
      session?.dispose()
      if (this.session === session) { this.session = null; this.owner = null }
      throw error
    } finally { if (generation === this.generation) this.pending = false }
  }
}
