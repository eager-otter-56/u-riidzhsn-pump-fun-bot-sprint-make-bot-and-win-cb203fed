[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/eager-otter-56/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/eager-otter-56/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint: Make Bot And Win

A momentum paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2).
It buys fresh curves only once accelerating buy pressure shows — net SOL
flowing in, several distinct buyers, price climbing and holding near its
window high — pyramids into strength up to a fixed stake, and cuts every
position on a stop loss, a trailing stop, a fade in flow, or a time limit.
Tiny probe round trips keep the run above the 20-coin guardrail when
momentum flow runs dry. Deterministic: no clock, no randomness, decisions
come only from the batch stream.

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` — the momentum strategy (params in `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's SDK shim

Bounty: https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed
