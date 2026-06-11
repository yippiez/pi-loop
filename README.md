# pi-loop

Run a prompt or slash command repeatedly on a fixed interval.

## Usage

```text
/loop 30s check CI status        # fixed interval, runs every 30s
/loop 5m /recap                   # fixed interval, runs /recap every 5 minutes
/loop 10s fix the bug             # fixed interval, runs every 10 seconds
/loop                              # show loop status if active
/loop clear                        # stop and clear the loop
```

## Behavior

- Each iteration sends the prompt as a normal user message.
- Loop persists across turns while Pi is running.
- If the agent is busy, the loop iteration is skipped.
- One loop at a time. Starting a new loop replaces the old one.
- Quitting Pi kills the loop — no persistence.
- Prompt bar shows a red timer widget: `(12s) Loop Active`.

## Install

Global install:

```bash
pi install git:github.com/yippiez/pi-loop
```

Local/project install:

```bash
pi install -l git:github.com/yippiez/pi-loop
```
