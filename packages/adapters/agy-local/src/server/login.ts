import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { agySignInFile } from "./accounts.js";

/**
 * Interactive AGY sign-in for one account HOME, driven without a user terminal.
 *
 * AGY signs in through a terminal UI: it asks for a login method, prints a
 * Google OAuth URL, and then waits for the authorization code that
 * https://antigravity.google/oauth-callback shows after sign-in. Node has no
 * PTY API, so a Python standard-library bridge supplies the terminal. The
 * terminal is very wide so AGY prints the URL on one line.
 *
 * AGY output can contain the OAuth URL and code. It is parsed in memory and
 * never logged.
 */
export const AGY_LOGIN_PTY_BRIDGE = String.raw`
import errno, fcntl, os, pty, select, signal, struct, sys, termios
pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 4000, 0, 0))
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(_signal, _frame):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if data: os.write(master, data)
        else: stop(None, None)
    if master in readable:
        try: data = os.read(master, 4096)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not data: break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export const AGY_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_BUFFER_LIMIT = 256 * 1024;
const SIGN_IN_POLL_MS = 1000;

/** Removes terminal control sequences from AGY's terminal UI output. */
export function stripAgyTerminalOutput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n");
}

export function agyLoginAsksForMethod(cleanOutput: string): boolean {
  return /select\s+login\s+method/i.test(cleanOutput);
}

export function extractAgyAuthorizationUrl(cleanOutput: string): string | null {
  const match = cleanOutput.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/);
  return match ? match[0] : null;
}

export function agyLoginAsksForCode(cleanOutput: string): boolean {
  return /paste\s+the\s+authorization\s+code/i.test(cleanOutput);
}

const AGY_LOGIN_FAILURE_RE =
  /(?:invalid|expired|malformed)[^\n]{0,40}(?:code|grant|token)|authentication\s+failed|sign-?in\s+failed|failed\s+to\s+(?:exchange|authenticate|sign\s+in)/i;

export function agyLoginReportsFailure(cleanOutput: string): boolean {
  return AGY_LOGIN_FAILURE_RE.test(cleanOutput);
}

export type AgyLoginOutcome =
  | { outcome: "signed_in" }
  | { outcome: "failed"; error: string }
  | { outcome: "cancelled" };

export interface AgyLoginHandle {
  submitCode(code: string): void;
  cancel(): void;
  readonly done: Promise<AgyLoginOutcome>;
}

export interface AgyLoginProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: { write(data: string): unknown };
  kill(signal?: NodeJS.Signals): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

export interface StartAgyLoginOptions {
  home: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onAuthorizationUrl: (url: string) => void;
  onCodeSubmitted?: () => void;
  /** Test seam: starts the bridge process. */
  spawnBridge?: (command: string, env: NodeJS.ProcessEnv) => AgyLoginProcess;
  /** Test seam: reports whether the sign-in file exists. */
  signInExists?: (home: string) => Promise<boolean>;
}

function defaultSpawnBridge(command: string, env: NodeJS.ProcessEnv): AgyLoginProcess {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-u", "-c", AGY_LOGIN_PTY_BRIDGE, command], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

function defaultSignInExists(home: string): Promise<boolean> {
  return fs.access(agySignInFile(home)).then(
    () => true,
    () => false,
  );
}

export function startAgyLogin(options: StartAgyLoginOptions): AgyLoginHandle {
  const spawnBridge = options.spawnBridge ?? defaultSpawnBridge;
  const signInExists = options.signInExists ?? defaultSignInExists;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    HOME: options.home,
    TERM: "xterm-256color",
    // Keep AGY from launching a browser on the server host.
    BROWSER: "true",
  };

  let settle: (outcome: AgyLoginOutcome) => void = () => {};
  const done = new Promise<AgyLoginOutcome>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  let output = "";
  let outputAfterCode = "";
  let methodSelected = false;
  let urlReported = false;
  let codeSubmitted = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let child: AgyLoginProcess | null = null;

  const finish = (outcome: AgyLoginOutcome) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    if (pollTimer) clearInterval(pollTimer);
    child?.kill("SIGTERM");
    settle(outcome);
  };

  const timeoutTimer = setTimeout(
    () => finish({ outcome: "failed", error: "The AGY sign-in timed out. Start it again." }),
    options.timeoutMs ?? AGY_LOGIN_TIMEOUT_MS,
  );

  const checkSignedIn = async () => {
    if (finished) return;
    if (await signInExists(options.home)) finish({ outcome: "signed_in" });
  };

  try {
    child = spawnBridge(options.command ?? "agy", env);
  } catch {
    finish({ outcome: "failed", error: "AGY sign-in requires Python 3 and the agy CLI on the Paperclip host." });
    return { submitCode: () => {}, cancel: () => {}, done };
  }

  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer | string) => {
    if (finished) return;
    const text = stripAgyTerminalOutput(chunk.toString());
    output = (output + text).slice(-OUTPUT_BUFFER_LIMIT);
    if (codeSubmitted) {
      outputAfterCode = (outputAfterCode + text).slice(-OUTPUT_BUFFER_LIMIT);
      if (agyLoginReportsFailure(outputAfterCode)) {
        finish({ outcome: "failed", error: "AGY rejected the authorization code. Start the sign-in again." });
        return;
      }
    }
    if (!methodSelected && agyLoginAsksForMethod(output)) {
      methodSelected = true;
      // The first option is Google OAuth.
      child?.stdin.write("\r");
    }
    if (!urlReported) {
      const url = extractAgyAuthorizationUrl(output);
      if (url) {
        urlReported = true;
        options.onAuthorizationUrl(url);
      }
    }
  });
  child.once("error", () => {
    finish({ outcome: "failed", error: "AGY sign-in requires Python 3 and the agy CLI on the Paperclip host." });
  });
  child.once("close", () => {
    void (async () => {
      await checkSignedIn();
      finish({ outcome: "failed", error: "AGY exited before the sign-in finished. Start it again." });
    })();
  });

  return {
    submitCode(code: string) {
      if (finished || !urlReported || codeSubmitted) return;
      const clean = code.replace(/[\r\n]+/g, "").trim();
      if (!clean) return;
      codeSubmitted = true;
      child?.stdin.write(clean);
      child?.stdin.write("\r");
      options.onCodeSubmitted?.();
      pollTimer = setInterval(() => void checkSignedIn(), SIGN_IN_POLL_MS);
    },
    cancel() {
      finish({ outcome: "cancelled" });
    },
    done,
  };
}
