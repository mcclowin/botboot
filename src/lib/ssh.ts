/**
 * SSH utilities for managing agent VPSes.
 * Uses system ssh binary via child_process.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env.js";

const SSH_PRIVATE_KEY_PATH = (() => {
  const privateKey = process.env.HETZNER_SSH_PRIVATE_KEY;
  if (!privateKey) return env.HETZNER_SSH_KEY_PATH;

  const normalizedKey = privateKey.includes("\\n") && !privateKey.includes("\n")
    ? privateKey.replace(/\\n/g, "\n")
    : privateKey;

  const tempKeyPath = join(tmpdir(), `hetzner-ssh-key-${process.pid}`);
  writeFileSync(tempKeyPath, normalizedKey, { mode: 0o600 });
  return tempKeyPath;
})();

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "ConnectTimeout=10",
  "-o", "BatchMode=yes",
  "-o", "LogLevel=ERROR",
];

function sshArgs(ip: string, user = "agent"): string[] {
  const args = [...SSH_OPTS];
  if (SSH_PRIVATE_KEY_PATH) {
    args.push("-i", SSH_PRIVATE_KEY_PATH);
  }
  args.push(`${user}@${ip}`);
  return args;
}

export async function exec(
  ip: string,
  command: string,
  opts?: { user?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = [...sshArgs(ip, opts?.user), command];
    const timeout = opts?.timeoutMs || 30_000;

    execFile("ssh", args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
        reject(new Error(`SSH command timed out after ${timeout}ms`));
        return;
      }
      resolve({
        stdout: stdout?.toString() || "",
        stderr: stderr?.toString() || "",
        exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code || 1 : 0,
      });
    });
  });
}

export async function ping(ip: string, opts?: { user?: string; timeoutMs?: number }): Promise<boolean> {
  try {
    const result = await exec(ip, "echo ok", {
      user: opts?.user,
      timeoutMs: opts?.timeoutMs || 10_000,
    });
    return result.stdout.trim() === "ok";
  } catch {
    return false;
  }
}

export async function readFile(ip: string, path: string): Promise<string> {
  if (path.includes("..") || path.startsWith("/")) {
    throw new Error("Invalid file path");
  }
  // Runtime-agnostic: caller provides the full base path
  const result = await exec(ip, `cat ${JSON.stringify(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read ${path}: ${result.stderr}`);
  }
  return result.stdout;
}

export async function writeFile(ip: string, path: string, content: string): Promise<void> {
  if (path.includes("..")) {
    throw new Error("Invalid file path");
  }
  const dir = path.substring(0, path.lastIndexOf("/"));
  const b64 = Buffer.from(content).toString("base64");
  const cmd = `mkdir -p ${JSON.stringify(dir)} && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(path)}`;
  const result = await exec(ip, cmd);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to write ${path}: ${result.stderr}`);
  }
}

export async function backup(ip: string, basePath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `/tmp/backup-${timestamp}.tar.gz`;
  const result = await exec(
    ip,
    `tar czf ${backupPath} -C ${JSON.stringify(basePath)} . 2>/dev/null && echo ${backupPath}`,
    { timeoutMs: 60_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Backup failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
