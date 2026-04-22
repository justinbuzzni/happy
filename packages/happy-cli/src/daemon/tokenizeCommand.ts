// Shell-less command tokenizer for the daemon's /start-server route. Kept
// byte-compatible with packages/web-ui/server/tokenizeCommand.ts so the
// local and remote spawn paths accept the same inputs. See
// specs/start-server-process-tracking/ Phase 1 for the rationale and
// specs/remote-server-start/ Phase 3 for why it lives here as well.

const SHELL_META = /[&|;<>()`$"'\\]|=(?=[^\s=]*\s)/

export function tokenizeCommand(command: string): [string, ...string[]] {
  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error('tokenizeCommand: empty command')
  }
  if (SHELL_META.test(trimmed)) {
    throw new Error(`tokenizeCommand: shell metacharacter in "${command}"`)
  }
  const parts = trimmed.split(/\s+/)
  return [parts[0], ...parts.slice(1)]
}
