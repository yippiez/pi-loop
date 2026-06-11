import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MIN_INTERVAL_MS = 5000;

interface LoopState {
  prompt: string;
  intervalMs: number;
  iteration: number;
  startedAt: number;
  status: "running" | "stopped";
  timer: ReturnType<typeof setTimeout> | null;
}

function parseInterval(raw: string): number | null {
  const m = raw.match(/^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith("h")) return n * 3600_000;
  if (unit.startsWith("m")) return n * 60_000;
  return n * 1000;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

function formatInterval(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function vw(s: string): number {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").length;
}

function trunc(s: string, max: number): string {
  if (vw(s) <= max) return s;
  // Binary search for the right cutoff
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (vw(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + "…";
}

function padLine(content: string, contentW: number): string {
  const w = vw(content);
  if (w < contentW) return content + " ".repeat(contentW - w);
  return trunc(content, contentW);
}

export default function loopExtension(pi: ExtensionAPI) {
  let loopState: LoopState | null = null;
  let activeCtx: ExtensionContext | undefined;

  function clearLoop() {
    if (loopState?.timer) clearTimeout(loopState.timer);
    loopState = null;
    if (activeCtx) updateWidget(activeCtx);
  }

  function scheduleNext() {
    if (!loopState || loopState.status !== "running") return;
    loopState.timer = setTimeout(() => runIteration(), loopState!.intervalMs);
  }

  async function runIteration() {
    if (!loopState || loopState.status !== "running") return;
    loopState.iteration++;
    try {
      await (pi.sendUserMessage as any)(loopState.prompt, { streamingBehavior: "followUp" });
    } catch {}
    scheduleNext();
  }

  function startLoop(prompt: string, intervalMs: number) {
    clearLoop();
    loopState = {
      prompt,
      intervalMs: Math.max(MIN_INTERVAL_MS, intervalMs),
      iteration: 0,
      startedAt: Date.now(),
      status: "running",
      timer: null,
    };
    if (activeCtx) updateWidget(activeCtx);
    runIteration();
  }

  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!loopState || loopState.status !== "running") {
      ctx.ui.setWidget("pi-loop", undefined);
      return;
    }
    ctx.ui.setWidget(
      "pi-loop",
      (_tui: any, theme: any) => ({
        invalidate() {},
        render(width: number): string[] {
          if (!loopState || loopState.status !== "running") return [];
          const elapsed = formatElapsed(Date.now() - loopState.startedAt);
          const label = `(${elapsed}) Loop Active`;
          const styled = theme.fg("error", label);
          const pad = " ".repeat(Math.max(0, width - label.length));
          return [`${pad}${styled}`];
        },
        dispose() {},
      }),
      { placement: "aboveEditor" },
    );
  }

  function showStatusBox(ctx: ExtensionContext) {
    if (!loopState || loopState.status !== "running") {
      pi.sendUserMessage("No active loop.");
      return;
    }
    if (!ctx.hasUI) return;
    ctx.ui.custom<void>((_tui, theme, _kb, done) => {
      const border = (s: string) => theme.fg("error", s);
      return {
        render(width: number): string[] {
          const innerW = Math.max(1, width - 2);
          const cw = Math.max(1, width - 4);
          const elapsed = formatElapsed(Date.now() - loopState!.startedAt);
          const interval = formatInterval(loopState!.intervalMs);
          const row = (text: string) => `${border("│")} ${padLine(text, cw)} ${border("│")}`;
          return [
            border(`╭${"─".repeat(innerW)}╮`),
            row(theme.fg("error", theme.bold("Loop Active"))),
            `${border("│")}${" ".repeat(innerW)}${border("│")}`,
            row(`Prompt:    ${loopState!.prompt}`),
            row(`Interval:  ${interval}`),
            row(`Elapsed:   ${elapsed}`),
            row(`Iteration: ${loopState!.iteration}`),
            `${border("│")}${" ".repeat(innerW)}${border("│")}`,
            row(theme.fg("dim", "Press Escape to close")),
            border(`╰${"─".repeat(innerW)}╯`),
          ];
        },
        handleInput(_data) {
          done(undefined as any);
          return { consume: true };
        },
      };
    });
  }

  pi.registerCommand("loop", {
    description: "Run a prompt repeatedly: /loop [interval] <prompt>",
    handler: async (args: string) => {
      const trimmed = args.trim();

      // /loop with no args - show status widget
      if (!trimmed) {
        if (loopState && loopState.status === "running" && activeCtx) {
          showStatusBox(activeCtx);
        } else {
          pi.sendUserMessage("No active loop.");
        }
        return;
      }

      // /loop <interval> <prompt> or /loop <prompt>
      const parts = trimmed.split(/\s+/);
      const interval = parseInterval(parts[0] ?? "");
      let prompt: string;
      let intervalMs: number;

      if (interval !== null) {
        prompt = parts.slice(1).join(" ");
        intervalMs = interval;
      } else {
        prompt = trimmed;
        intervalMs = MIN_INTERVAL_MS;
      }

      if (!prompt) {
        pi.sendUserMessage("Usage: /loop [interval] <prompt>");
        return;
      }

      startLoop(prompt, intervalMs);
    },
  });

  pi.registerCommand("loop:clear", {
    description: "Stop and clear the current loop",
    handler: async () => {
      if (loopState) {
        const n = loopState.iteration;
        clearLoop();
        pi.sendUserMessage(`Loop cleared after ${n} iterations.`);
      } else {
        pi.sendUserMessage("No active loop to clear.");
      }
    },
  });

  pi.registerCommand("loop:status", {
    description: "Show loop status as a red box widget",
    handler: async () => {
      if (activeCtx) showStatusBox(activeCtx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    updateWidget(ctx);
    const refresh = setInterval(() => {
      if (loopState && loopState.status === "running") updateWidget(ctx);
    }, 1000);
    pi.on("session_shutdown", async () => clearInterval(refresh));
  });

  pi.on("session_shutdown", async () => {
    clearLoop();
    activeCtx = undefined;
  });
}
