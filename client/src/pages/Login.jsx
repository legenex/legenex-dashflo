import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import GoogleSignInButton from "@/components/GoogleSignInButton";

// Nothing about how a session is obtained changed here. Google still exchanges
// an ID token that is verified server-side, the password form still posts the
// same credentials to the same route, and the session cookie is still issued and
// scoped by the server. This file decides what the entrance looks like, not who
// gets through it.

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.auth.loginViaEmailPassword(email, password);
      window.location.href = "/";
    } catch (err) {
      setError(err.message || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your DashFlo workspace."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            to="/register"
            className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Create one
          </Link>
        </>
      }
    >
      <GoogleSignInButton onError={setError} />

      {error && (
        <div role="alert" className="mb-5 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email" className="text-[13px]">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-12"
            required
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password" className="text-[13px]">Password</Label>
            <Link
              to="/forgot-password"
              className="rounded-sm text-[12px] text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-12"
            required
          />
        </div>
        <Button type="submit" className="h-12 w-full text-[14px] font-semibold" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Signing in...
            </>
          ) : (
            "Log in"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
