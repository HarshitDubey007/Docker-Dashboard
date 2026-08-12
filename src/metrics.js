// Pure functions for Docker stats math. No I/O, no dockerode imports.
// Docker stats JSON shape reference: https://docs.docker.com/engine/api/v1.43/#tag/Container/operation/ContainerStats

export function calcCpuPercent(stats) {
  if (!stats || !stats.cpu_stats || !stats.precpu_stats) return 0;
  const cpuDelta =
    (stats.cpu_stats.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage ?? 0) -
    (stats.precpu_stats.system_cpu_usage ?? 0);
  const onlineCpus =
    stats.cpu_stats.online_cpus ||
    stats.cpu_stats.cpu_usage?.percpu_usage?.length ||
    1;
  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

export function calcMemUsage(stats) {
  if (!stats || !stats.memory_stats) return { used: 0, limit: 0, percent: 0 };
  const usage = stats.memory_stats.usage ?? 0;
  // Exclude page cache — matches `docker stats` behavior.
  const cache =
    stats.memory_stats.stats?.cache ??
    stats.memory_stats.stats?.inactive_file ??
    0;
  const used = Math.max(0, usage - cache);
  const limit = stats.memory_stats.limit ?? 0;
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  return { used, limit, percent };
}

export function summarizeContainer(id, name, stats) {
  const mem = calcMemUsage(stats);
  return {
    id,
    name,
    cpuPercent: round2(calcCpuPercent(stats)),
    memUsed: mem.used,
    memLimit: mem.limit,
    memPercent: round2(mem.percent),
  };
}

// Aggregate per-container samples into a host-level summary.
// `info` is the response from `docker.info()`. `counts` optionally overrides
// docker's own container tallies — callers pass the visible-only counts when
// HIDDEN_CONTAINERS is in play (see hidden.js).
export function summarizeHost(info, containerSamples, counts = null) {
  const totalMem = info?.MemTotal ?? 0;
  const cores = info?.NCPU ?? 0;
  let memUsed = 0;
  let cpuSum = 0;
  for (const c of containerSamples) {
    memUsed += c.memUsed || 0;
    cpuSum += c.cpuPercent || 0;
  }
  // Sum of per-container CPU% can exceed 100 — normalize against total capacity.
  const cpuPercent = cores > 0 ? Math.min(100, cpuSum / cores) : 0;
  const memPercent = totalMem > 0 ? (memUsed / totalMem) * 100 : 0;
  return {
    cpu: { percent: round2(cpuPercent), cores },
    memory: { used: memUsed, total: totalMem, percent: round2(memPercent) },
    containers: counts || {
      total: info?.Containers ?? 0,
      running: info?.ContainersRunning ?? 0,
      stopped: info?.ContainersStopped ?? 0,
    },
    docker: {
      version: info?.ServerVersion,
      os: info?.OperatingSystem || info?.OSType,
    },
  };
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
