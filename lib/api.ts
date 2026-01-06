export interface NormalizedItem {
  doc_id: string;
  type: string;
  counterparty: string;
  project: string;
  expiry_date: string;
  amount: number;
  errors: string[];
  warnings: string[];
  source_index: number;
  is_valid: boolean;
}

export interface BatchResponse {
  batch_id: string;
  candidate_id: string;
  raw_items: unknown[];
  upstream_payload: unknown;
  normalized_items: NormalizedItem[];
  summary: {
    total_raw_items: number;
    normalized_items: number;
    duplicates_removed: string[];
    items_with_errors: number;
  };
}

export type CleanedItem = Pick<NormalizedItem, "doc_id" | "type" | "counterparty" | "project" | "expiry_date" | "amount">;

export interface ValidationResponse {
  cleaned_items: CleanedItem[];
  errors: string[];
}

interface SubmitPayload {
  candidate_name: string;
  batch_id: string;
  cleaned_items: CleanedItem[];
}

export interface SubmitResponse {
  payload: SubmitPayload;
  score_response: {
    score: number;
    message?: string;
    [key: string]: unknown;
  };
}

export class ApiError extends Error {
  retryAfterMs?: number;
  upstreamStatus?: number;

  constructor(message: string, retryAfterMs?: number, upstreamStatus?: number) {
    super(message);
    this.name = "ApiError";
    this.retryAfterMs = retryAfterMs;
    this.upstreamStatus = upstreamStatus;
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as {
        message?: string;
        detail?: string;
        retry_after_ms?: number;
        upstream_status?: number;
      };
      const message = `${response.status} ${response.statusText}: ${parsed.message ?? "Request failed"} - ${parsed.detail ?? text}`;
      throw new ApiError(message, parsed.retry_after_ms, parsed.upstream_status);
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(`${response.status} ${response.statusText}: ${text}`);
    }
  }

  const data = (await response.json()) as T;
  return data;
}

export async function fetchBatch(batch: string): Promise<BatchResponse> {
  return request<BatchResponse>(`/data/?batch=${encodeURIComponent(batch)}`);
}

export async function validateItems(items: NormalizedItem[]): Promise<ValidationResponse> {
  return request<ValidationResponse>("/validate/", {
    method: "POST",
    body: JSON.stringify({ items })
  });
}

export async function submitBatch(payload: SubmitPayload): Promise<SubmitResponse> {
  return request<SubmitResponse>("/submit/", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
