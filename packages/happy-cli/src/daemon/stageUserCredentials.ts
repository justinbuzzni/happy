/**
 * Stage a requesting user's Happy credentials in a per-spawn tmp directory so
 * the child CLI authenticates as that user instead of inheriting the daemon's
 * shared ~/.happy-dev/access.key. The directory layout mirrors the daemon's
 * happyHomeDir so the child's existing readCredentials() works unchanged.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as tmp from 'tmp'

export interface StagedUserCredentials {
  homeDir: string
}

export async function stageUserCredentials(
  happyToken: string,
  happySecret: string,
): Promise<StagedUserCredentials> {
  const userHomeDir = tmp.dirSync({ prefix: 'happy-session-' })
  await fs.mkdir(join(userHomeDir.name, 'logs'), { recursive: true })
  await fs.writeFile(
    join(userHomeDir.name, 'access.key'),
    JSON.stringify({ token: happyToken, secret: happySecret }, null, 2),
    { mode: 0o600 },
  )
  return { homeDir: userHomeDir.name }
}
