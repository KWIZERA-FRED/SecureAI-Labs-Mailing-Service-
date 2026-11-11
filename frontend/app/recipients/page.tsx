"use client";

import { useEffect, useState, useRef } from "react";
import { Sidebar } from "../components/Sidebar";
import { api } from "../../lib/api";
import { isAuthenticated } from "../../lib/auth";
import { useRouter } from "next/navigation";

export default function RecipientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Add Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit Modal State
  const [editingClient, setEditingClient] = useState<any>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editName, setEditName] = useState("");
  const [editStatus, setEditStatus] = useState("active");
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // File Upload State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    loadClients();
  }, [router]);

  async function loadClients(q = "") {
    setLoading(true);
    try {
      const res = await api.clients({ q, per_page: 200 });
      setClients(res.items || []);
      setTotalCount(res.total || 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    loadClients(search);
  }

  async function handleAddClient(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError("");
    try {
      await api.createClient({ email: newEmail, name: newName });
      setShowAddModal(false);
      setNewEmail("");
      setNewName("");
      loadClients(search);
    } catch (err: any) {
      setAddError(err.message || "Failed to add recipient.");
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingClient) return;
    setSavingEdit(true);
    setEditError("");

    try {
      await api.updateClient(editingClient.id, {
        email: editEmail,
        name: editName,
        status: editStatus,
        confirm_resubscribe: true,
      });
      setEditingClient(null);
      loadClients(search);
    } catch (err: any) {
      setEditError(err.message || "Failed to update recipient.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportResult(null);
    
    try {
      const res = await api.importClients(file);
      setImportResult(res);
      loadClients(search);
    } catch (err: any) {
      alert(err.message || "Failed to import file.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openEditModal(client: any) {
    setEditingClient(client);
    setEditEmail(client.email);
    setEditName(client.name || "");
    setEditStatus(client.status);
    setEditError("");
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <header style={styles.header}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1 style={styles.title}>Recipients</h1>
              <span style={styles.countBadge}>{totalCount} Total</span>
            </div>
            <p style={styles.sub}>Manage your mailing list of active and unsubscribed clients.</p>
          </div>
          <div style={styles.headerActions}>
            <input 
              type="file" 
              accept=".csv, .xlsx, .xls" 
              ref={fileInputRef} 
              style={{ display: "none" }} 
              onChange={handleFileUpload} 
            />
            <button 
              onClick={() => fileInputRef.current?.click()} 
              disabled={importing}
              style={styles.secondaryBtn}
            >
              {importing ? "Importing..." : "Import CSV / Excel"}
            </button>
            <button onClick={() => setShowAddModal(true)} style={styles.primaryBtn}>
              + New Recipient
            </button>
          </div>
        </header>

        {importResult && (
          <div style={styles.successBanner}>
            <strong>Import Complete:</strong> {importResult.added_count} added, {importResult.skipped_existing} skipped, {importResult.skipped_invalid} invalid. 
            <button onClick={() => setImportResult(null)} style={styles.closeBannerBtn}>✕</button>
          </div>
        )}

        <div style={styles.card}>
          <div style={styles.toolbar}>
            <form onSubmit={handleSearch} style={styles.searchWrap}>
              <input
                type="text"
                placeholder="Search by email or name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={styles.input}
              />
              <button type="submit" style={styles.searchBtn}>Search</button>
            </form>
          </div>

          {loading ? (
            <div className="skeleton" style={{ height: 200 }} />
          ) : clients.length === 0 ? (
            <p style={{ color: "#64748b" }}>No recipients found.</p>
          ) : (
            <div style={{ maxHeight: "calc(100vh - 300px)", overflow: "auto", border: "1px solid #e2e8f0", borderRadius: 8 }}>
              <table style={styles.table}>
                <thead style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1, boxShadow: "0 1px 0 #e2e8f0" }}>
                  <tr>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Email</th>
                    <th style={styles.th}>Status</th>
                    <th style={styles.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id} style={styles.tr}>
                      <td style={{ ...styles.td, fontWeight: 500 }}>{c.name || "—"}</td>
                      <td style={styles.td}>{c.email}</td>
                      <td style={styles.td}>
                        <span style={{
                          ...styles.badge,
                          background: c.status === "active" ? "#dcfce7" : "#f1f5f9",
                          color: c.status === "active" ? "#166534" : "#475569",
                        }}>
                          {c.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <button onClick={() => openEditModal(c)} style={styles.actionBtn}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* --- ADD RECIPIENT MODAL --- */}
      {showAddModal && (
        <div style={styles.modalOverlay} onClick={() => setShowAddModal(false)}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Add New Recipient</h2>
              <button onClick={() => setShowAddModal(false)} style={styles.closeBtn}>✕</button>
            </div>
            <form onSubmit={handleAddClient} style={styles.modalBody}>
              {addError && <div style={styles.error}>{addError}</div>}
              <label style={styles.label}>Email Address *</label>
              <input type="email" required value={newEmail} onChange={e => setNewEmail(e.target.value)} style={styles.input} placeholder="name@example.com" />
              <label style={styles.label}>Full Name (Optional)</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)} style={styles.input} placeholder="John Doe" />
              <div style={styles.modalFooter}>
                <button type="button" onClick={() => setShowAddModal(false)} style={styles.secondaryBtn}>Cancel</button>
                <button type="submit" disabled={adding} style={styles.primaryBtnSmall}>{adding ? "Adding..." : "Add Recipient"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- EDIT RECIPIENT MODAL --- */}
      {editingClient && (
        <div style={styles.modalOverlay} onClick={() => setEditingClient(null)}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Edit Recipient</h2>
              <button onClick={() => setEditingClient(null)} style={styles.closeBtn}>✕</button>
            </div>
            <form onSubmit={handleSaveEdit} style={styles.modalBody}>
              {editError && <div style={styles.error}>{editError}</div>}
              
              <label style={styles.label}>Email Address *</label>
              <input type="email" required value={editEmail} onChange={e => setEditEmail(e.target.value)} style={styles.input} />
              
              <label style={styles.label}>Full Name</label>
              <input type="text" value={editName} onChange={e => setEditName(e.target.value)} style={styles.input} />
              
              <label style={styles.label}>Status</label>
              <select value={editStatus} onChange={e => setEditStatus(e.target.value)} style={styles.input}>
                <option value="active">Active</option>
                <option value="unsubscribed">Unsubscribed</option>
              </select>

              <div style={styles.modalFooter}>
                <button type="button" onClick={() => setEditingClient(null)} style={styles.secondaryBtn}>Cancel</button>
                <button type="submit" disabled={savingEdit} style={styles.primaryBtnSmall}>{savingEdit ? "Saving..." : "Save Changes"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24, flexWrap: "wrap", gap: 16 },
  headerActions: { display: "flex", gap: 12, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 26, fontWeight: 700, color: "#0f172a" },
  countBadge: { background: "#e0e7ff", color: "#3730a3", padding: "4px 10px", borderRadius: 99, fontSize: 14, fontWeight: 600 },
  sub: { margin: "4px 0 0", fontSize: 14, color: "#64748b" },
  card: { background: "#fff", borderRadius: 14, padding: 24, border: "1px solid #eef0f4", boxShadow: "0 1px 2px rgba(15,23,42,0.03)" },
  toolbar: { display: "flex", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 },
  searchWrap: { display: "flex", gap: 8, width: "100%", maxWidth: 400 },
  input: { padding: "10px 14px", borderRadius: 8, border: "1px solid #e2e8f0", outline: "none", width: "100%", fontSize: 14, color: "#0f172a", background: "#ffffff" },
  searchBtn: { padding: "10px 16px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", fontWeight: 600, color: "#334155" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 14 },
  th: { padding: "12px 16px", borderBottom: "1px solid #e2e8f0", color: "#64748b", fontWeight: 600, background: "#f8fafc" },
  tr: { borderBottom: "1px solid #f1f5f9" },
  td: { padding: "16px", color: "#334155" },
  badge: { padding: "4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600 },
  actionBtn: { padding: "6px 12px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 12, fontWeight: 600, color: "#4f46e5", cursor: "pointer" },
  primaryBtn: { padding: "10px 16px", background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(79,70,229,0.25)" },
  primaryBtnSmall: { padding: "8px 16px", background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  secondaryBtn: { padding: "10px 16px", background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  
  // Modal
  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 },
  modalContent: { background: "#fff", borderRadius: 16, width: "100%", maxWidth: 440, boxShadow: "0 20px 40px rgba(0,0,0,0.2)", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px", borderBottom: "1px solid #e2e8f0" },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" },
  closeBtn: { background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#64748b" },
  modalBody: { padding: "24px" },
  modalFooter: { marginTop: 24, display: "flex", justifyContent: "flex-end", gap: 12 },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6, marginTop: 16 },
  error: { padding: 12, background: "#fef2f2", color: "#b91c1c", borderRadius: 8, marginBottom: 16, fontSize: 13 },
  
  // Banner
  successBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", background: "#dcfce7", color: "#166534", borderRadius: 8, marginBottom: 24, fontSize: 14 },
  closeBannerBtn: { background: "transparent", border: "none", cursor: "pointer", color: "#166534", fontSize: 16, fontWeight: "bold" },
};