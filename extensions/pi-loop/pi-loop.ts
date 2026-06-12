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
  let statusOpen = false;
  let infoTimer: ReturnType<typeof setTimeout> | undefined;

  function clearLoop() {
    if (loopState?.timer) clearTimeout(loopState.timer);
    loopState = null;
    if (activeCtx) updateWidget(activeCtx);
  }

  function scheduleNext() {
    if (!loopState || loopState.status !== "running") return;
    loopState.timer = setTimeout(() => runIteration(), loopState!.intervalMs);
  }

  function showInfo(content: string) {
    if (!activeCtx?.hasUI) return;
    if (infoTimer) clearTimeout(infoTimer);
    activeCtx.ui.setWidget(
      "pi-loop-info",
      (_tui: any, theme: any) => ({
        invalidate() {},
        render(width: number): string[] {
          return [theme.fg("dim", content.slice(0, Math.max(0, width)))];
        },
        dispose() {},
      }),
      { placement: "aboveEditor" },
    );
    infoTimer = setTimeout(() => {
      activeCtx?.ui.setWidget("pi-loop-info", undefined);
      infoTimer = undefined;
    }, 2200);
  }

  async function runIteration() {
    if (!loopState || loopState.status !== "running") return;
    loopState.iteration++;
    try {
      await (pi.sendUserMessage as any)(loopState.prompt, { deliverAs: "followUp" });
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
    if (!loopState || loopState.status !== "running" || statusOpen) {
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
      showInfo("No active loop.");
      return;
    }
    if (!ctx.hasUI) return;

    statusOpen = true;
    updateWidget(ctx);

    ctx.ui.custom<void>((_tui, theme: Theme, _kb, done) => {
      const container = new Container();
      const border = (s: string) => theme.fg("error", s);

      const promptText = new Text("", 1, 0);
      const intervalText = new Text("", 1, 0);
      const elapsedText = new Text("", 1, 0);
      const iterationText = new Text("", 1, 0);

      container.addChild(new DynamicBorder(border));
      container.addChild(new Spacer(1));
      container.addChild(promptText);
      container.addChild(intervalText);
      container.addChild(elapsedText);
      container.addChild(iterationText);
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("text", "Press Escape to close"), 1, 0));
      container.addChild(new DynamicBorder(border));

      const close = () => {
        statusOpen = false;
        updateWidget(ctx);
        done(undefined as any);
      };

      return {
        render: (width: number) => {
          if (loopState) {
            promptText.setText(theme.fg("text", `Prompt:    ${loopState.prompt}`));
            intervalText.setText(theme.fg("text", `Interval:  ${formatInterval(loopState.intervalMs)}`));
            elapsedText.setText(theme.fg("text", `Elapsed:   ${formatElapsed(Date.now() - loopState.startedAt)}`));
            iterationText.setText(theme.fg("text", `Iteration: ${loopState.iteration}`));
          }
          return container.render(width);
        },
        invalidate: () => container.invalidate(),
        dispose: () => {
          statusOpen = false;
          updateWidget(ctx);
        },
        handleInput: (_data: string) => {
          close();
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
          showInfo("No active loop.");
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
        showInfo("Usage: /loop [interval] <prompt>");
        return;
      }

      startLoop(prompt, intervalMs);
    },
  });

  pi.registerCommand("loop:clear", {
    description: "Stop and clear the current loop",
    handler: async () => {
      clearLoop();
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
    if (infoTimer) clearTimeout(infoTimer);
    infoTimer = undefined;
    activeCtx = undefined;
  });
}
