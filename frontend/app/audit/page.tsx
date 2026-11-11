"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import { api } from "../../lib/api";
import { isAuthenticated } from "../../lib/auth";
import { useRouter } from "next/navigation";

// Helper to make JSON details readable
function formatDetails(details: any) {
  if (!details) return <span style={{ color: "#94a3b8" }}>—</span>;
  
  // If it's a simple key-value object, display it cleanly
  if (typeof details === "object" && !Array.isArray(details)) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {Object.entries(details).map(([key, value]) => (
          <span key={key} style={styles.detailBadge}>
            <span style={{ color: "#64748b", marginRight: 4 }}>{key}:</span>
            {typeof value === "object" ? JSON.stringify(value) : String(value)}
          </span>
        ))}
      </div>
    );
  }
  
  // Fallback for strings/arrays
  return <span style={{ fontFamily: "monospace", fontSize: 12 }}>{JSON.stringify(details)}</span>;
}

// Helper to color-code the actions
function getActionStyle(action: string) {
  if (action.includes("created") || action.includes("imported") || action.includes("started") || action.includes("resumed")) 
    return { bg: "#dcfce7", color: "#166534" }; // Green
  if (action.includes("deleted") || action.includes("paused") || action.includes("failed")) 
    return { bg: "#fee2e2", color: "#991b1b" }; // Red
  if (action.includes("updated")) 
    return { bg: "#dbeafe", color: "#1e40af" }; // Blue
  return { bg: "#f1f5f9", color: "#475569" }; // Gray fallback
}

export default function AuditPage() {
  const router = useRouter();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) return router.replace("/login");
    api.audit()
      .then((res) => setLogs(res.items || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>Audit Log</h1>
            <p style={styles.sub}>Security events and system activity.</p>
          </div>
        </header>

        <div style={styles.card}>
          {loading ? (
            <div className="skeleton" style={{ height: 300 }} />
          ) : logs.length === 0 ? (
            <p style={{ color: "#64748b" }}>No audit logs found.</p>
          ) : (
            <div 
              style={{ 
                overflow: "auto", 
                maxHeight: "calc(100vh - 240px)", 
                border: "1px solid #e2e8f0", 
                borderRadius: 8 
              }}
            >
              <table style={styles.table}>
                <thead style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1, boxShadow: "0 1px 0 #e2e8f0" }}>
                  <tr>
                    <th style={styles.th}>Time</th>
                    <th style={styles.th}>Actor</th>
                    <th style={styles.th}>Action</th>
                    <th style={styles.th}>Entity</th>
                    <th style={styles.th}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const actionStyle = getActionStyle(log.action);
                    
                    return (
                      <tr key={log.id} style={styles.tr}>
                        <td style={{ ...styles.td, whiteSpace: "nowrap", color: "#64748b" }}>
                          {new Date(log.at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </td>
                        
                        <td style={{ ...styles.td, fontWeight: 500 }}>
                          {log.actor}
                        </td>
                        
                        <td style={styles.td}>
                          <span
                            style={{
                              ...styles.badge,
                              background: actionStyle.bg,
                              color: actionStyle.color,
                            }}
                          >
                            {log.action}
                          </span>
                        </td>
                        
                        <td style={styles.td}>
                          {log.entity_type} <span style={{ color: "#94a3b8" }}>#{log.entity_id || "—"}</span>
                        </td>
                        
                        <td style={styles.td}>
                          {formatDetails(log.details)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { marginBottom: 24 },
  title: { margin: 0, fontSize: 26, fontWeight: 700, color: "#0f172a" },
  sub: { margin: "4px 0 0", fontSize: 14, color: "#64748b" },
  card: { background: "#fff", borderRadius: 14, padding: 24, border: "1px solid #eef0f4", boxShadow: "0 1px 2px rgba(15,23,42,0.03)" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 14 },
  th: { padding: "12px 16px", color: "#64748b", fontWeight: 600, whiteSpace: "nowrap", background: "#f8fafc" },
  tr: { borderBottom: "1px solid #f1f5f9" },
  td: { padding: "16px", color: "#334155", verticalAlign: "top" },
  badge: { padding: "4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  detailBadge: { 
    display: "inline-block", 
    padding: "4px 8px", 
    background: "#f1f5f9", 
    border: "1px solid #e2e8f0", 
    borderRadius: 6, 
    fontSize: 12, 
    color: "#334155",
    fontFamily: "monospace"
  },
};