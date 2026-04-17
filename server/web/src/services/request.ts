interface ApiResponse<T> {
  dat: T;
  error?: string;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
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
