import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

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

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
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

    const elapsed = formatElapsed(Date.now() - loopState.startedAt);
    const interval = formatInterval(loopState.intervalMs);

    ctx.ui.custom<void>((_tui, theme: Theme, _kb, done) => {
      const container = new Container();
      const border = (s: string) => theme.fg("error", s);

      container.addChild(new DynamicBorder(border));
      container.addChild(new Text(theme.fg("error", theme.bold("Loop Active")), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("error", `Prompt:    ${loopState!.prompt}`), 1, 0));
      container.addChild(new Text(theme.fg("error", `Interval:  ${interval}`), 1, 0));
      container.addChild(new Text(theme.fg("error", `Elapsed:   ${elapsed}`), 1, 0));
      container.addChild(new Text(theme.fg("error", `Iteration: ${loopState!.iteration}`), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("error", "Press Escape to close"), 1, 0));
      container.addChild(new DynamicBorder(border));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (_data: string) => {
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

      if (!trimmed) {
        if (loopState && loopState.status === "running" && activeCtx) {
          showStatusBox(activeCtx);
        } else {
          pi.sendUserMessage("No active loop.");
        }
        return;
      }

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
    description: "Show loop status in a red box",
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
