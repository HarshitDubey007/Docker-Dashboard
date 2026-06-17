// Shared frontend helpers
(function () {
  const TOKEN_KEY = 'dd_token';
  const USER_KEY = 'dd_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function setUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

  async function apiFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      clearSession();
      if (!location.pathname.endsWith('/login.html')) {
        location.href = '/login.html';
      }
      throw new Error('Unauthorized');
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function requireAuth() {
    if (!getToken()) {
      location.href = '/login.html';
      return false;
    }
    return true;
  }

  async function loadCurrentUser() {
    try {
      const { user } = await apiFetch('/api/auth/me');
      setUser(user);
      return user;
    } catch (e) {
      return null;
    }
  }

  function logout() {
    clearSession();
    location.href = '/login.html';
  }

  function renderUserBadge(container) {
    const user = getUser();
    if (!user || !container) return;
    container.innerHTML = `
      <div class="user-badge">
        <span>${escapeHtml(user.username)}</span>
        <span class="role-pill ${user.role === 'admin' ? '' : 'viewer'}">${user.role.toUpperCase()}</span>
      </div>
      <button class="ghost" id="logout-btn">Logout</button>
    `;
    document.getElementById('logout-btn').onclick = logout;
  }

  function renderAdminNav(container) {
    const user = getUser();
    if (!container) return;
    const items = [
      { href: '/index.html', label: 'Dashboard' },
      { href: '/services.html', label: 'Services' },
    ];
    if (user && user.role === 'admin') {
      items.push({ href: '/servers.html', label: 'Servers' });
      items.push({ href: '/admin.html', label: 'Users' });
    }
    const current = location.pathname.split('/').pop() || 'index.html';
    container.innerHTML = items.map(i => {
      const active = i.href.endsWith(current) ? 'active' : '';
      return `<a class="nav-link ${active}" href="${i.href}">${i.label}</a>`;
    }).join('');
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    const t = new Date(iso).getTime();
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  window.API = {
    apiFetch, getToken, setToken, getUser, setUser,
    requireAuth, loadCurrentUser, logout, clearSession,
    renderUserBadge, renderAdminNav,
    escapeHtml, timeAgo,
  };
})();
