"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../../lib/api";
import { setToken, isAuthenticated } from "../../lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) router.replace("/");
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await api.login(email.trim(), password);
      setToken(res.access_token);
      router.replace("/");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Unable to reach the server. Please try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.card} className="fade-in">
        {/* Logo / Brand */}
        <div style={styles.brand}>
          <div style={styles.logo}>S</div>
          <div>
            <h1 style={styles.brandName}>SecureAI Labs</h1>
            <p style={styles.brandSub}>Journal Mailing Platform</p>
          </div>
        </div>

        <h2 style={styles.heading}>Welcome back</h2>
        <p style={styles.subheading}>
          Sign in to manage campaigns and recipients.
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label} htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@secureailabs.org"
            style={styles.input}
            onFocus={(e) => (e.currentTarget.style.borderColor = "#4f46e5")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "#e2e8f0")}
          />

          <label style={styles.label} htmlFor="password">
            Password
          </label>
          <div style={{ position: "relative" }}>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={styles.input}
              onFocus={(e) => (e.currentTarget.style.borderColor = "#4f46e5")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "#e2e8f0")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              style={styles.eyeBtn}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>

          {error && (
            <div style={styles.error}>
              <span style={{ marginRight: 8 }}>⚠</span>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              ...styles.button,
              opacity: loading ? 0.7 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? (
              <span style={styles.spinnerRow}>
                <span style={styles.spinner} /> Signing in…
              </span>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p style={styles.footer}>
          Protected area. Contact your administrator if you need access.
        </p>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background:
      "radial-gradient(circle at 20% 20%, #eef2ff 0%, #f8fafc 45%, #f8fafc 100%)",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    background: "#ffffff",
    borderRadius: 16,
    padding: "40px 36px 32px",
    boxShadow:
      "0 1px 2px rgba(15,23,42,0.04), 0 12px 40px rgba(15,23,42,0.08)",
    border: "1px solid #eef0f4",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 32,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 20,
    boxShadow: "0 4px 14px rgba(79,70,229,0.35)",
  },
  brandName: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: "#0f172a",
    lineHeight: 1.2,
  },
  brandSub: {
    margin: 0,
    fontSize: 12,
    color: "#64748b",
  },
  heading: {
    margin: 0,
    fontSize: 26,
    fontWeight: 700,
    color: "#0f172a",
    letterSpacing: "-0.02em",
  },
  subheading: {
    margin: "6px 0 28px",
    fontSize: 14,
    color: "#64748b",
    lineHeight: 1.5,
  },
  form: {
    display: "flex",
    flexDirection: "column",
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "#334155",
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    width: "100%",
    padding: "11px 14px",
    fontSize: 14,
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    outline: "none",
    transition: "border-color .15s ease, box-shadow .15s ease",
    color: "#0f172a",
    background: "#fff",
  },
  eyeBtn: {
    position: "absolute",
    right: 10,
    top: "50%",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    fontSize: 12,
    fontWeight: 600,
    color: "#6366f1",
    cursor: "pointer",
    padding: 6,
  },
  error: {
    marginTop: 16,
    padding: "10px 12px",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#b91c1c",
    borderRadius: 10,
    fontSize: 13,
    lineHeight: 1.4,
  },
  button: {
    marginTop: 24,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 600,
    color: "#fff",
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    border: "none",
    borderRadius: 10,
    boxShadow: "0 6px 16px rgba(79,70,229,0.3)",
    transition: "transform .08s ease, box-shadow .15s ease",
  },
  spinnerRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  },
  spinner: {
    width: 14,
    height: 14,
    border: "2px solid rgba(255,255,255,0.4)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    display: "inline-block",
    animation: "spin 0.8s linear infinite",
  },
  footer: {
    marginTop: 24,
    fontSize: 12,
    color: "#94a3b8",
    textAlign: "center",
    lineHeight: 1.5,
  },
};