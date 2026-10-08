import { spawn } from "node:child_process";

export const PROCESS_OUTPUT_LIMIT = 1_048_576;
export const PROCESS_INPUT_LIMIT = 1_048_576;
const INHERITED_PIPE_DRAIN_MS = 1_000;

export type ProcessFailure = "aborted" | "timeout" | "output_limit" | "drain_timeout" | "spawn_error" | "input_limit" | "invalid_timeout" | "stdin_error";

export interface ProcessRunResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  failure?: ProcessFailure;
  spawnCode?: string;
  stdinClosedEarly?: boolean;
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

const empty = (failure: ProcessFailure): ProcessRunResult => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  code: null,
  failure,
});

export async function runProcess(argv: readonly string[], options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (options.signal?.aborted) return empty("aborted");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
    return empty("invalid_timeout");
  }
  if (options.input !== undefined && Buffer.byteLength(options.input) > PROCESS_INPUT_LIMIT) {
    return empty("input_limit");
  }
  if (argv.length === 0 || argv.some((arg) => typeof arg !== "string")) return empty("spawn_error");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return empty("spawn_error");
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let captured = 0;
  let failure: ProcessFailure | undefined;
  let spawnCode: string | undefined;
  let stdinClosedEarly = false;
  let leaderExited = false;
  let closed = false;
  let stdinClosed = options.input === undefined;
  let stdoutEnded = false;
  let stderrEnded = false;
  let leaderExitCode: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let drainTimeout: ReturnType<typeof setTimeout> | undefined;

  const killOwnedProcessGroup = () => {
    if (leaderExited || child.pid === undefined) return;
    if (process.platform === "win32") {
      try { child.kill("SIGKILL"); } catch { /* the child already exited */ }
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try { child.kill("SIGKILL"); } catch { /* the child already exited */ }
      }
    }
  };

  const stop = (reason: ProcessFailure) => {
    failure ??= reason;
    killOwnedProcessGroup();
  };

  const capture = (target: Buffer[], chunk: Buffer) => {
    if (failure === "aborted" || failure === "timeout" || failure === "output_limit" || failure === "drain_timeout") return;
    const available = PROCESS_OUTPUT_LIMIT - captured;
    const keep = Math.min(available, chunk.length);
    if (keep > 0) {
      target.push(Buffer.from(chunk.subarray(0, keep)));
      captured += keep;
    }
    if (keep < chunk.length) stop("output_limit");
  };

  return await new Promise<ProcessRunResult>((resolve) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (drainTimeout) clearTimeout(drainTimeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (code: number | null) => {
      if (closed) return;
      closed = true;
      cleanup();
      if (!failure && options.signal?.aborted) failure = "aborted";
      resolve({
        stdout: Buffer.concat(stdout, stdout.reduce((sum, part) => sum + part.length, 0)),
        stderr: Buffer.concat(stderr, stderr.reduce((sum, part) => sum + part.length, 0)),
        code,
        ...(failure ? { failure } : {}),
        ...(spawnCode ? { spawnCode } : {}),
        ...(stdinClosedEarly ? { stdinClosedEarly } : {}),
      });
    };

    const onAbort = () => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdout?.once("end", () => { stdoutEnded = true; });
    child.stderr?.once("end", () => { stderrEnded = true; });
    child.stdin?.once("close", () => { stdinClosed = true; });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") {
        stdinClosedEarly = true;
      } else {
        stop("stdin_error");
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure ??= "spawn_error";
      spawnCode = error.code;
      if (child.pid === undefined) finish(null);
    });
    child.once("exit", (code) => {
      leaderExited = true;
      leaderExitCode = code;
      if (timeout) clearTimeout(timeout);
      if (child.stdin) {
        if (!child.stdin.writableFinished) stdinClosedEarly = true;
        child.stdin.destroy();
      }
      if ((!stdinClosed || !stdoutEnded || !stderrEnded) && !closed) {
        drainTimeout = setTimeout(() => {
          if (closed) return;
          failure ??= "drain_timeout";
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(leaderExitCode);
        }, INHERITED_PIPE_DRAIN_MS);
      }
    });
    child.once("close", (code) => finish(code));

    timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    if (options.input !== undefined && child.stdin) {
      try {
        child.stdin.end(options.input);
      } catch {
        stop("stdin_error");
      }
    }
    if (options.signal?.aborted) onAbort();
  });
}
