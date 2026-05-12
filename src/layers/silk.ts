import { generateResponse } from '../chat'
import type { PeekResult } from './peek'
import type { MeshResult } from './mesh'
import type { Session } from '../types'

export type SilkResult = {
  response: string
  ms: number
}

export async function runSilkLayer(
  message: string,
  peek: PeekResult,
  mesh: MeshResult,
  session: Session
): Promise<SilkResult> {
  const t0 = Date.now()

  const response = await generateResponse(
    message,
    mesh.memories.map(m => m.content),
    session.history
  )

  return { response, ms: Date.now() - t0 }
}
