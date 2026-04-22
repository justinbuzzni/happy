import { describe, it, expect } from 'vitest'
import { tokenizeCommand } from './tokenizeCommand'

// Mirror of packages/web-ui/server/tokenizeCommand.test.ts in the aplus-dev-studio
// outer repo. Kept in sync so the daemon-side /start-server route accepts
// the exact same command shapes the web-ui already accepts.

describe('tokenizeCommand (daemon)', () => {
  it('splits "node server.js" into ["node", "server.js"]', () => {
    expect(tokenizeCommand('node server.js')).toEqual(['node', 'server.js'])
  })

  it('splits "python main.py" into ["python", "main.py"]', () => {
    expect(tokenizeCommand('python main.py')).toEqual(['python', 'main.py'])
  })

  it('splits "npx next dev" into three tokens', () => {
    expect(tokenizeCommand('npx next dev')).toEqual(['npx', 'next', 'dev'])
  })

  it('trims leading/trailing whitespace', () => {
    expect(tokenizeCommand('  node server.js  ')).toEqual(['node', 'server.js'])
  })

  it('collapses runs of internal whitespace', () => {
    expect(tokenizeCommand('node   server.js')).toEqual(['node', 'server.js'])
  })

  it('throws on empty or whitespace-only input', () => {
    expect(() => tokenizeCommand('')).toThrow()
    expect(() => tokenizeCommand('   ')).toThrow()
  })

  it('throws when the input contains a shell metacharacter we do not handle', () => {
    expect(() => tokenizeCommand('node server.js && echo hi')).toThrow()
    expect(() => tokenizeCommand('node server.js | tee out.log')).toThrow()
    expect(() => tokenizeCommand('FOO=1 node server.js')).toThrow()
  })
})
