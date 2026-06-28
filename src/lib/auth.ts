const TOKEN_KEY = 'video2_admin_token';

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setAdminToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function checkAuth(): Promise<{ enabled: boolean; authenticated: boolean }> {
  try {
    const token = getAdminToken();
    const res = await fetch('/api/video2/auth/check', {
      headers: token ? { 'x-admin-token': token } : {}
    });
    if (res.ok) {
      return await res.json();
    }
    return { enabled: false, authenticated: true };
  } catch {
    return { enabled: false, authenticated: true };
  }
}

export async function loginWithToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('/api/video2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        setAdminToken(token);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

const originalFetch = window.fetch.bind(window);

window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getAdminToken();
  if (token) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/video2/')) {
      init = init || {};
      init.headers = new Headers(init.headers);
      (init.headers as Headers).set('x-admin-token', token);
    }
  }
  return originalFetch(input, init);
};
