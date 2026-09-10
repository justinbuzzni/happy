import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { readManagedStartup } from '@/managed/managedStartup'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'

export async function handleCodexCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let permissionMode: PermissionMode | undefined = undefined
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

  for (let i = 0; i < codexArgs.args.length; i++) {
    if (codexArgs.args[i] === '--started-by') {
      startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
    } else if (codexArgs.args[i] === '--permission-mode') {
      permissionMode = codexArgs.args[++i] as PermissionMode
    } else if (codexArgs.args[i] === '--yolo') {
      permissionMode = 'yolo'
    }
  }

  // See main.ts: a managed Cloud spawn skips account auth, machine
  // registration and the daemon entirely.
  const managed = await readManagedStartup(process.env, Date.now())
  if (managed) {
    await runCodex({
      principal: { kind: 'managed', startup: managed },
      startedBy,
      noSandbox: sandboxArgs.noSandbox,
      resumeThreadId: codexArgs.resumeThreadId ?? undefined,
      permissionMode,
    })
    return
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    principal: { kind: 'account', credentials },
    startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    permissionMode,
  })
}
