// api/decision.js
// Deterministic BeerBot: Order-up-to + demand smoothing + pipeline approx + gentle backlog correction.
// Works in BlackBox mode (uses each role's own history only). Also safe in GlassBox input (ignores other roles).

export default function handler(req, res) {
  const body = req.body || {};

  // -----------------------------
  // 1) Handshake (required)
  // -----------------------------
  if (body.handshake === true) {
    return res.status(200).json({
      ok: true,
      student_email: "laur.mathiesen@taltech.ee", // <-- CHANGE THIS
      algorithm_name: "BullwhipBreaker",            // 3–32 chars, letters/digits/underscore recommended
      version: "v1.0.0",
      supports: { blackbox: true, glassbox: false },
      message: "BeerBot ready"
    });
  }

  // -----------------------------
  // 2) Weekly decision
  // -----------------------------
  const weeks = Array.isArray(body.weeks) ? body.weeks : [];
  const last = weeks.length ? weeks[weeks.length - 1] : null;

  // Fallback: if input is malformed, return safe defaults (deterministic).
  if (!last || !last.roles) {
    return res.status(200).json({
      orders: { retailer: 10, wholesaler: 10, distributor: 10, factory: 10 }
    });
  }

  const ROLES = ["retailer", "wholesaler", "distributor", "factory"];

  // -----------------------------
  // Helpers
  // -----------------------------
  function toIntNonNeg(x) {
    // Ensure integer, non-negative, deterministic.
    if (!Number.isFinite(x)) return 0;
    const v = Math.round(x);
    return v < 0 ? 0 : v;
  }

  function getRoleState(weekObj, role) {
    const r = weekObj?.roles?.[role] || {};
    return {
      inventory: Number.isFinite(r.inventory) ? r.inventory : 0,
      backlog: Number.isFinite(r.backlog) ? r.backlog : 0,
      incoming_orders: Number.isFinite(r.incoming_orders) ? r.incoming_orders : 0,
      arriving_shipments: Number.isFinite(r.arriving_shipments) ? r.arriving_shipments : 0
    };
  }

  function getPrevOrder(role) {
    // Current week object contains previous decision for this week under weeks[-1].orders per spec.
    // If missing, use stable default (10).
    const o = last?.orders?.[role];
    return Number.isFinite(o) ? o : 10;
  }

  function movingAverageIncoming(role, window = 4) {
    // Average of incoming_orders over last N weeks (including current).
    const start = Math.max(0, weeks.length - window);
    let sum = 0;
    let n = 0;
    for (let i = start; i < weeks.length; i++) {
      const st = getRoleState(weeks[i], role);
      sum += st.incoming_orders;
      n += 1;
    }
    return n > 0 ? sum / n : 0;
  }

  function demandTrend(role, shortW = 3, longW = 8) {
    // Simple deterministic trend: short MA - long MA (bounded later).
    const shortMA = movingAverageIncoming(role, shortW);
    const longMA = movingAverageIncoming(role, longW);
    return shortMA - longMA;
  }

  function approxPipeline(role, L = 2) {
    // Stateless pipeline proxy: sum of our own orders over last L weeks.
    // In classic beergame there is a shipping delay; this proxy helps estimate "on the way".
    const start = Math.max(0, weeks.length - L);
    let sum = 0;
    for (let i = start; i < weeks.length; i++) {
      const o = weeks[i]?.orders?.[role];
      sum += Number.isFinite(o) ? o : 0;
    }
    return sum;
  }

  // -----------------------------
  // Decision policy (per role)
  // -----------------------------
  function decideOrderForRole(role) {
    const st = getRoleState(last, role);

    // Core idea:
    // - forecast demand (dHat) with smoothing
    // - compute "inventory position" IP = inventory - backlog + pipeline
    // - set target position = dHat*(L+1) + safety + (small backlog catch-up)
    // - order = target - IP, then smooth (avoid bullwhip)

    // Tunable (keep small and stable; these are robust defaults):
    const L = 2;                 // assumed effective lead time proxy
    const demandWindow = 4;      // smoothing window
    const alpha = 0.35;          // order smoothing factor (0..1); lower = less oscillation
    const baseSafety = 4;        // safety stock buffer
    const backlogGain = 0.25;    // only catch up part of backlog to avoid oscillation
    const trendGain = 0.30;      // small trend response

    // Demand forecast (smoothed)
    const dHat = movingAverageIncoming(role, demandWindow);

    // Trend term (optional but mild): helps adapt if demand shifts gradually
    let tr = demandTrend(role, 3, 8);
    // Bound trend influence (deterministic, prevents runaway):
    if (tr > 5) tr = 5;
    if (tr < -5) tr = -5;

    // Pipeline proxy
    const pipeline = approxPipeline(role, L);

    // Inventory Position
    const IP = st.inventory - st.backlog + pipeline;

    // Dynamic safety: slightly higher if demand is higher
    const safety = baseSafety + 0.15 * dHat;

    // Target position:
    // (L+1) periods of demand coverage + safety + partial backlog correction + mild trend
    const target =
      dHat * (L + 1) +
      safety +
      backlogGain * st.backlog +
      trendGain * tr;

    // Raw order recommendation
    const rawOrder = target - IP;

    // Smooth against previous order to reduce bullwhip
    const prev = getPrevOrder(role);
    const smoothed = prev + alpha * (rawOrder - prev);

    return toIntNonNeg(smoothed);
  }

  const orders = {};
  for (const role of ROLES) {
    orders[role] = decideOrderForRole(role);
  }

  return res.status(200).json({ orders });
}
