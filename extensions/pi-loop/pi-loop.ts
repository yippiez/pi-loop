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

  function isAgentBusy(): boolean {
    if (!activeCtx) return true;
    try {
      // Access internal state if available
      return (activeCtx as any).isAgentBusy?.() ?? false;
    } catch {
      return false;
    }
  }

  function runIteration() {
    if (!loopState || loopState.status !== "stopped") {
      if (!loopState) return;
    }

    // Skip if agent is busy
    if (isAgentBusy()) {
      scheduleNext();
      return;
    }

    loopState.iteration++;
    try {
      pi.sendUserMessage(loopState.prompt, { deliverAs: "followUp" });
    } catch {
      try {
        pi.sendUserMessage(loopState.prompt);
      } catch {}
    }
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

  pi.registerCommand("loop", {
    description: "Run a prompt repeatedly: /loop [interval] <prompt> | /loop | /loop clear",
    handler: async (args: string) => {
      const trimmed = args.trim();

      // /loop with no args - show status
      if (!trimmed) {
        if (loopState && loopState.status === "running") {
          const elapsed = formatElapsed(Date.now() - loopState.startedAt);
          pi.sendUserMessage(
            `Loop #${loopState.iteration} active — running "${loopState.prompt}" every ${formatElapsed(loopState.intervalMs)}, started ${elapsed} ago`,
          );
        } else {
          pi.sendUserMessage("No active loop.");
        }
        return;
      }

      // /loop clear
      if (trimmed === "clear") {
        if (loopState) {
          const n = loopState.iteration;
          clearLoop();
          pi.sendUserMessage(`Loop cleared after ${n} iterations.`);
        } else {
          pi.sendUserMessage("No active loop to clear.");
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
          const n = loopState.iteration;
          const label = ` #${n} (${elapsed}) Loop Active`;
          const styled = theme.fg("error", label);
          const pad = " ".repeat(Math.max(0, width - label.length));
          return [`${pad}${styled}`];
        },
        dispose() {},
      }),
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    // Initial widget render
    updateWidget(ctx);
    // Refresh widget every second while loop is running
    const refresh = setInterval(() => {
      if (loopState && loopState.status === "running") {
        updateWidget(ctx);
      }
    }, 1000);
    pi.on("session_shutdown", async () => {
      clearInterval(refresh);
    });
  });

  pi.on("session_shutdown", async () => {
    clearLoop();
    activeCtx = undefined;
  });
}
