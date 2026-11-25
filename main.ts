// Pump.fun Bot Sprint: Make Bot And Win — momentum bot entrypoint.
//
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types; no
// build, no install). The strategy lives in strategy.ts; the wire shim in
// vendor/makefun-bot.ts is a byte-identical copy of the kit's SDK.
//
// Strategy in one line: buy fresh curves only once accelerating buy pressure
// shows (net SOL in, several distinct buyers, price up and near its window
// high), pyramid into strength, and cut every position on a stop loss, a
// trailing stop, a fade in flow, or a time limit. Tiny probe round trips
// keep the run above the 20-coin guardrail when momentum flow runs dry.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
