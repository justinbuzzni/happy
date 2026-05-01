import { describe, it, expect, afterEach } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPtySession, type PtySession } from './remoteTerminal'

describe('createPtySession', () => {
    const sessions: PtySession[] = []

    afterEach(() => {
        while (sessions.length) {
            const s = sessions.pop()
            try { s?.kill('SIGKILL') } catch {/* gone */}
        }
    })

    function track<T extends PtySession>(s: T): T {
        sessions.push(s)
        return s
    }

    async function waitFor(check: () => boolean, ms: number): Promise<void> {
        const start = Date.now()
        while (Date.now() - start < ms) {
            if (check()) return
            await sleep(20)
        }
        throw new Error('waitFor timeout')
    }

    it('emits child stdout via onData', async () => {
        const s = track(createPtySession({
            userId: 'u1',
            shell: 'node',
            args: ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
        }))
        let buf = ''
        s.onData((chunk) => { buf += chunk })
        await waitFor(() => buf.includes('READY'), 3000)
        expect(buf).toContain('READY')
    })

    it('forwards input to the child via write()', async () => {
        const s = track(createPtySession({
            userId: 'u1',
            shell: 'node',
            args: ['-e', `
                process.stdin.setEncoding('utf8')
                let inbuf = ''
                process.stdin.on('data', (d) => {
                    inbuf += d
                    const i = inbuf.indexOf('\\n')
                    if (i >= 0) {
                        const line = inbuf.slice(0, i)
                        process.stdout.write('GOT[' + line + ']\\n')
                        inbuf = inbuf.slice(i + 1)
                    }
                })
            `],
        }))
        let buf = ''
        s.onData((chunk) => { buf += chunk })
        await sleep(150) // let stdin handler register
        s.write('PING\n')
        await waitFor(() => buf.includes('GOT[PING]'), 3000)
        expect(buf).toContain('GOT[PING]')
    })

    it('resize updates cols/rows on the session', async () => {
        const s = track(createPtySession({
            userId: 'u1',
            shell: 'node',
            args: ['-e', 'setInterval(() => {}, 1000)'],
            cols: 80,
            rows: 24,
        }))
        expect(s.cols).toBe(80)
        expect(s.rows).toBe(24)
        s.resize(120, 40)
        expect(s.cols).toBe(120)
        expect(s.rows).toBe(40)
    })

    it('reports natural exit via onExit with code', async () => {
        const s = track(createPtySession({
            userId: 'u1',
            shell: 'node',
            args: ['-e', 'process.exit(7)'],
        }))
        const exit = await new Promise<{ code: number; signal: number | null }>((res) => {
            s.onExit((code, signal) => res({ code, signal }))
        })
        expect(exit.code).toBe(7)
    })

    it('kill() sends signal to the entire process group (grandchild dies)', async () => {
        const s = track(createPtySession({
            userId: 'u1',
            shell: '/bin/bash',
            args: [
                '--noprofile',
                '--norc',
                '-c',
                // Print the PID of a backgrounded `sleep` so we can verify it
                // gets killed when we kill the shell. `wait` keeps bash alive
                // until we send the signal ourselves.
                'sleep 60 & echo PID=$! ; wait',
            ],
        }))
        let buf = ''
        s.onData((chunk) => { buf += chunk })
        await waitFor(() => /PID=(\d+)/.test(buf), 3000)
        const grandchildPid = Number.parseInt(buf.match(/PID=(\d+)/)![1], 10)
        expect(() => process.kill(grandchildPid, 0)).not.toThrow()

        s.kill('SIGTERM')
        await waitFor(() => {
            try { process.kill(grandchildPid, 0); return false }
            catch { return true }
        }, 3000)
        expect(() => process.kill(grandchildPid, 0)).toThrow()
    })

    it('exposes id (uuid) and userId fields', () => {
        const s = track(createPtySession({
            userId: 'alice',
            shell: 'node',
            args: ['-e', 'setInterval(() => {}, 1000)'],
        }))
        expect(s.userId).toBe('alice')
        expect(s.id).toMatch(/^[0-9a-f-]{36}$/i)
        expect(Number.isInteger(s.pid)).toBe(true)
    })
})
