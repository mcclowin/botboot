import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class StageTimer {
  private marks = new Map<string, number>();
  private durations = new Map<string, number>();

  start(name: string) {
    this.marks.set(name, Date.now());
  }

  end(name: string) {
    const start = this.marks.get(name);
    if (start == null) return;
    this.durations.set(name, Date.now() - start);
  }

  set(name: string, ms: number) {
    this.durations.set(name, ms);
  }

  summary() {
    return Object.fromEntries(this.durations.entries());
  }

  print(prefix = "⏱") {
    for (const [k, v] of this.durations.entries()) {
      console.log(`${prefix} ${k}: ${(v / 1000).toFixed(1)}s`);
    }
  }
}

export function appendTimingArtifact(record: Record<string, unknown>) {
  const outPath = resolve(process.cwd(), "test-artifacts/e2e-timings.jsonl");
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
}
