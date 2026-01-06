"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  BatchResponse,
  NormalizedItem,
  SubmitResponse,
  ValidationResponse,
  fetchBatch,
  submitBatch,
  validateItems
} from "@/lib/api";
import { clsx } from "clsx";

const DEFAULT_BATCH = "1";
const DEFAULT_CANDIDATE_NAME = "Awsaf";
const FETCH_RETRY_LIMIT = 3;
const TABLE_SKELETON_ROWS = 4;

type FetchErrorState = {
  message: string;
  status?: number;
  retryAfterMs?: number;
  attempts: number;
};

export default function HomePage() {
  const queryClient = useQueryClient();
  const [batch, setBatch] = useState(DEFAULT_BATCH);
  const [candidateName, setCandidateName] = useState(DEFAULT_CANDIDATE_NAME);
  const [editedItems, setEditedItems] = useState<NormalizedItem[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<number, string[]>>({});
  const [globalErrors, setGlobalErrors] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [fetchErrorState, setFetchErrorState] = useState<FetchErrorState | null>(null);

  const batchQuery = useQuery<BatchResponse, Error>({
    queryKey: ["batch", batch],
    queryFn: () => fetchBatch(batch),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (failureCount, error) => {
      // Avoid hammering the backend when upstream is rate-limiting.
      if (error instanceof ApiError && error.upstreamStatus === 429) {
        return false;
      }
      return failureCount < FETCH_RETRY_LIMIT;
    },
    retryDelay: (failureCount, error) => {
      if (error instanceof ApiError && typeof error.retryAfterMs === "number") {
        return error.retryAfterMs + 300;
      }
      return Math.min(1000 * 2 ** failureCount, 4000);
    }
  });
  const queryError = batchQuery.error;
  const queryRefetch = batchQuery.refetch;

  const isLoading = batchQuery.isLoading || batchQuery.isFetching;
  const isDataLoading = batchQuery.isLoading && !batchQuery.data;
  const currentSummary = batchQuery.data?.summary;
  const serializedRawPayload = useMemo(() => {
    if (!batchQuery.data) {
      return "Awaiting data...";
    }
    const payload = batchQuery.data.upstream_payload ?? batchQuery.data.raw_items;
    return JSON.stringify(payload, null, 2);
  }, [batchQuery.data]);
  const skeletonRows = Array.from({ length: TABLE_SKELETON_ROWS }, (_, index) => index);
  const fetchRetryHint = (() => {
    if (!fetchErrorState) return null;
    if (fetchErrorState.status === 429 && fetchErrorState.retryAfterMs) {
      const seconds = Math.ceil(fetchErrorState.retryAfterMs / 1000);
      return `Upstream rate-limited. Please wait ~${seconds}s, then click Retry.`;
    }
    const nextAttempt = Math.min(fetchErrorState.attempts + 1, FETCH_RETRY_LIMIT);
    if (fetchErrorState.retryAfterMs && fetchErrorState.attempts < FETCH_RETRY_LIMIT) {
      const seconds = Math.ceil(fetchErrorState.retryAfterMs / 1000);
      return `Retrying in ${seconds}s - attempt ${nextAttempt}/${FETCH_RETRY_LIMIT}`;
    }
    if (fetchErrorState.attempts >= FETCH_RETRY_LIMIT) {
      return `Reached retry cap (${FETCH_RETRY_LIMIT})`;
    }
    return `Retry attempt ${nextAttempt}/${FETCH_RETRY_LIMIT}`;
  })();

  useEffect(() => {
    if (batchQuery.data) {
      setEditedItems(batchQuery.data.normalized_items.map(item => ({ ...item })));
      setRowErrors({});
      setGlobalErrors([]);
      setStatusMessage(null);
      setFetchErrorState(null);
    }
  }, [batchQuery.data]);

  useEffect(() => {
    if (!queryError) {
      setFetchErrorState(null);
      return;
    }

    const attempts = batchQuery.failureCount;
    const retryState: FetchErrorState = {
      message: queryError.message,
      status: queryError instanceof ApiError ? queryError.upstreamStatus : undefined,
      retryAfterMs: queryError instanceof ApiError ? queryError.retryAfterMs : undefined,
      attempts
    };
    setFetchErrorState(retryState);

    if (queryError instanceof ApiError && queryError.retryAfterMs) {
      const seconds = Math.ceil(queryError.retryAfterMs / 1000);
      setStatusMessage(`${queryError.message} (retry after ~${seconds}s)`);
    } else {
      setStatusMessage(queryError.message);
    }
  }, [queryError, batchQuery.failureCount]);

  const validateMutation = useMutation<ValidationResponse, Error, NormalizedItem[]>({
    mutationFn: items => validateItems(items),
    onSuccess: data => {
      setEditedItems(prev =>
        data.cleaned_items.map((item, index) => ({
          ...prev[index],
          ...item,
          errors: [],
          warnings: prev[index]?.warnings ?? [],
          source_index: prev[index]?.source_index ?? index,
          is_valid: true
        }))
      );
      setGlobalErrors(data.errors);
      setRowErrors(extractRowErrors(data.errors));
      if (data.errors.length === 0) {
        setStatusMessage("Validation succeeded. Ready to submit.");
      } else {
        setStatusMessage("Please fix the highlighted validation issues.");
      }
    },
    onError: error => {
      setStatusMessage(error.message);
    }
  });

  const submitMutation = useMutation<
    SubmitResponse,
    Error,
    { candidate_name: string; batch_id: string; cleaned_items: NormalizedItem[] }
  >({
    mutationFn: payload =>
      submitBatch({
        candidate_name: payload.candidate_name,
        batch_id: payload.batch_id,
        cleaned_items: payload.cleaned_items.map(item => ({
          doc_id: item.doc_id,
          type: item.type,
          counterparty: item.counterparty,
          project: item.project,
          expiry_date: item.expiry_date,
          amount: item.amount
        }))
      }),
    onSuccess: data => {
      setStatusMessage(`Submission successful! Score: ${data.score_response.score}`);
      queryClient.invalidateQueries({ queryKey: ["batch", batch] });
    },
    onError: error => {
      if (error instanceof ApiError && (error.upstreamStatus === 503 || error.upstreamStatus === 502)) {
        setStatusMessage("Submission failed: upstream service is temporarily unavailable. Please retry in a few seconds — the app will not lose your edits.");
      } else {
        setStatusMessage(`Submission failed: ${error.message}`);
      }
    }
  });

  const handleFieldChange = (index: number, field: keyof NormalizedItem, value: string) => {
    setEditedItems(items =>
      items.map((item, idx) => {
        if (idx !== index) return item;
        const next: NormalizedItem = { ...item };
        if (field === "doc_id") {
          next.doc_id = value;
        }
        if (field === "amount") {
          const numeric = Number(value);
          next.amount = Number.isNaN(numeric) ? 0 : numeric;
        } else if (field === "expiry_date") {
          next.expiry_date = value;
        } else if (field === "type") {
          next.type = value;
        } else if (field === "counterparty") {
          next.counterparty = value;
        } else if (field === "project") {
          next.project = value;
        }
        next.is_valid = true;
        return next;
      })
    );
    setRowErrors(prev => ({ ...prev, [index]: [] }));
  };

  const getFieldErrors = (
    index: number,
    field: keyof Pick<NormalizedItem, "doc_id" | "type" | "counterparty" | "project" | "expiry_date" | "amount">,
    baseErrors: string[] = []
  ) => {
    const errors = rowErrors[index] ?? baseErrors;
    const needle = String(field).replace(/_/g, " ").toLowerCase();
    return errors.filter(message => message.toLowerCase().includes(needle));
  };

  const handleValidate = () => {
    setStatusMessage("Validating...");
    validateMutation.mutate(editedItems);
  };

  const handleSubmit = () => {
    setStatusMessage("Submitting...");
    submitMutation.mutate({
      candidate_name: candidateName,
      batch_id: batchQuery.data?.batch_id ?? batch,
      cleaned_items: editedItems
    });
  };

  const disableSubmit = useMemo(() => {
    return (
      submitMutation.isPending ||
      validateMutation.isPending ||
      Object.values(rowErrors).some(errors => errors.length > 0) ||
      globalErrors.length > 0
      || Boolean(fetchErrorState)
    );
  }, [submitMutation.isPending, validateMutation.isPending, rowErrors, globalErrors, fetchErrorState]);

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 pb-10 pt-8">
      <header className="glass-card flex flex-col gap-5 rounded-2xl p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            <span className="pill">LumiCore Data Cleaner</span>
            <div>
              <h1 className="section-title text-3xl">Normalize, validate, and submit with confidence</h1>
              <p className="text-sm text-slate-600">
                Handle messy upstream payloads, keep visibility into retries, and ship clean documents for scoring.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Batch ID
              <input
                className="mt-1 w-full rounded-lg border border-slate-300/80 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                value={batch}
                onChange={event => setBatch(event.target.value)}
              />
            </label>
            <button
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-[1px] hover:shadow-md disabled:cursor-not-allowed disabled:bg-slate-400"
              onClick={() => batchQuery.refetch()}
              disabled={isLoading}
            >
              {isLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Candidate Name
            <input
              className="mt-1 w-full rounded-lg border border-slate-300/80 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
              value={candidateName}
              onChange={event => setCandidateName(event.target.value)}
            />
          </label>
          <div className="text-sm text-slate-600">
            Candidate ID: <span className="font-mono text-slate-900">{batchQuery.data?.candidate_id ?? "-"}</span>
          </div>
        </div>
        {currentSummary && (
          <ul className="grid grid-cols-2 gap-4 text-sm text-slate-700 md:grid-cols-4">
            <li className="glass-card rounded-xl p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Raw Records</p>
              <p className="text-xl font-semibold text-slate-900">{currentSummary.total_raw_items}</p>
            </li>
            <li className="glass-card rounded-xl p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Normalized Records</p>
              <p className="text-xl font-semibold text-slate-900">{currentSummary.normalized_items}</p>
            </li>
            <li className="glass-card rounded-xl p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Duplicates Removed</p>
              <p className="text-xl font-semibold text-slate-900">{currentSummary.duplicates_removed.length}</p>
            </li>
            <li className="glass-card rounded-xl p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Items With Errors</p>
              <p className="text-xl font-semibold text-slate-900">{currentSummary.items_with_errors}</p>
            </li>
          </ul>
        )}
      </header>

      {statusMessage && (
        <div className="glass-card rounded-xl border border-amber-200/70 bg-amber-50/70 p-4 text-sm text-amber-900">
          {statusMessage}
        </div>
      )}

      {fetchErrorState && (
        <div className="glass-card rounded-xl border border-red-200/70 bg-red-50/80 p-4 text-sm text-red-800">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="font-semibold text-red-800">Unable to load batch data</p>
              <p>{fetchErrorState.message}</p>
              {fetchErrorState.status && (
                <p className="text-xs uppercase tracking-wide text-red-700">Upstream status: {fetchErrorState.status}</p>
              )}
              {fetchRetryHint && <p className="text-xs text-slate-700">{fetchRetryHint}</p>}
            </div>
            <div className="flex flex-row items-center gap-2">
              <button
                className="rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 shadow-sm transition hover:-translate-y-[1px] hover:border-red-400 hover:shadow disabled:cursor-not-allowed disabled:border-red-200"
                onClick={() => queryRefetch()}
                disabled={isLoading}
              >
                {isLoading ? "Retrying..." : "Retry now"}
              </button>
              <button
                className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow disabled:cursor-not-allowed"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["batch", batch] })}
                disabled={isLoading}
              >
                Reset cache
              </button>
            </div>
          </div>
        </div>
      )}

      {globalErrors.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">Validation Errors</p>
          <ul className="list-outside list-disc pl-5">
            {globalErrors.map(error => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="grid gap-6 md:grid-cols-2">
        <article className="glass-card rounded-2xl p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Raw Upstream Data</h2>
              <p className="text-xs text-slate-500">Full JSON payload from the external API</p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase text-slate-600">Read only</span>
          </div>
          <div className="rounded border border-slate-800/20 bg-slate-950/80 p-2">
            {isDataLoading ? (
              <div className="flex h-64 items-center justify-center rounded bg-slate-900/40 text-xs text-slate-400">
                Awaiting upstream payload...
              </div>
            ) : (
              <pre className="max-h-[440px] overflow-auto rounded bg-slate-900 p-4 text-xs text-slate-100">
                {serializedRawPayload}
              </pre>
            )}
          </div>
        </article>

        <article className="glass-card rounded-2xl p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Normalized Records</h2>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase text-emerald-700">Inline editable</span>
          </div>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
              <thead>
                <tr className="bg-slate-100/80 text-left text-xs font-semibold uppercase text-slate-600">
                  <th className="px-3 py-2">Doc ID</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Counterparty</th>
                  <th className="px-3 py-2">Project</th>
                  <th className="px-3 py-2">Expiry Date</th>
                  <th className="px-3 py-2">Amount (AED)</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Quality</th>
                </tr>
              </thead>
              <tbody>
                {isDataLoading
                  ? skeletonRows.map(row => (
                      <tr key={`skeleton-${row}`} className="border-b border-slate-200 last:border-0">
                        <td colSpan={8} className="px-3 py-4">
                          <div className="h-5 w-full animate-pulse rounded bg-slate-200" />
                        </td>
                      </tr>
                    ))
                  : editedItems.map((item, index) => {
                      const baseErrors = item.errors ?? [];
                      const docIdErrors = getFieldErrors(index, "doc_id", baseErrors);
                      const typeErrors = getFieldErrors(index, "type", baseErrors);
                      const counterpartyErrors = getFieldErrors(index, "counterparty", baseErrors);
                      const projectErrors = getFieldErrors(index, "project", baseErrors);
                      const expiryErrors = getFieldErrors(index, "expiry_date", baseErrors);
                      const amountErrors = getFieldErrors(index, "amount", baseErrors);
                      const rowIssueCount = (rowErrors[index]?.length ?? 0) + baseErrors.length;
                      const rowHasIssues = rowIssueCount > 0;
                      const statusLabel = rowHasIssues ? "Needs attention" : "Clean";
                      return (
                        <tr
                          key={item.doc_id ?? index}
                          className={clsx("border-b border-slate-200/70 last:border-0", rowHasIssues && "bg-red-50/50")}
                        >
                          <td className="px-3 py-2">
                            <input
                              className={clsx(
                                "w-full rounded border px-2 py-1 font-mono text-xs focus:border-slate-500 focus:outline-none",
                                docIdErrors.length > 0 ? "border-red-400 bg-red-50" : "border-slate-300"
                              )}
                              value={item.doc_id}
                              onChange={event => handleFieldChange(index, "doc_id", event.target.value)}
                              placeholder="DOC-1001"
                            />
                            {docIdErrors[0] && <p className="mt-1 text-[11px] text-red-600">{docIdErrors[0]}</p>}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className={clsx(
                                "w-full rounded border px-2 py-1 focus:border-slate-500 focus:outline-none",
                                typeErrors.length > 0 ? "border-red-400 bg-red-50" : "border-slate-300"
                              )}
                              value={item.type}
                              onChange={event => handleFieldChange(index, "type", event.target.value)}
                            />
                            {typeErrors[0] && <p className="mt-1 text-[11px] text-red-600">{typeErrors[0]}</p>}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className={clsx(
                                "w-full rounded border px-2 py-1 focus:border-slate-500 focus:outline-none",
                                counterpartyErrors.length > 0 ? "border-red-400 bg-red-50" : "border-slate-300"
                              )}
                              value={item.counterparty}
                              onChange={event => handleFieldChange(index, "counterparty", event.target.value)}
                            />
                            {counterpartyErrors[0] && (
                              <p className="mt-1 text-[11px] text-red-600">{counterpartyErrors[0]}</p>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className={clsx(
                                "w-full rounded border px-2 py-1 focus:border-slate-500 focus:outline-none",
                                projectErrors.length > 0 ? "border-red-400 bg-red-50" : "border-slate-300"
                              )}
                              value={item.project}
                              onChange={event => handleFieldChange(index, "project", event.target.value)}
                            />
                            {projectErrors[0] && <p className="mt-1 text-[11px] text-red-600">{projectErrors[0]}</p>}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className={clsx(
                                "w-full rounded border px-2 py-1 focus:border-slate-500 focus:outline-none",
                                expiryErrors.length > 0 ? "border-red-400 bg-red-50" : "border-slate-300"
                              )}
                              value={item.expiry_date}
                              onChange={event => handleFieldChange(index, "expiry_date", event.target.value)}
                              placeholder="YYYY-MM-DD"
                            />
                            {expiryErrors[0] && <p className="mt-1 text-[11px] text-red-600">{expiryErrors[0]}</p>}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className={clsx(
                                "w-full rounded border px-2 py-1 focus:border-slate-500 focus:outline-none",
                                amountErrors.length > 0 ? "border-red-400 bg-red-50" : "border-slate-300"
                              )}
                              type="number"
                              value={item.amount}
                              onChange={event => handleFieldChange(index, "amount", event.target.value)}
                              step="0.01"
                              min="0"
                            />
                            {amountErrors[0] && <p className="mt-1 text-[11px] text-red-600">{amountErrors[0]}</p>}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={clsx(
                                "inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold",
                                rowHasIssues ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
                              )}
                            >
                              {statusLabel}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <QualityBadge warnings={item.warnings} errors={rowErrors[index] ?? baseErrors} />
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <footer className="sticky bottom-0 flex flex-col gap-3 rounded-lg bg-white p-4 shadow md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <button
            className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600 disabled:cursor-not-allowed disabled:bg-slate-400"
            onClick={handleValidate}
            disabled={validateMutation.isPending || isLoading}
          >
            {validateMutation.isPending ? "Validating..." : "Validate"}
          </button>
          <button
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300"
            onClick={handleSubmit}
            disabled={disableSubmit || isLoading}
          >
            {submitMutation.isPending ? "Submitting..." : "Submit"}
          </button>
        </div>
        {submitMutation.data && (
          <div className="text-sm text-emerald-700">
            Upstream score: {submitMutation.data.score_response.score}
          </div>
        )}
      </footer>
      {submitMutation.data && (
        <article className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 shadow">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-emerald-700">Last submit</p>
                <h3 className="text-lg font-semibold text-emerald-900">Score {submitMutation.data.score_response.score}</h3>
              </div>
              <span className="text-xs font-semibold text-emerald-800">Batch {submitMutation.data.payload.batch_id}</span>
            </div>
            {submitMutation.data.score_response.message && (
              <p className="text-sm text-emerald-800">{submitMutation.data.score_response.message}</p>
            )}
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-white/80 p-3 text-xs text-emerald-900">
              {JSON.stringify(submitMutation.data.score_response, null, 2)}
            </pre>
          </div>
        </article>
      )}
    </main>
  );
}

function extractRowErrors(errors: string[]): Record<number, string[]> {
  const map: Record<number, string[]> = {};
  const pattern = /Item (\d+): (.*)/;
  errors.forEach(message => {
    const match = message.match(pattern);
    if (!match) return;
    const index = Number.parseInt(match[1], 10);
    const detail = match[2];
    if (!map[index]) {
      map[index] = [];
    }
    map[index].push(detail);
  });
  return map;
}

function QualityBadge({ warnings, errors }: { warnings: string[]; errors: string[] }) {
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;
  const label = hasErrors ? `${errors.length} issues` : hasWarnings ? `${warnings.length} warnings` : "Clean";

  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-1 text-xs font-medium",
        hasErrors && "bg-red-100 text-red-700",
        !hasErrors && hasWarnings && "bg-amber-100 text-amber-700",
        !hasErrors && !hasWarnings && "bg-emerald-100 text-emerald-700"
      )}
    >
      {label}
    </span>
  );
}
