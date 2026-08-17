import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";

// Token handling is unchanged: the token comes from the emailed link, is never
// stored, and is proved by the server. Only the shell around the form moved.

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const resetToken = searchParams.get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      await api.auth.resetPassword({ resetToken, newPassword });
      window.location.href = "/login";
    } catch (err) {
      setError(err.message || "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  if (!resetToken) {
    return (
      <AuthLayout
        title="That link did not work"
        subtitle="The reset link is missing or incomplete."
        footer={
          <Link
            to="/forgot-password"
            className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Request a new link
          </Link>
        }
      >
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-[14px] leading-relaxed text-foreground">
            Password reset links expire and can only be used once. Request a new
            one and open it from the most recent email.
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Choose a password you do not use anywhere else."
    >
      {error && (
        <div role="alert" className="mb-5 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="password" className="text-[13px]">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            placeholder="Enter a new password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-12"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm" className="text-[13px]">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            placeholder="Re-enter the new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="h-12"
            required
          />
        </div>
        <Button type="submit" className="h-12 w-full text-[14px] font-semibold" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Saving...
            </>
          ) : (
            "Reset password"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
