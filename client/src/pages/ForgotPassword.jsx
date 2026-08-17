import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";

// The reset request answers the same way whether or not the address exists.
// That is the security behaviour of this page and it is unchanged: only the
// shell around it moved to the new auth design.

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.auth.resetPasswordRequest(email);
    } catch {
      // Always show the same result regardless, so this page cannot be used to
      // find out which addresses have accounts.
    } finally {
      setLoading(false);
      setSent(true);
    }
  };

  return (
    <AuthLayout
      title="Reset your password"
      subtitle={sent ? undefined : "We will email you a link to set a new one."}
      footer={
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <div role="status" className="rounded-xl border border-border bg-card p-6 text-center">
          <MailCheck className="mx-auto h-8 w-8 text-primary" aria-hidden="true" />
          <p className="mt-4 text-[14px] leading-relaxed text-foreground">
            If an account exists for that address, a password reset link is on its way.
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            The link expires shortly, so use it soon.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-[13px]">Email address</Label>
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
          <Button type="submit" className="h-12 w-full text-[14px] font-semibold" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Sending...
              </>
            ) : (
              "Send reset link"
            )}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
