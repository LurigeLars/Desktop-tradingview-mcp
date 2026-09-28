/**
 * Process-global serialization for TradingView Desktop topology mutations.
 *
 * The Desktop runtime is shared by every MCP client/chat connected to this
 * server process. Read-only tools remain concurrent; mutations that depend on
 * shared tab/layout/pane state should run through this FIFO lock.
 */

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function createMutationLock({
  defaultTimeoutMs = positiveInteger(process.env.TV_TOPOLOGY_LOCK_WAIT_MS, 30_000),
  now = () => Date.now(),
} = {}) {
  let active = null;
  let sequence = 0;
  const queue = [];

  function snapshot() {
    return {
      locked: !!active,
      active: active
        ? {
            id: active.id,
            label: active.label,
            acquired_at: active.acquiredAt,
            held_ms: Math.max(0, now() - active.acquiredAt),
          }
        : null,
      queued: queue.map(item => ({
        id: item.id,
        label: item.label,
        queued_at: item.queuedAt,
        waiting_ms: Math.max(0, now() - item.queuedAt),
      })),
      queue_length: queue.length,
    };
  }

  function grantNext() {
    if (active) return;
    while (queue.length) {
      const waiter = queue.shift();
      if (waiter.cancelled) continue;

      if (waiter.timer) clearTimeout(waiter.timer);
      active = {
        id: waiter.id,
        label: waiter.label,
        acquiredAt: now(),
      };

      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        if (active?.id === waiter.id) active = null;
        grantNext();
      });
      return;
    }
  }

  function acquire(label, { timeoutMs = defaultTimeoutMs } = {}) {
    const timeout = positiveInteger(timeoutMs, defaultTimeoutMs);
    const id = ++sequence;
    const queuedAt = now();

    return new Promise((resolve, reject) => {
      const waiter = {
        id,
        label: String(label || 'mutation'),
        queuedAt,
        resolve,
        reject,
        timer: null,
        cancelled: false,
      };

      waiter.timer = setTimeout(() => {
        waiter.cancelled = true;
        const index = queue.findIndex(item => item.id === id);
        if (index >= 0) queue.splice(index, 1);
        reject(new Error(
          'DTV topology mutation lock timed out after ' + timeout +
          'ms while waiting for "' + waiter.label + '".'
        ));
      }, timeout);

      queue.push(waiter);
      grantNext();
    });
  }

  async function run(label, fn, options) {
    const release = await acquire(label, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire, run, status: snapshot };
}

const topologyMutationLock = createMutationLock();

export function withTopologyMutationLock(label, fn, options) {
  return topologyMutationLock.run(label, fn, options);
}

export function topologyMutationLockStatus() {
  return topologyMutationLock.status();
}
