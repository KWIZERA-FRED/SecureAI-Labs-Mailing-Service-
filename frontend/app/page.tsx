"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../lib/api";
import { isAuthenticated } from "../lib/auth";
import { Sidebar } from "./components/Sidebar";

type CampaignStats = {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  not_received: number;
};

type StatusResponse = {
  total: number;
  active_clients: number;
  unsubscribed: number;
  daily_limit: number;
  sent_today: number;
  remaining_today: number;
  sent: number;
  remaining: number;
  failed: number;
  estimated_days_left?: number;
  campaign: {
    id: number;
    name: string;
    status: string;
    stats: CampaignStats;
  } | null;
};

// SVG Icon for the Refresh Button
const RefreshIcon = ({ spinning }: { spinning: boolean }) => (
  <svg 
    width="16" 
    height="16" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    style={{ 
      animation: spinning ? "spin 1s linear infinite" : "none",
      marginRight: 6
    }}
  >
    <path d="M23 4v6h-6"></path>
    <path d="M1 20v-6h6"></path>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
);

export default function DashboardPage() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null
  );

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    refresh();
    const interval = setInterval(() => {
      refreshSilently();
    }, 15000);
    return () => clearInterval(interval);
  }, [router]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      const data = await api.status();
      setStatus(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(
        err instanceof Error ? err.message : "Failed to load dashboard."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshSilently = useCallback(async () => {
    try {
      const data = await api.status();
      setStatus(data);
    } catch {
      /* silent */
    }
  }, []);

  function showToast(kind: "ok" | "err", msg: string) {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 4000);
  }

  async function handleCampaignAction(action: "start" | "pause") {
    if (!status?.campaign) return;
    setCampaignBusy(true);
    try {
      if (action === "start") {
        await api.startCampaign(status.campaign.id);
        showToast("ok", "Campaign started.");
      } else {
        await api.pauseCampaign(status.campaign.id);
        showToast("ok", "Campaign paused.");
      }
      await refreshSilently();
    } catch (err) {
      showToast(
        "err",
        err instanceof Error ? err.message : "Action failed."
      );
    } finally {
      setCampaignBusy(false);
    }
  }

  const campaign = status?.campaign;
  const stats = campaign?.stats;
  const progressPct = useMemo(() => {
    if (!stats || stats.total === 0) return 0;
    return Math.round((stats.sent / stats.total) * 100);
  }, [stats]);

  const dailyPct = useMemo(() => {
    if (!status || status.daily_limit === 0) return 0;
    return Math.min(
      100,
      Math.round((status.sent_today / status.daily_limit) * 100)
    );
  }, [status]);

  if (loading) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            <div className="skeleton" style={{ height: 32, width: 260, marginBottom: 24 }} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                gap: 16,
              }}
            >
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" style={{ height: 110 }} />
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div
            style={{
              maxWidth: 560,
              margin: "80px auto",
              background: "#fff",
              padding: 32,
              borderRadius: 16,
              border: "1px solid #e2e8f0",
              textAlign: "center",
            }}
          >
            <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
            <p style={{ color: "#64748b" }}>{error}</p>
            <button onClick={refresh} style={styles.primaryBtn}>
              Try again
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />

      <main className="app-main">
        <header style={styles.topbar}>
          <div>
            <h1 style={styles.pageTitle}>Overview</h1>
            <p style={styles.pageSub}>
              Daily sending activity and campaign progress.
            </p>
          </div>
          <div style={styles.topbarActions}>
            <button
              onClick={refresh}
              style={{
                ...styles.secondaryBtn,
                display: "flex",
                alignItems: "center",
                opacity: refreshing ? 0.7 : 1,
                cursor: refreshing ? "wait" : "pointer"
              }}
              disabled={refreshing}
            >
              <RefreshIcon spinning={refreshing} />
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </header>

        <section style={styles.grid}>
          <StatCard
            label="Total recipients"
            value={status?.total ?? 0}
            hint={`${status?.active_clients ?? 0} active · ${
              status?.unsubscribed ?? 0
            } unsubscribed`}
            accent="#6366f1"
          />
          <StatCard
            label="Sent today"
            value={`${status?.sent_today ?? 0} / ${status?.daily_limit ?? 0}`}
            hint={`${status?.remaining_today ?? 0} left today`}
            accent="#10b981"
            progress={dailyPct}
          />
          <StatCard
            label="Campaign sent"
            value={status?.sent ?? 0}
            hint={
              status?.failed
                ? `${status.failed} failed`
                : "No failures"
            }
            accent="#3b82f6"
          />
          <StatCard
            label="Pending queue"
            value={status?.remaining ?? 0}
            hint={
              status?.estimated_days_left
                ? `~${status.estimated_days_left} day(s) at daily cap`
                : "Nothing queued"
            }
            accent="#f59e0b"
          />
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <h2 style={styles.cardTitle}>Current campaign</h2>
              <p style={styles.cardSub}>
                {campaign
                  ? `${campaign.name} · ${campaign.status}`
                  : "No campaign configured yet."}
              </p>
            </div>
            {campaign && (
              <div style={styles.cardActions}>
                {campaign.status === "active" ? (
                  <button
                    onClick={() => handleCampaignAction("pause")}
                    disabled={campaignBusy}
                    style={styles.secondaryBtn}
                  >
                    Pause
                  </button>
                ) : (
                  <button
                    onClick={() => handleCampaignAction("start")}
                    disabled={
                      campaignBusy ||
                      !["draft", "paused", "completed"].includes(
                        campaign.status
                      )
                    }
                    style={styles.primaryBtn}
                  >
                    {campaign.status === "paused" ? "Resume" : "Start"}
                  </button>
                )}
              </div>
            )}
          </div>

          {campaign && stats ? (
            <>
              <div style={styles.progressWrap}>
                <div style={styles.progressTrack}>
                  <div
                    style={{
                      ...styles.progressFill,
                      width: `${progressPct}%`,
                    }}
                  />
                </div>
                <div style={styles.progressMeta}>
                  <span>
                    {stats.sent} of {stats.total} sent ({progressPct}%)
                  </span>
                  <span>
                    {stats.pending} pending · {stats.failed} failed ·{" "}
                    {stats.skipped} skipped
                  </span>
                </div>
              </div>

              <div style={styles.miniGrid}>
                <MiniStat label="Pending" value={stats.pending} color="#f59e0b" />
                <MiniStat label="Sending" value={stats.sending} color="#6366f1" />
                <MiniStat label="Sent" value={stats.sent} color="#10b981" />
                <MiniStat label="Failed" value={stats.failed} color="#ef4444" />
                <MiniStat label="Skipped" value={stats.skipped} color="#94a3b8" />
              </div>
            </>
          ) : (
            <div style={styles.emptyBox}>
              <p style={{ margin: 0, color: "#64748b" }}>
                Create your first campaign from the API or add data to get
                started.
              </p>
            </div>
          )}
        </section>
      </main>

      {toast && (
        <div
          className="fade-in"
          style={{
            ...styles.toast,
            background: toast.kind === "ok" ? "#065f46" : "#991b1b",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
  progress,
}: {
  label: string;
  value: number | string;
  hint: string;
  accent: string;
  progress?: number;
}) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
      <div style={styles.statHint}>{hint}</div>
      {typeof progress === "number" && (
        <div style={{ ...styles.progressTrack, marginTop: 12 }}>
          <div
            style={{
              ...styles.progressFill,
              width: `${progress}%`,
              background: accent,
            }}
          />
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: accent,
          borderTopLeftRadius: 14,
          borderBottomLeftRadius: 14,
        }}
      />
    </div>
  );
}

function MiniStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div style={styles.miniStat}>
      <div style={{ ...styles.miniDot, background: color }} />
      <div>
        <div style={styles.miniValue}>{value}</div>
        <div style={styles.miniLabel}>{label}</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 16,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  pageTitle: {
    margin: 0,
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: "#0f172a",
  },
  pageSub: {
    margin: "4px 0 0",
    fontSize: 14,
    color: "#64748b",
  },
  topbarActions: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  primaryBtn: {
    padding: "10px 16px",
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(79,70,229,0.25)",
  },
  secondaryBtn: {
    padding: "10px 16px",
    background: "#fff",
    color: "#334155",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16,
    marginBottom: 24,
  },
  statCard: {
    position: "relative",
    background: "#fff",
    borderRadius: 14,
    padding: "20px 20px 18px 22px",
    border: "1px solid #eef0f4",
    boxShadow: "0 1px 2px rgba(15,23,42,0.03)",
    overflow: "hidden",
  },
  statLabel: {
    fontSize: 13,
    color: "#64748b",
    fontWeight: 500,
  },
  statValue: {
    fontSize: 28,
    fontWeight: 700,
    color: "#0f172a",
    margin: "6px 0 4px",
    letterSpacing: "-0.02em",
  },
  statHint: {
    fontSize: 12,
    color: "#94a3b8",
  },
  card: {
    background: "#fff",
    borderRadius: 14,
    padding: 24,
    border: "1px solid #eef0f4",
    boxShadow: "0 1px 2px rgba(15,23,42,0.03)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 20,
    flexWrap: "wrap",
  },
  cardTitle: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: "#0f172a",
  },
  cardSub: {
    margin: "4px 0 0",
    fontSize: 13,
    color: "#64748b",
  },
  cardActions: {
    display: "flex",
    gap: 8,
  },
  progressWrap: {
    marginBottom: 20,
  },
  progressTrack: {
    width: "100%",
    height: 8,
    background: "#eef0f4",
    borderRadius: 99,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #6366f1, #4f46e5)",
    borderRadius: 99,
    transition: "width .5s ease",
  },
  progressMeta: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 8,
    fontSize: 12,
    color: "#64748b",
    flexWrap: "wrap",
    gap: 8,
  },
  miniGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 12,
  },
  miniStat: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: "#f8fafc",
    borderRadius: 10,
    border: "1px solid #eef0f4",
  },
  miniDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  miniValue: {
    fontSize: 16,
    fontWeight: 700,
    color: "#0f172a",
    lineHeight: 1.1,
  },
  miniLabel: {
    fontSize: 11,
    color: "#64748b",
    marginTop: 2,
  },
  emptyBox: {
    padding: 20,
    background: "#f8fafc",
    borderRadius: 10,
    border: "1px dashed #cbd5e1",
    textAlign: "center",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    right: 24,
    color: "#fff",
    padding: "12px 18px",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 500,
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
    maxWidth: 380,
    zIndex: 1000,
  },
};