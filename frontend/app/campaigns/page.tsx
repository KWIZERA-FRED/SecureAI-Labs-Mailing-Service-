"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import { api } from "../../lib/api";
import { isAuthenticated } from "../../lib/auth";
import { useRouter } from "next/navigation";

// Professional SVG Eye Icon
const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>
);

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [previewCampaign, setPreviewCampaign] = useState<any>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    api.campaigns()
      .then(setCampaigns)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [router]);

  async function handleCreate() {
    try {
      const newCamp = await api.createCampaign({
        name: "Untitled Campaign",
        subject: "New Subject",
        body: "Start typing your message here...",
        audience: "all",
      });
      window.location.href = `/campaigns/${newCamp.id}`;
    } catch (err) {
      alert("Failed to create campaign.");
    }
  }

  function handleRowClick(id: number) {
    window.location.href = `/campaigns/${id}`;
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>Campaigns</h1>
            <p style={styles.sub}>Manage your email campaigns and view their status.</p>
          </div>
          <button onClick={handleCreate} style={styles.primaryBtn}>
            + New Campaign
          </button>
        </header>

        <div style={styles.card}>
          {loading ? (
            <div className="skeleton" style={{ height: 200 }} />
          ) : campaigns.length === 0 ? (
            <p style={{ color: "#64748b" }}>No campaigns found. Click "New Campaign" to start.</p>
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
                    <th style={styles.th}>ID</th>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Status</th>
                    <th style={styles.th}>Sent</th>
                    <th style={styles.th}>Failed</th>
                    <th style={styles.th}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr
                      key={c.id}
                      style={{ ...styles.tr, cursor: "pointer" }}
                      onClick={() => handleRowClick(c.id)}
                    >
                      <td style={styles.td}>#{c.id}</td>
                      <td style={{ ...styles.td, fontWeight: 600 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {c.name || "Untitled"}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPreviewCampaign(c);
                            }}
                            style={styles.eyeBtn}
                            title="Preview Content"
                          >
                            <EyeIcon />
                          </button>
                        </div>
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            ...styles.badge,
                            background: c.status === "active" ? "#dcfce7" : c.status === "completed" ? "#e0e7ff" : "#f1f5f9",
                            color: c.status === "active" ? "#166534" : c.status === "completed" ? "#3730a3" : "#475569",
                          }}
                        >
                          {c.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={styles.td}>{c.sent_count || 0}</td>
                      <td style={styles.td}>{c.not_received_count || 0}</td>
                      <td style={styles.td}>{new Date(c.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {previewCampaign && (
        <div style={styles.modalOverlay} onClick={() => setPreviewCampaign(null)}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Campaign Preview</h2>
              <button onClick={() => setPreviewCampaign(null)} style={styles.closeBtn}>✕</button>
            </div>
            
            <div style={styles.modalBody}>
              <label style={styles.label}>Subject:</label>
              <div style={styles.previewBox}>
                {previewCampaign.subject || <span style={{color: "#94a3b8"}}>No subject</span>}
              </div>

              <label style={styles.label}>Body:</label>
              <div style={{...styles.previewBox, whiteSpace: "pre-wrap", minHeight: 150}}>
                {previewCampaign.body || <span style={{color: "#94a3b8"}}>No body content</span>}
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button onClick={() => setPreviewCampaign(null)} style={styles.secondaryBtn}>
                Close
              </button>
              <button 
                onClick={() => {
                  setPreviewCampaign(null);
                  window.location.href = `/campaigns/${previewCampaign.id}`;
                }} 
                style={styles.primaryBtnSmall}
              >
                Edit Campaign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24, flexWrap: "wrap", gap: 16 },
  title: { margin: 0, fontSize: 26, fontWeight: 700, color: "#0f172a" },
  sub: { margin: "4px 0 0", fontSize: 14, color: "#64748b" },
  card: { background: "#fff", borderRadius: 14, padding: 24, border: "1px solid #eef0f4", boxShadow: "0 1px 2px rgba(15,23,42,0.03)" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 14 },
  th: { padding: "12px 16px", color: "#64748b", fontWeight: 600, background: "#f8fafc" },
  tr: { borderBottom: "1px solid #f1f5f9", transition: "background 0.15s" },
  td: { padding: "16px", color: "#334155" },
  badge: { padding: "4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600 },
  primaryBtn: { padding: "10px 16px", background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(79,70,229,0.25)" },
  primaryBtnSmall: { padding: "8px 16px", background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  secondaryBtn: { padding: "8px 16px", background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  eyeBtn: { 
    background: "transparent", 
    border: "none", 
    cursor: "pointer", 
    color: "#64748b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 4, 
    borderRadius: 4,
    transition: "background 0.15s, color 0.15s" 
  },
  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 },
  modalContent: { background: "#fff", borderRadius: 16, width: "100%", maxWidth: 600, boxShadow: "0 20px 40px rgba(0,0,0,0.2)", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px", borderBottom: "1px solid #e2e8f0" },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" },
  closeBtn: { background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#64748b" },
  modalBody: { padding: "24px", maxHeight: "60vh", overflowY: "auto" },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 8, marginTop: 16 },
  previewBox: { padding: 16, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, color: "#0f172a", lineHeight: 1.6 },
  modalFooter: { padding: "16px 24px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: 12 },
};