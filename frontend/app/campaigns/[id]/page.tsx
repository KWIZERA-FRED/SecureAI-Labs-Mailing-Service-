"use client";

import { Suspense, useEffect, useState } from "react";
import { Sidebar } from "../../components/Sidebar";
import { api } from "../../../lib/api";
import { isAuthenticated } from "../../../lib/auth";
import { useRouter, useParams } from "next/navigation";

function CampaignDetailContent() {
  const router = useRouter();
  const params = useParams();
  
  const campaignId = params?.id ? Number(params.id) : null;

  const [campaign, setCampaign] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  
  // Audience State
  const [audienceMode, setAudienceMode] = useState<"all" | "selected" | "none">("none");
  const [selectedClients, setSelectedClients] = useState<number[]>([]);
  const [activeClients, setActiveClients] = useState<any[]>([]);
  
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"compose" | "preview" | "history">("compose");
  const [previewHtml, setPreviewHtml] = useState("");

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    if (!campaignId || isNaN(campaignId)) {
      setError("Invalid Campaign ID.");
      setLoading(false);
      return;
    }

    async function load() {
      try {
        const [campData, clientsData] = await Promise.all([
          api.getCampaign(campaignId!),
          api.clients({ status: "active", per_page: 200 })
        ]);

        setCampaign(campData);
        setName(campData.name || "");
        setSubject(campData.subject === "New Subject" ? "" : campData.subject || "");
        setBody(campData.body === "Start typing your message here..." ? "" : campData.body || "");
        setActiveClients(clientsData.items || []);

        // Determine initial audience mode based on backend data
        if (campData.recipient_ids && campData.recipient_ids.length > 0) {
          setAudienceMode("selected");
          setSelectedClients(campData.recipient_ids);
        } else if (campData.audience === "all") {
          setAudienceMode("all");
          setSelectedClients([]);
        } else {
          setAudienceMode("none");
          setSelectedClients([]);
        }

        if (campData.status !== "draft") {
          setActiveTab("history");
        }
      } catch (err: any) {
        console.error("Campaign Load Error:", err);
        setError(err.message || "Failed to load campaign.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [campaignId, router]);

  useEffect(() => {
    if (activeTab === "history" && campaignId && !isNaN(campaignId)) {
      api.getDeliveries(campaignId)
        .then(res => setDeliveries(res.items || []))
        .catch(err => console.error("Failed to load deliveries:", err));
    }
  }, [activeTab, campaignId]);

  useEffect(() => {
    if (activeTab === "preview") {
      api.updateCampaign(campaignId!, { name, subject, body })
        .then(() => api.previewCampaign(campaignId!))
        .then(res => setPreviewHtml(res.html))
        .catch(err => console.error("Failed to load preview:", err));
    }
  }, [activeTab, campaignId, name, subject, body]);

  async function handleSaveAndStart() {
    if (!campaignId) return;
    setSaving(true);
    setError("");
    try {
      if (!name.trim()) throw new Error("Campaign Name is required.");
      if (!subject.trim()) throw new Error("Email Subject is required.");
      if (!body.trim()) throw new Error("Email Body is required.");
      
      if (audienceMode === "selected" && selectedClients.length === 0) {
        throw new Error("Please select at least one recipient or change audience mode.");
      }
      if (audienceMode === "none") {
        throw new Error("Please select an audience mode before starting.");
      }

      await api.updateCampaign(campaignId, { name, subject, body });
      
      // Using a mapping object so TypeScript doesn't complain about unreachable switch cases
      const audiencePayload = {
        all: { audience: "all" as const, recipient_ids: undefined },
        selected: { audience: "selected" as const, recipient_ids: selectedClients },
        none: { audience: "selected" as const, recipient_ids: [] }
      }[audienceMode as "all" | "selected" | "none"];

      await api.updateCampaignAudience(campaignId, audiencePayload);

      await api.startCampaign(campaignId);
      
      const updated = await api.getCampaign(campaignId);
      setCampaign(updated);
      setActiveTab("history");
    } catch (err: any) {
      setError(err.message || "Failed to save and start campaign.");
    } finally {
      setSaving(false);
    }
  }

  function toggleClient(id: number) {
    setSelectedClients(prev => 
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  }

  function handleAudienceChange(mode: "all" | "selected" | "none") {
    setAudienceMode(mode);
    if (mode === "none") {
      setSelectedClients([]); // Clear selection when switching to none
    }
  }

  if (loading) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="skeleton" style={{ height: 400, borderRadius: 14 }} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <header style={styles.header}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1 style={styles.title}>{campaign?.name || "Untitled Campaign"}</h1>
              {campaign && <span style={styles.badge}>{campaign.status.toUpperCase()}</span>}
            </div>
            <p style={styles.sub}>Campaign #{campaignId}</p>
          </div>
          <button onClick={() => window.location.href = "/campaigns"} style={styles.secondaryBtn}>
            Back to List
          </button>
        </header>

        {error && (
          <div style={styles.error}>
            <strong>Error:</strong> {error}
          </div>
        )}

        {!campaign && !error && (
          <div style={styles.card}>
            <p>Campaign not found. Please return to the campaigns list.</p>
          </div>
        )}

        {campaign && (
          <>
            <div style={styles.tabs}>
              <button 
                style={activeTab === "compose" ? styles.tabActive : styles.tab} 
                onClick={() => setActiveTab("compose")}
                disabled={campaign.status !== "draft"}
              >
                Compose
              </button>
              
              {campaign.status === "draft" && (
                <button 
                  style={activeTab === "preview" ? styles.tabActive : styles.tab} 
                  onClick={() => setActiveTab("preview")}
                >
                  Preview
                </button>
              )}

              <button 
                style={activeTab === "history" ? styles.tabActive : styles.tab} 
                onClick={() => setActiveTab("history")}
              >
                Delivery History
              </button>
            </div>

            {activeTab === "compose" && campaign.status === "draft" && (
              <div style={styles.grid}>
                <div style={styles.card}>
                  <h2 style={styles.cardTitle}>Email Content</h2>
                  
                  <label style={styles.label}>Internal Campaign Name</label>
                  <input 
                    value={name} 
                    onChange={e => setName(e.target.value)} 
                    style={styles.input} 
                    placeholder="e.g. Q4 Newsletter"
                  />
                  
                  <label style={styles.label}>Email Subject</label>
                  <input 
                    value={subject} 
                    onChange={e => setSubject(e.target.value)} 
                    style={styles.input} 
                    placeholder="e.g. Important updates from our team"
                  />
                  
                  <label style={styles.label}>Email Body</label>
                  <textarea 
                    value={body} 
                    onChange={e => setBody(e.target.value)} 
                    style={{ ...styles.input, minHeight: 200, fontFamily: "inherit", resize: "vertical" }} 
                    placeholder="Type your message here... You can use {{name}} to greet them personally."
                  />
                  <p style={styles.hint}>
                    Tip: Use <code>{"{{name}}"}</code> anywhere in the body to insert the recipient's first name.
                  </p>
                </div>

                <div style={styles.card}>
                  <h2 style={styles.cardTitle}>Recipients</h2>
                  
                  <div style={styles.radioGroup}>
                    <label style={styles.radioLabel}>
                      <input 
                        type="radio" 
                        checked={audienceMode === "all"} 
                        onChange={() => handleAudienceChange("all")} 
                      />
                      All Active Recipients ({activeClients.length})
                    </label>
                    <label style={styles.radioLabel}>
                      <input 
                        type="radio" 
                        checked={audienceMode === "selected"} 
                        onChange={() => handleAudienceChange("selected")} 
                      />
                      Selected Recipients ({selectedClients.length})
                    </label>
                    <label style={styles.radioLabel}>
                      <input 
                        type="radio" 
                        checked={audienceMode === "none"} 
                        onChange={() => handleAudienceChange("none")} 
                      />
                      Manual Selection (None initially)
                    </label>
                  </div>

                  {/* Show the list only if 'selected' or 'none' mode is active */}
                  {(audienceMode === "selected" || audienceMode === "none") && (
                    <div style={styles.clientList}>
                      {activeClients.length === 0 ? (
                        <p style={{ fontSize: 13, color: "#64748b" }}>No active clients found.</p>
                      ) : activeClients.map(client => (
                        <label key={client.id} style={styles.clientItem}>
                          <input 
                            type="checkbox" 
                            checked={selectedClients.includes(client.id)}
                            onChange={() => toggleClient(client.id)}
                          />
                          <span style={{ marginLeft: 8 }}>
                            {client.name || "No name"} <span style={{ color: "#64748b" }}>({client.email})</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}

                  <div style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid #e2e8f0" }}>
                    <button 
                      onClick={handleSaveAndStart} 
                      disabled={saving}
                      style={{...styles.primaryBtn, opacity: saving ? 0.7 : 1}}
                    >
                      {saving ? "Starting..." : "Save & Start Campaign"}
                    </button>
                    <p style={styles.hint}>Once started, the audience and content are locked.</p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "preview" && (
              <div style={styles.card}>
                <h2 style={styles.cardTitle}>Email Preview</h2>
                <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
                  This is how the email will look to a recipient named <strong>Alex</strong>.
                </p>
                {previewHtml ? (
                  <div 
                    style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 24, background: "#f8fafc" }}
                    dangerouslySetInnerHTML={{ __html: previewHtml }} 
                  />
                ) : (
                  <div className="skeleton" style={{ height: 200 }} />
                )}
              </div>
            )}

            {activeTab === "history" && (
              <div style={styles.card}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
                  <div>
                    <h2 style={styles.cardTitle}>Delivery History</h2>
                    <p style={styles.sub}>
                      {campaign.stats?.sent || 0} of {campaign.stats?.total || 0} Sent 
                      ({campaign.stats?.total > 0 ? Math.round((campaign.stats.sent / campaign.stats.total) * 100) : 0}%)
                    </p>
                  </div>
                  {campaign.status === "active" && (
                    <button onClick={() => api.pauseCampaign(campaignId!).then(() => window.location.reload())} style={styles.secondaryBtn}>
                      Pause Sending
                    </button>
                  )}
                </div>

                <div 
                  style={{ 
                    overflow: "auto", 
                    maxHeight: "calc(100vh - 320px)", 
                    border: "1px solid #e2e8f0", 
                    borderRadius: 8 
                  }}
                >
                  <table style={styles.table}>
                    <thead style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1, boxShadow: "0 1px 0 #e2e8f0" }}>
                      <tr>
                        <th style={styles.th}>Recipient</th>
                        <th style={styles.th}>Status</th>
                        <th style={styles.th}>Attempts</th>
                        <th style={styles.th}>Sent At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{...styles.td, textAlign: "center", color: "#64748b"}}>
                            No deliveries generated yet.
                          </td>
                        </tr>
                      ) : deliveries.map((d) => (
                        <tr key={d.id} style={styles.tr}>
                          <td style={styles.td}>
                            <div style={{ fontWeight: 500 }}>{d.name || "—"}</div>
                            <div style={{ fontSize: 12, color: "#64748b" }}>{d.email}</div>
                          </td>
                          <td style={styles.td}>
                            <span style={{
                              ...styles.badge,
                              background: 
                                d.status === "sent" ? "#dcfce7" : 
                                d.status === "failed" ? "#fee2e2" : 
                                d.status === "pending" ? "#fef9c3" : 
                                d.status === "sending" ? "#dbeafe" : "#f1f5f9",
                              color: 
                                d.status === "sent" ? "#166534" : 
                                d.status === "failed" ? "#991b1b" : 
                                d.status === "pending" ? "#854d0e" : 
                                d.status === "sending" ? "#1e40af" : "#475569",
                            }}>
                              {d.status.toUpperCase()}
                            </span>
                            {d.last_error && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>{d.last_error}</div>}
                          </td>
                          <td style={styles.td}>{d.attempts}</td>
                          <td style={styles.td}>{d.sent_at ? new Date(d.sent_at).toLocaleString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default function CampaignDetailPage() {
  return (
    <Suspense fallback={<div className="app-shell"><div className="app-main">Loading...</div></div>}>
      <CampaignDetailContent />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  title: { margin: 0, fontSize: 26, fontWeight: 700, color: "#0f172a" },
  sub: { margin: "4px 0 0", fontSize: 14, color: "#64748b" },
  badge: { padding: "4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: "#e0e7ff", color: "#3730a3" },
  error: { padding: 16, background: "#fef2f2", color: "#b91c1c", borderRadius: 8, marginBottom: 24, border: "1px solid #fecaca" },
  tabs: { display: "flex", gap: 8, marginBottom: 24, borderBottom: "1px solid #e2e8f0" },
  tab: { padding: "10px 16px", background: "transparent", border: "none", fontSize: 14, fontWeight: 600, color: "#64748b", cursor: "pointer", borderBottom: "2px solid transparent" },
  tabActive: { padding: "10px 16px", background: "transparent", border: "none", fontSize: 14, fontWeight: 600, color: "#4f46e5", cursor: "pointer", borderBottom: "2px solid #4f46e5" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24, alignItems: "start" },
  card: { background: "#fff", borderRadius: 14, padding: 24, border: "1px solid #eef0f4", boxShadow: "0 1px 2px rgba(15,23,42,0.03)" },
  cardTitle: { margin: "0 0 16px 0", fontSize: 16, fontWeight: 700, color: "#0f172a" },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6, marginTop: 16 },
  input: { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #e2e8f0", borderRadius: 8, outline: "none", color: "#0f172a", background: "#ffffff" },
  hint: { fontSize: 12, color: "#64748b", marginTop: 8 },
  radioGroup: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 },
  radioLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", color: "#334155" },
  clientList: { maxHeight: 300, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, background: "#f8fafc" },
  clientItem: { display: "flex", alignItems: "center", padding: "6px 0", fontSize: 14, cursor: "pointer", color: "#334155" },
  primaryBtn: { width: "100%", padding: "12px 16px", background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(79,70,229,0.25)" },
  secondaryBtn: { padding: "8px 16px", background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 14 },
  th: { padding: "12px 16px", borderBottom: "1px solid #e2e8f0", color: "#64748b", fontWeight: 600, background: "#f8fafc" },
  tr: { borderBottom: "1px solid #f1f5f9" },
  td: { padding: "16px", color: "#334155" },
};