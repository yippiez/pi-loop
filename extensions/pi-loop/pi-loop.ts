import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MIN_INTERVAL_MS = 5000; // minimum 5s between iterations

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

  function clearLoop() {
    if (loopState?.timer) clearTimeout(loopState.timer);
    loopState = null;
  }

  function scheduleNext(ctx: ExtensionContext) {
    if (!loopState || loopState.status !== "running") return;
    loopState.timer = setTimeout(() => runIteration(ctx), loopState.intervalMs);
  }

  function runIteration(ctx: ExtensionContext) {
    if (!loopState || loopState.status !== "stopped") {
      if (!loopState) return;
    }
    // Skip if agent is busy
    if (ctx.hasUI) {
      try {
        // Check agent busy state via API if available
        const busy = (ctx as any).isAgentBusy?.() ?? false;
        if (busy) {
          scheduleNext(ctx);
          return;
        }
      } catch {}
    }

    loopState.iteration++;
    // Send the prompt as a user message
    try {
      pi.sendUserMessage(loopState.prompt, { deliverAs: "followUp" });
    } catch {
      // If followUp not available, try without options
      try {
        pi.sendUserMessage(loopState.prompt);
      } catch {}
    }
    scheduleNext(ctx);
  }

  function startLoop(prompt: string, intervalMs: number, ctx: ExtensionContext) {
    clearLoop();
    const now = Date.now();
    loopState = {
      prompt,
      intervalMs: Math.max(MIN_INTERVAL_MS, intervalMs),
      iteration: 0,
      startedAt: now,
      status: "running",
      timer: null,
    };
    // Run first iteration immediately
    runIteration(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    // Register prompt bar widget
    if (ctx.hasUI) {
      ctx.ui.setPromptBar((_tui: any, theme: any) => ({
        invalidate() {},
        render(width: number): string[] {
          if (!loopState || loopState.status !== "running") return [];
          const elapsed = formatElapsed(Date.now() - loopState.startedAt);
          const label = `(${elapsed}) Loop Active`;
          const right = theme.fg("error", label);
          const pad = " ".repeat(Math.max(0, width - label.length - 1));
          return [`${pad}${right}`];
        },
      }));
    }

    pi.registerCommand("loop", {
      description: "Run a prompt repeatedly: /loop [interval] <prompt> | /loop | /loop clear",
      handler: async (args: string) => {
        const trimmed = args.trim();

        // /loop with no args - show status
        if (!trimmed) {
          if (!loopState || loopState.status !== "stopped") {
            if (!loopState) {
              pi.sendUserMessage("No active loop.");
              return;
            }
            const elapsed = formatElapsed(Date.now() - loopState.startedAt);
            pi.sendUserMessage(
              `Loop #${loopState.iteration} active — running "${loopState.prompt}" every ${formatElapsed(loopState.intervalMs)}, started ${elapsed} ago`
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
          // /loop 30s prompt text
          prompt = parts.slice(1).join(" ");
          intervalMs = interval;
        } else {
          // /loop prompt text (no interval, run after each completes)
          prompt = trimmed;
          intervalMs = MIN_INTERVAL_MS;
        }

        if (!prompt) {
          pi.sendUserMessage("Usage: /loop [interval] <prompt>");
          return;
        }

        startLoop(prompt, intervalMs, ctx);
      },
    });
  });

  pi.on("session_shutdown", async () => {
    clearLoop();
  });
}
