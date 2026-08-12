// Container visibility filter, driven by HIDDEN_CONTAINERS in the environment.
//
//   HIDDEN_CONTAINERS=nirio-*,crm-*,solar_ai_agents-*
//
// Patterns are comma- or newline-separated and matched case-insensitively
// against each of a container's names and against its ID (full or 12-char
// short form). `*` and `?` are the only wildcards; everything else is literal
// and the match is anchored, so `crm` hides a container called exactly "crm"
// while `crm-*` hides the whole compose project.
//
// A hidden container is treated as if it does not exist: it is absent from the
// container and service lists, excluded from the stats stream and the host
// aggregates, and every per-container route answers 404 for it. There is no way
// to reveal one from the UI — this is host-level config, not a per-user view.

let cachedRaw = null;
let cachedMatchers = [];

function globToRegExp(pattern) {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '*' ? '.*' : ch === '?' ? '.' : `\\${ch}`
  );
  return new RegExp(`^${body}$`, 'i');
}

// Read lazily so the module load order relative to dotenv doesn't matter.
function matchers() {
  const raw = process.env.HIDDEN_CONTAINERS || '';
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedMatchers = raw
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map(globToRegExp);
  }
  return cachedMatchers;
}

export function hiddenPatterns() {
  return (process.env.HIDDEN_CONTAINERS || '')
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Fast path so callers can skip the extra inspect() a visibility check costs.
export function hasHiddenPatterns() {
  return matchers().length > 0;
}

export function isHiddenName(name) {
  if (!name) return false;
  const clean = String(name).replace(/^\//, '');
  return matchers().some((re) => re.test(clean));
}

function isHiddenId(id) {
  if (!id) return false;
  return matchers().some((re) => re.test(id) || re.test(String(id).slice(0, 12)));
}

// `c` is an entry from docker.listContainers() — { Id, Names: ['/name', ...] }.
export function isHiddenContainer(c) {
  if (!c) return false;
  const names = c.Names || (c.Name ? [c.Name] : []);
  return isHiddenId(c.Id) || names.some((n) => isHiddenName(n));
}

export function visibleContainers(list) {
  if (!hasHiddenPatterns()) return list;
  return list.filter((c) => !isHiddenContainer(c));
}

// Count total/running/stopped over the visible set only, so the header counts
// agree with the list the user is actually looking at. Falls back to docker's
// own totals when nothing is hidden, which avoids an extra API call.
export async function visibleCounts(docker, info) {
  if (!hasHiddenPatterns()) {
    return {
      total: info?.Containers ?? 0,
      running: info?.ContainersRunning ?? 0,
      stopped: info?.ContainersStopped ?? 0,
    };
  }
  const all = visibleContainers(await docker.listContainers({ all: true }));
  const running = all.filter((c) => c.State === 'running').length;
  return { total: all.length, running, stopped: all.length - running };
}

// Throws for a hidden (or nonexistent) container. Used to guard the per-ID
// routes, which never see the list that would otherwise filter them out.
export async function assertVisible(docker, id) {
  if (!hasHiddenPatterns()) return;
  const data = await docker.getContainer(id).inspect();
  if (isHiddenName(data.Name) || isHiddenId(data.Id)) {
    const err = new Error('Container not found');
    err.statusCode = 404;
    throw err;
  }
}
