// Momentum bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: fresh pump.fun curves are mostly noise, but a curve that has lived a
// little and suddenly shows accelerating buy pressure — net SOL flowing in,
// several distinct buyers, price climbing and holding near its recent high —
// is worth a small stake. The first buy is small; the position is pyramided
// into strength only, up to a fixed stake. Every position carries a stop
// loss, a trailing stop once it is up, a fade exit on sudden outflow and a
// hard time limit, so losers are cut and runners are ridden, not held.
//
// Guardrail probes keep the run above the minimum bar (20 coins, 0.01 SOL
// round trips): when the bot's own fills or coins lag the pace the run
// should be on, it buys a tiny probe of the most liquid curve and sells it
// as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no environment —
// decisions come only from the batch stream (slots, block times carried by
// events) and iteration follows insertion-ordered maps.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far in one window. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Keep adding to a position while the entry signal still holds, up to stakeSol. */
  pyramid: boolean;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Guardrail pacing: target fills/coins over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 30,
  minNetSol: 1.0,
  minBuys: 3,
  minBuyers: 5,
  minPriceUp: 0.08,
  maxPriceUp: 1.5,
  accel: 1.5,
  nearHigh: 0.97,
  maxBuyerShare: 0.6,
  minRqSol: 2,
  maxRqSol: 100,
  minAge: 600,
  stakeSol: 0.3,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.08,
  trail: 0.25,
  trailArm: 0.15,
  fadeWindow: 15,
  fadeNetSol: 0.5,
  bigSellSol: 2,
  maxHold: 900,
  maxHold: 900,
  cooldown: 150,
  maxEntries: 1,
  pyramid: true,
  holdIfUp: 0.5,
  initialSol: 0.02,
  addSol: 0.05,
  addStep: 0.2,
  addIfUp: 0.15,
  addNetSol: 0,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 50,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 5,
};

const LAMPORTS = 1e9;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  openedSlot: number;
  peakValue: number;
  invested: number;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  /** An exit sell is in flight; do not send another until it resolves. */
  exiting: boolean;
}

interface Probe {
  phase: 'buying' | 'selling';
  decidedSlot: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, Probe>();
  const ownCoins = new Set<Pubkey>();
  let ownFills = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime = 0;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExitSlot: -1_000_000 };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Net SOL and buyers over the trades in the given slot window. */
  function windowStats(t: Tape, fromSlot: number): {
    net: number;
    buys: number;
    buyers: Set<string>;
    buySol: number;
    maxBuyerSol: number;
    high: number;
    startPrice: number;
    midNet: number;
    lateNet: number;
  } {
    const buyers = new Set<string>();
    const perBuyer = new Map<string, number>();
    let net = 0;
    let buys = 0;
    let buySol = 0;
    let high = 0;
    let startPrice = 0;
    let midNet = 0;
    let lateNet = 0;
    const mid = fromSlot + p.window / 2;
    for (const tr of t.trades) {
      if (tr.slot <= fromSlot) continue;
      if (startPrice === 0) startPrice = tr.price;
      if (tr.price > high) high = tr.price;
      const flow = tr.buy ? tr.sol : -tr.sol;
      net += flow;
      if (tr.slot < mid) midNet += flow;
      else lateNet += flow;
      if (tr.buy) {
        buys += 1;
        buySol += tr.sol;
        buyers.add(tr.user);
        perBuyer.set(tr.user, (perBuyer.get(tr.user) ?? 0) + tr.sol);
      }
    }
    let maxBuyerSol = 0;
    for (const v of perBuyer.values()) if (v > maxBuyerSol) maxBuyerSol = v;
    return { net, buys, buyers, buySol, maxBuyerSol, high, startPrice, midNet, lateNet };
  }

  function entrySignal(state: BotState, mint: Pubkey, t: Tape): boolean {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    if (t.created === null) return false;
    if (state.slot - t.created < p.minAge) return false;
    const rq = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rq < p.minRqSol || rq > p.maxRqSol) return false;
    const priceNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (priceNow <= 0) return false;
    const s = windowStats(t, state.slot - p.window);
    if (s.buys < p.minBuys) return false;
    if (s.net < p.minNetSol) return false;
    if (s.buyers.size < p.minBuyers) return false;
    if (s.buySol > 0 && s.maxBuyerSol / s.buySol > p.maxBuyerShare) return false;
    if (s.startPrice <= 0) return false;
    const up = priceNow / s.startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (s.high > 0 && priceNow < p.nearHigh * s.high) return false;
    if (s.lateNet < p.accel * s.midNet) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      const caps = state.hello.caps;

      // --- clock + tape -------------------------------------------------
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          // Keep the tape short: only the last few hundred trades matter.
          if (t.trades.length > 400) t.trades.splice(0, t.trades.length - 400);
        }
      }

      // --- fills: track our own round trips and probe progress ----------
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) continue;
        if (f.status === 'filled') {
          ownFills += 1;
          ownCoins.add(f.mint);
          const pr = probes.get(f.mint);
          if (pr !== undefined && f.side === 'buy' && pr.phase === 'buying') {
            pr.phase = 'selling';
          } else if (pr !== undefined && f.side === 'sell' && pr.phase === 'selling') {
            probes.delete(f.mint);
          }
          const h = held.get(f.mint);
          if (h !== undefined && f.side === 'buy') h.filled = true;
        } else if (f.status === 'rejected' || f.status === 'failed') {
          const pr = probes.get(f.mint);
          if (pr !== undefined && f.side === 'buy' && pr.phase === 'buying') {
            probes.delete(f.mint);
          }
          // An exit sell that did not go through: allow the exit to retry.
          if (f.side === 'sell') {
            const h2 = held.get(f.mint);
            if (h2 !== undefined) h2.exiting = false;
          }
        }
      }

      // --- sync held positions with the account (closes drop out) -------
      // A buy can take more than one batch to fill (latency is 2 slots and
      // batches are short in busy periods), so a mint with a pending buy or
      // sell must NOT be dropped just because the position is not visible
      // yet — dropping it strands the position with no exit logic.
      for (const [mint, h] of [...held]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          const pending = [...state.pending.values()].some((po) => po.order.mint === mint);
          if (!pending) held.delete(mint);
        } else {
          const curve = state.curves.get(mint);
          const price = curve === undefined ? 0 : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          h.lastValue = Number(pos.token_amount) * price / LAMPORTS;
          if (h.lastValue > h.peakValue) h.peakValue = h.lastValue;
        }
      }

      const exposure = [...state.positions.values()].reduce(
        (sum, pos) => sum + Number(pos.cost_lamports) / LAMPORTS,
        0,
      );

      // --- exits ---------------------------------------------------------
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h === undefined || !h.filled) continue;
        if (h.exiting) continue; // exit sell already in flight
        if (probes.has(mint)) continue; // probes sell on their own schedule
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue; // replay closes it
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const value = Number(pos.token_amount) * price / LAMPORTS;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        let exit = false;
        if (value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && state.slot - h.openedSlot > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) {
          const fade = windowStats(tapeFor(mint), state.slot - p.fadeWindow);
          if (fade.net < -p.fadeNetSol) exit = true;
        }
        if (!exit) {
          for (const e of batch.events) {
            if (e.event === 'TradeEvent' && e.mint === mint && !e.is_buy && Number(e.sol_amount) / LAMPORTS >= p.bigSellSol) {
              exit = true;
              break;
            }
          }
        }
        if (exit) {
          const t = tapeFor(mint);
          t.lastExitSlot = state.slot;
          // Keep the held entry until the position actually disappears:
          // deleting it here would strand the position if the sell fails.
          h.exiting = true;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        }
      }

      // --- probe sells ---------------------------------------------------
      for (const [mint, pr] of probes) {
        if (pr.phase !== 'selling') continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          // Position gone without a sell fill: the harness closed it.
          probes.delete(mint);
          continue;
        }
        const pendingSell = [...state.pending.values()].some(
          (po) => po.order.mint === mint && po.order.side === 'sell',
        );
        if (pendingSell) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- pyramiding ----------------------------------------------------
      if (p.pyramid) {
        for (const [mint, pos] of state.positions) {
          const h = held.get(mint);
          if (h === undefined || !h.filled) continue;
          if (h.exiting) continue;
          if (probes.has(mint)) continue;
          if (h.invested >= p.stakeSol) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (price <= 0 || price < h.lastAddPrice * (1 + p.addStep)) continue;
          const cost = Number(pos.cost_lamports) / LAMPORTS;
          if (cost > 0 && h.lastValue < cost * (1 + p.addIfUp)) continue;
          if (p.addNetSol > 0) {
            const s = windowStats(tapeFor(mint), state.slot - p.window);
            if (s.net < p.addNetSol) continue;
          }
          let amount = BigInt(Math.floor(p.addSol * LAMPORTS));
          const room = BigInt(Math.floor((p.stakeSol - h.invested) * LAMPORTS));
          if (amount > room) amount = room;
          const cap = state.maxBuyLamports(mint);
          if (amount > cap) amount = cap;
          if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
          if (free < amount + tx) continue;
          if (orders.length >= caps.max_orders_per_batch) break;
          orders.push({ side: 'buy', mint, quote_lamports: amount.toString(), max_slippage_bps: p.buySlipBps });
          h.invested += Number(amount) / LAMPORTS;
          h.lastAddPrice = price;
          free -= amount + tx;
        }
      }

      // --- new entries ---------------------------------------------------
      let slots = caps.max_open_positions - state.committedPositionCount();
      if (exposure < p.maxExposureSol && slots > 0) {
        for (const e of batch.events) {
          if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
          if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          if (held.has(mint) || probes.has(mint)) continue;
          const t = tapeFor(mint);
          if (t.entries >= p.maxEntries) continue;
          if (state.slot - t.lastExitSlot < p.cooldown) continue;
          if (!entrySignal(state, mint, t)) continue;
          const cap = state.maxBuyLamports(mint);
          let amount = BigInt(Math.floor(p.initialSol * LAMPORTS));
          if (amount > cap) amount = cap;
          if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
          if (free < amount + tx) continue;
          const curve = state.curves.get(mint);
          const price = curve === undefined ? 0 : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          orders.push({ side: 'buy', mint, quote_lamports: amount.toString(), max_slippage_bps: p.buySlipBps });
          held.set(mint, {
            openedSlot: state.slot,
            peakValue: 0,
            invested: Number(amount) / LAMPORTS,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            exiting: false,
          });
          t.entries += 1;
          free -= amount + tx;
          slots -= 1;
        }
      }

      // --- guardrail probes ----------------------------------------------
      if (firstBlockTime !== null && probes.size < p.maxProbes) {
        const elapsed = lastBlockTime - firstBlockTime;
        // Pace toward the guardrail targets by the end of paceSecs — and no
        // further: the targets are totals, not a rate to chase all run.
        const wantFills = Math.min(p.targetFills, (p.targetFills * elapsed) / p.paceSecs);
        const wantCoins = Math.min(p.targetCoins, (p.targetCoins * elapsed) / p.paceSecs);
        if (ownFills < wantFills || ownCoins.size < wantCoins) {
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const [mint, curve] of state.curves) {
            // A probe exists to reach NEW coins for the guardrail: re-probing
            // a coin already traded adds fills but never a coin, so the pace
            // check would keep firing on it all run.
            if (curve.complete || held.has(mint) || probes.has(mint) || ownCoins.has(mint)) continue;
            const rq = Number(curve.real_quote_reserves);
            if (rq > bestRq && state.maxBuyLamports(mint) >= BigInt(Math.floor(p.probeSol * LAMPORTS))) {
              best = mint;
              bestRq = rq;
            }
          }
          if (best !== null && slots > 0) {
            const amount = BigInt(Math.floor(p.probeSol * LAMPORTS));
            if (free >= amount + tx && orders.length < caps.max_orders_per_batch) {
              orders.push({ side: 'buy', mint: best, quote_lamports: amount.toString(), max_slippage_bps: 10_000 });
              probes.set(best, { phase: 'buying', decidedSlot: state.slot });
              free -= amount + tx;
            }
          }
        }
      }

      return orders;
    },
  };
}
