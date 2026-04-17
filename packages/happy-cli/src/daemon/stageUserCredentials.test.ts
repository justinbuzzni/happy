import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { stageUserCredentials } from './stageUserCredentials'

describe('stageUserCredentials', () => {
  it('writes an access.key file containing the user token and secret', async () => {
    const { homeDir } = await stageUserCredentials('user-token-abc', 'base64secret==')
    try {
      const accessKey = await fs.readFile(join(homeDir, 'access.key'), 'utf-8')
      expect(JSON.parse(accessKey)).toEqual({
        token: 'user-token-abc',
        secret: 'base64secret==',
      })
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('creates a logs subdirectory so the child CLI can write logs', async () => {
    const { homeDir } = await stageUserCredentials('t', 's')
    try {
      const stat = await fs.stat(join(homeDir, 'logs'))
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('returns a unique tmp directory for each call', async () => {
    const a = await stageUserCredentials('t', 's')
    const b = await stageUserCredentials('t', 's')
    try {
      expect(a.homeDir).not.toBe(b.homeDir)
    } finally {
      await fs.rm(a.homeDir, { recursive: true, force: true })
      await fs.rm(b.homeDir, { recursive: true, force: true })
    }
  })

  it('writes access.key with mode 0600 so only the owner can read', async () => {
    const { homeDir } = await stageUserCredentials('t', 's')
    try {
      const stat = await fs.stat(join(homeDir, 'access.key'))
      // Check that group/other have no read access
      const modeStr = (stat.mode & 0o777).toString(8)
      expect(modeStr).toBe('600')
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })
})
