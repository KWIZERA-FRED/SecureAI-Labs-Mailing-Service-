"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearToken } from "../../lib/auth";

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  const navItems = [
    { label: "Dashboard", path: "/", icon: "▦" },
    { label: "Campaigns", path: "/campaigns", icon: "✉" },
    { label: "Recipients", path: "/recipients", icon: "◉" },
    { label: "Audit log", path: "/audit", icon: "◍" },
  ];

  const Brand = () => (
    <div style={styles.sidebarBrand}>
      <div style={styles.logoSmall}>S</div>
      <div>
        <div style={styles.sidebarTitle}>SecureAI Labs</div>
        <div style={styles.sidebarSub}>Mailing</div>
      </div>
    </div>
  );

  return (
    <>
      {/* MOBILE TOP BAR */}
      <div className="mobile-topbar">
        <Brand />
        <button className="hamburger-btn" onClick={() => setIsOpen(true)}>
          ☰
        </button>
      </div>

      {/* MOBILE OVERLAY */}
      {isOpen && (
        <div className="sidebar-overlay" onClick={() => setIsOpen(false)} />
      )}

      {/* SIDEBAR */}
      <aside className={`app-sidebar ${isOpen ? "open" : ""}`}>
        <Brand />

        <nav style={styles.nav}>
          {navItems.map((item) => {
            const isActive = pathname === item.path;
            return (
              <a
                key={item.path}
                href={item.path}
                style={isActive ? styles.navActive : styles.navItem}
                onClick={() => setIsOpen(false)}
              >
                <span style={styles.navIcon}>{item.icon}</span> {item.label}
              </a>
            );
          })}
        </nav>

        <button onClick={handleLogout} style={styles.logoutBtn}>
          Sign out
        </button>
      </aside>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebarBrand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 8px 24px",
    borderBottom: "1px solid #1e293b",
    marginBottom: 20,
  },
  logoSmall: {
    width: 34,
    height: 34,
    borderRadius: 9,
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 16,
  },
  sidebarTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#f1f5f9",
    lineHeight: 1.2,
  },
  sidebarSub: {
    fontSize: 11,
    color: "#94a3b8",
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: 1,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    color: "#cbd5e1",
    textDecoration: "none",
    fontSize: 14,
    borderRadius: 8,
    transition: "background .15s",
  },
  navActive: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: "#1e293b",
    color: "#fff",
    textDecoration: "none",
    fontSize: 14,
    borderRadius: 8,
    fontWeight: 600,
  },
  navIcon: {
    fontSize: 14,
    opacity: 0.85,
    width: 16,
    textAlign: "center",
  },
  logoutBtn: {
    marginTop: 16,
    padding: "10px 12px",
    background: "transparent",
    color: "#f87171",
    border: "1px solid #1e293b",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 600,
  },
};