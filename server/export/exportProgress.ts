export type ExportProgressState = "success" | "failure" | "neutral";

export interface ExportProgressStep {
  weight: number;
}

export interface ExportProgressSink {
  setSteps(steps: readonly ExportProgressStep[]): void;
  status(message: string): void;
  statusProgress(message: string, completed: number, total: number): void;
  step(message: string, state?: ExportProgressState): void;
  suspend(): void;
  resume(): void;
  finish(): void;
}

export interface CliExportProgressOptions {
  interactive?: boolean | undefined;
  write?: ((text: string) => void) | undefined;
  heartbeatMs?: number | undefined;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const PROGRESS_WIDTH = 24;

function normalizeStep(step: ExportProgressStep): ExportProgressStep {
  return { weight: Math.max(0, Number.isFinite(step.weight) ? step.weight : 0) };
}

function markFor(state: ExportProgressState): string {
  if (state === "failure") {
    return "✗";
  }
  if (state === "neutral") {
    return "•";
  }
  return "✓";
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

export class CliExportProgress implements ExportProgressSink {
  readonly #interactive: boolean;
  readonly #write: (text: string) => void;
  readonly #heartbeatMs: number;
  #steps: ExportProgressStep[] = [{ weight: 1 }];
  #totalWeight = 1;
  #completedWeight = 0;
  #currentStep = 0;
  #stageProgress = 0;
  #statusLine = "";
  #itemCompleted: number | null = null;
  #itemTotal: number | null = null;
  #statusStartedAt = Date.now();
  #renderedInteractiveLine = false;
  #lastLoggedPercent: number | null = null;
  #lastLoggedMessage = "";
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #suspended = false;

  constructor(options: CliExportProgressOptions = {}) {
    this.#interactive = options.interactive ?? process.stderr.isTTY;
    this.#write = options.write ?? ((text) => process.stderr.write(text));
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (!Number.isFinite(this.#heartbeatMs) || this.#heartbeatMs <= 0) {
      throw new RangeError("Export progress heartbeat must be a positive duration.");
    }
  }

  setSteps(steps: readonly ExportProgressStep[]): void {
    this.#steps = steps.length === 0 ? [{ weight: 1 }] : steps.map(normalizeStep);
    this.#totalWeight = this.#steps.reduce((total, step) => total + step.weight, 0) || 1;
    this.#completedWeight = 0;
    this.#currentStep = 0;
    this.#stageProgress = 0;
    this.#statusLine = "";
    this.#itemCompleted = null;
    this.#itemTotal = null;
    this.#lastLoggedPercent = null;
    this.#lastLoggedMessage = "";
    this.#startHeartbeat();
  }

  status(message: string): void {
    this.#setStatus(message);
    this.#itemCompleted = null;
    this.#itemTotal = null;
    this.#render(false);
  }

  statusProgress(message: string, completed: number, total: number): void {
    if (!Number.isFinite(completed) || !Number.isFinite(total) || completed < 0 || total < 0) {
      throw new RangeError("Export item progress requires non-negative finite counts.");
    }
    this.#setStatus(message);
    this.#itemCompleted = Math.min(completed, total);
    this.#itemTotal = total;
    this.#stageProgress = total === 0 ? 0 : Math.max(0, Math.min(1, completed / total));
    this.#render(false);
  }

  step(message: string, state: ExportProgressState = "success"): void {
    this.#clearInteractiveLine();
    this.#completedWeight = Math.min(
      this.#totalWeight,
      this.#completedWeight + (this.#steps[this.#currentStep]?.weight ?? 0),
    );
    this.#currentStep += 1;
    this.#stageProgress = 0;
    this.#statusLine = "";
    this.#itemCompleted = null;
    this.#itemTotal = null;
    this.#lastLoggedPercent = null;
    this.#lastLoggedMessage = "";
    this.#write(`${markFor(state)} ${message}\n`);
  }

  suspend(): void {
    if (!this.#interactive) {
      return;
    }
    this.#suspended = true;
    this.#clearInteractiveLine();
  }

  resume(): void {
    if (!this.#interactive) {
      return;
    }
    this.#suspended = false;
    this.#render(false);
  }

  finish(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.#clearInteractiveLine();
  }

  #setStatus(message: string): void {
    if (this.#statusLine !== message) {
      this.#statusStartedAt = Date.now();
      this.#lastLoggedMessage = "";
    }
    this.#statusLine = message;
  }

  #startHeartbeat(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
    }
    this.#heartbeat = setInterval(() => this.#render(true), this.#heartbeatMs);
    this.#heartbeat.unref?.();
  }

  #percent(): number {
    const currentWeight = this.#steps[this.#currentStep]?.weight ?? 0;
    const completed = Math.min(
      this.#totalWeight,
      this.#completedWeight + currentWeight * this.#stageProgress,
    );
    return Math.round((completed / this.#totalWeight) * 100);
  }

  #message(heartbeat: boolean): string {
    const counts =
      this.#itemCompleted === null || this.#itemTotal === null
        ? ""
        : ` (${this.#itemCompleted}/${this.#itemTotal})`;
    const elapsed = heartbeat
      ? ` — still working (${elapsedLabel(Date.now() - this.#statusStartedAt)})`
      : "";
    return `${this.#statusLine}${counts}${elapsed}`;
  }

  #render(heartbeat: boolean): void {
    if (this.#suspended || this.#statusLine === "") {
      return;
    }
    const percent = this.#percent();
    const message = this.#message(heartbeat);
    if (!this.#interactive) {
      if (
        !heartbeat &&
        this.#lastLoggedPercent === percent &&
        this.#lastLoggedMessage === this.#statusLine &&
        this.#itemCompleted !== this.#itemTotal
      ) {
        return;
      }
      this.#write(`[${String(percent).padStart(3, " ")}%] ${message}\n`);
      this.#lastLoggedPercent = percent;
      this.#lastLoggedMessage = this.#statusLine;
      return;
    }
    const filled = Math.max(
      0,
      Math.min(PROGRESS_WIDTH, Math.round((percent / 100) * PROGRESS_WIDTH)),
    );
    const bar = `${"▰".repeat(filled)}${"▱".repeat(PROGRESS_WIDTH - filled)}`;
    this.#clearInteractiveLine();
    this.#write(`[${bar}] ${String(percent).padStart(3, " ")}% ${message}`);
    this.#renderedInteractiveLine = true;
  }

  #clearInteractiveLine(): void {
    if (!this.#renderedInteractiveLine) {
      return;
    }
    this.#write("\r\u001B[K");
    this.#renderedInteractiveLine = false;
  }
}

export const noopExportProgress: ExportProgressSink = {
  setSteps() {},
  status() {},
  statusProgress() {},
  step() {},
  suspend() {},
  resume() {},
  finish() {},
};
