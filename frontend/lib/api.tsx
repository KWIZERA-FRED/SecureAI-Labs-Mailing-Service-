const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("access_token");
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      localStorage.removeItem("access_token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    throw new ApiError("Unauthorized", 401);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(
      data?.detail || `Request failed (${res.status})`,
      res.status
    );
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    apiFetch<{ access_token: string; token_type: string }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  status: () => apiFetch<any>("/api/status"),

  sendBatch: () =>
    apiFetch<{
      sent_count: number;
      failed_count: number;
      remaining: number;
      sent_today: number;
      daily_limit: number;
      remaining_today: number;
      stopped_reason?: string;
    }>("/api/send-batch", { method: "POST" }),

  clients: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>(
        (acc, [k, v]) => ({ ...acc, [k]: String(v) }),
        {}
      )
    ).toString();
    return apiFetch<any>(`/api/clients${qs ? `?${qs}` : ""}`);
  },

  createClient: (data: { email: string; name?: string }) =>
    apiFetch<any>("/api/clients", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateClient: (id: number, data: { email?: string; name?: string; status?: string; confirm_resubscribe?: boolean }) =>
    apiFetch<any>(`/api/clients/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  importClients: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    
    // We use fetch directly here because we don't want to set Content-Type to application/json
    // Let the browser set the boundary for multipart/form-data
    const token = getToken();
    return fetch(`${API_URL}/api/import-clients`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data?.detail || "Import failed", res.status);
      return data;
    });
  },

  campaigns: () => apiFetch<any[]>("/api/campaigns"),

  createCampaign: (data: { name: string; subject: string; body: string; audience: string; recipient_ids?: number[] }) =>
    apiFetch<any>("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getCampaign: (id: number) => apiFetch<any>(`/api/campaigns/${id}`),

  updateCampaign: (id: number, data: { name: string; subject: string; body: string }) =>
    apiFetch<any>(`/api/campaigns/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  updateCampaignAudience: (id: number, data: { audience: string; recipient_ids?: number[] }) =>
    apiFetch<any>(`/api/campaigns/${id}/audience`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getDeliveries: (id: number, params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>(
        (acc, [k, v]) => ({ ...acc, [k]: String(v) }), {}
      )
    ).toString();
    return apiFetch<any>(`/api/campaigns/${id}/deliveries${qs ? `?${qs}` : ""}`);
  },

  previewCampaign: (id: number) => 
    apiFetch<{ subject: string; html: string; text: string }>(`/api/campaigns/${id}/preview`),

  startCampaign: (id: number) =>
    apiFetch(`/api/campaigns/${id}/start`, { method: "POST" }),

  pauseCampaign: (id: number) =>
    apiFetch(`/api/campaigns/${id}/pause`, { method: "POST" }),

  audit: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>(
        (acc, [k, v]) => ({ ...acc, [k]: String(v) }),
        {}
      )
    ).toString();
    return apiFetch<any>(`/api/audit${qs ? `?${qs}` : ""}`);
  },
};