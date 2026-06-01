interface ApiResponse<T> {
  dat: T;
  error?: string;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.error || parsed.message || msg;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return (await res.text()) as unknown as T;
  }

  const json: ApiResponse<T> = await res.json();
  if (json.error) {
    throw new Error(json.error);
  }
  return json.dat;
}

export default request;
