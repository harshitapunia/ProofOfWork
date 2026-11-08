import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES, suiteCaseIds, IMAGE_PATTERN, type Manifest } from "./manifest.js";
import { createSumV2Cases, SUM_V2_HARNESS, sumV2OutputPass, type RandomInt } from "./sum-v2.js";
import { VerificationError } from "./errors.js";

export interface Outcome { id: string; passed: boolean }
export interface Runner { run(source: Buffer, manifest: Manifest): Promise<Outcome[]> }
export interface CommandResult { code: number | null; stdout: string; stderr: string; timeout: boolean; overflow: boolean }
export type Command = (args: string[], timeout: number, outputLimit: number) => Promise<CommandResult>;
export const dockerCommand: Command = (args, timeout, limit) => new Promise((resolve, reject) => {
  const child = spawn("docker", args, { shell: false, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", size = 0, timedOut = false, overflow = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
  function collect(data: Buffer, isError: boolean) {
    size += data.length;
    if (size > limit) { overflow = true; child.kill("SIGKILL"); return; }
    if (isError) stderr += data.toString("utf8"); else stdout += data.toString("utf8");
  }
  child.stdout.on("data", data => collect(data, false));
  child.stderr.on("data", data => collect(data, true));
  child.on("error", () => { clearTimeout(timer); reject(new VerificationError("runner_unavailable")); });
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, timeout: timedOut, overflow }); });
});
const HARNESS = `import { sum } from "file:///work/solution.mjs";
const input = JSON.parse(process.argv[1]);
const result = await sum(input);
process.stdout.write(JSON.stringify(result));`;

// No student path, image option, environment, command, or mount is interpolated into a shell.
export function createArguments(name: string, directory: string, manifest: Manifest, input: readonly number[]): string[] {
  const r = manifest.runner;
  return ["create", "--pull=never", "--name", name, "--label=proofwork.verifier=true", "--network=none", "--user=65534:65534",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--cpus=" + r.cpus, "--memory=" + r.memoryMb + "m", "--memory-swap=" + r.memoryMb + "m",
    "--pids-limit=" + r.pids, "--ulimit=nofile=64:64", "--ipc=none", "--log-driver=none",
    "--mount", "type=bind,src=" + directory + ",dst=/work,readonly",
    "--entrypoint=node", r.image, "--input-type=module", "-e", manifest.task === "sum-v2" ? SUM_V2_HARNESS : HARNESS, JSON.stringify(input)];
}
export class DockerRunner implements Runner {
  constructor(private readonly trustedImage: string | undefined, private readonly command: Command = dockerCommand,
    private readonly random: RandomInt | undefined = undefined) {}
  async run(source: Buffer, manifest: Manifest): Promise<Outcome[]> {
    if (!this.trustedImage || !IMAGE_PATTERN.test(this.trustedImage) || this.trustedImage !== manifest.runner.image) throw new VerificationError("runner_unavailable");
    suiteCaseIds(manifest);
    const cases = manifest.task === "sum-v1" ? CASES : createSumV2Cases(this.random);
    let directory: string | undefined;
    try {
      const available = await this.command(["version", "--format", "{{.Server.Version}}"], 5_000, 4096);
      if (available.code !== 0 || available.timeout || available.overflow) throw new VerificationError("runner_unavailable");
      directory = await mkdtemp(join(tmpdir(), "proofwork-run-"));
      if (directory.includes(",")) throw new VerificationError("runner_failure");
      await chmod(directory, 0o711);
      await writeFile(join(directory, "solution.mjs"), source, { mode: 0o444 });
      const outcomes: Outcome[] = [];
      for (const test of cases) {
        const name = "proofwork-" + randomUUID();
        let containerId: string | undefined;
        let passed = false;
        try {
          // Creating a stopped container first prevents a timed-out creation
          // request from starting student code after cleanup has already run.
          const created = await this.command(createArguments(name, directory, manifest, test.input), 10_000, 4096);
          if (created.timeout || created.overflow || created.code !== 0 || created.stderr !== ""
              || !/^[0-9a-f]{64}$/.test(created.stdout.trim())) {
            throw new VerificationError("runner_failure");
          }
          containerId = created.stdout.trim();
          const result = await this.command(["start", "--attach", containerId], manifest.runner.timeoutMs, manifest.runner.outputBytes);
          if (result.timeout) throw new VerificationError("runner_timeout");
          if (result.overflow || result.code === null) throw new VerificationError("runner_failure");

          const inspected = await this.command(["inspect", "--format", "{{json .State}}", containerId], 5_000, 4096);
          if (inspected.timeout || inspected.overflow || inspected.code !== 0 || inspected.stderr !== "") {
            throw new VerificationError("runner_failure");
          }
          const state: unknown = JSON.parse(inspected.stdout);
          if (state === null || typeof state !== "object") throw new VerificationError("runner_failure");
          const exit = state as Record<string, unknown>;
          if (exit.Status !== "exited" || exit.Running !== false || exit.OOMKilled !== false
              || exit.Error !== "" || !Number.isInteger(exit.ExitCode)) {
            throw new VerificationError("runner_failure");
          }
          // Docker CLI success alone does not establish the container exit status.
          passed = manifest.task === "sum-v1"
            ? result.code === 0 && exit.ExitCode === 0 && result.stderr === "" && result.stdout === JSON.stringify(test.expected)
            : sumV2OutputPass(result.stdout, result.stderr, result.code, exit.ExitCode as number, test.expected);
        } finally {
          // Always remove the exact created container, even after CLI timeout.
          // A failed creation may leave a stopped container under its generated name.
          const cleanup = await this.command(["rm", "-f", containerId ?? name], 5_000, 4096);
          const absentAfterFailedCreation = !containerId && cleanup.code !== 0
            && cleanup.stderr.includes("No such container");
          if (cleanup.timeout || cleanup.overflow || (cleanup.code !== 0 && !absentAfterFailedCreation)) {
            throw new VerificationError("runner_failure");
          }
        }
        outcomes.push({ id: test.id, passed });
      }
      return outcomes;
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      throw new VerificationError("runner_failure");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
