import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import AuthLayout from "@/components/AuthLayout";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import { toast } from "@/components/ui/use-toast";

/* Registration.
 *
 * The account rules are unchanged and are all decided on the server: whether an
 * unknown Google account may create a user at all is GOOGLE_ALLOW_SIGNUP, which
 * is off by default, and the email path still goes through the same one-time
 * code before a session exists. Nothing here can bypass an invitation or an
 * approval, because nothing here grants anything.
 *
 * The Google control used to be a look-alike button of our own that only
 * redirected to /login, which is both a broken promise to the visitor and the
 * kind of imitation Google's branding terms exist to stop. It is now the same
 * real Google control the login page uses. An account that is not permitted to
 * be created is refused by the server with a message, which is the honest
 * outcome and the one that was going to happen anyway.
 */
export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showOtp, setShowOtp] = useState(false);
  const [otpCode, setOtpCode] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      await api.auth.register({ email, password });
      setShowOtp(true);
    } catch (err) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setError("");
    setLoading(true);
    try {
      const result = await api.auth.verifyOtp({ email, otpCode });
      if (result?.access_token) {
        api.auth.setToken(result.access_token);
      }
      window.location.href = "/";
    } catch (err) {
      setError(err.message || "Invalid verification code");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    try {
      await api.auth.resendOtp(email);
      toast({
        title: "Code sent",
        description: "Check your email for the new code.",
      });
    } catch (err) {
      setError(err.message || "Failed to resend code");
    }
  };

  if (showOtp) {
    return (
      <AuthLayout
        title="Verify your email"
        subtitle={`We sent a six digit code to ${email}.`}
      >
        {error && (
          <div role="alert" className="mb-5 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="mb-7 flex justify-center">
          <InputOTP
            maxLength={6}
            value={otpCode}
            onChange={setOtpCode}
            autoFocus
            autoComplete="one-time-code"
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button
          className="h-12 w-full text-[14px] font-semibold"
          onClick={handleVerify}
          disabled={loading || otpCode.length < 6}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Verifying...
            </>
          ) : (
            "Verify"
          )}
        </Button>
        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          Didn&apos;t receive the code?{" "}
          <button
            type="button"
            onClick={handleResend}
            className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Resend
          </button>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Get set up on DashFlo in a couple of minutes."
      footer={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Log in
          </Link>
        </>
      }
    >
      <GoogleSignInButton onError={setError} dividerLabel="or sign up with email" />

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
          <Label htmlFor="password" className="text-[13px]">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="Create a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            placeholder="Re-enter your password"
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
              Creating account...
            </>
          ) : (
            "Create account"
          )}
        </Button>
      </form>

      {/* Notice at Collection. Kept verbatim: it is the disclosure that has to
          be on this screen at the point the account is created, not a caption
          that can be trimmed for layout. */}
      <p className="mt-6 text-[12px] leading-relaxed text-muted-foreground">
        We use your email and account credentials to create, verify, secure, and support your DashFlo account.
        By creating an account, you agree to the{' '}
        <a
          href="https://dashflo.io/terms"
          className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Terms of Service
        </a>{' '}
        and acknowledge the{' '}
        <a
          href="https://dashflo.io/privacy"
          className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Privacy Policy
        </a>.
      </p>
    </AuthLayout>
  );
}
