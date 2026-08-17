import React from "react";
import DashFloBrand from "@/components/brand/DashFloBrand";

/* The DashFlo authentication shell.
 *
 * Every unauthenticated route renders through this: log in, register, forgot
 * password, reset password, and the verification step. One shell means they
 * cannot drift apart, which is the failure this replaced. The previous layout
 * was a small card floating in an otherwise empty viewport with a generic
 * lucide glyph above it, and it read as a template rather than as the entrance
 * to a product.
 *
 * The composition is asymmetric on purpose: a brand panel that carries the
 * product, and a narrower column that carries the work. The form is the thing
 * the visitor came to use, so it gets the tighter measure and the stronger
 * contrast, while the panel sits behind it and does not compete.
 *
 * Deliberately cheap to render. The marketing site's language is carried across
 * with two CSS gradients and one inline SVG grid, no animation library, no
 * canvas, no imported hero runtime. The whole panel costs a few hundred bytes
 * of markup and nothing at runtime, which matters because this is the first
 * screen anyone arriving from dashflo.io sees.
 *
 * Below lg the panel is replaced by a compact branded header rather than being
 * squeezed. Branding survives, the form keeps the full width, and there is no
 * column of empty space above the fold on a phone.
 */

// The grid that runs under the marketing site's dark surfaces. Inline so it
// needs no request, and drawn with currentColor so one definition serves both
// themes.
function SystemGrid({ className = "" }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      width="100%"
      height="100%"
      focusable="false"
    >
      <defs>
        <pattern id="dashflo-auth-grid" width="44" height="44" patternUnits="userSpaceOnUse">
          <path d="M44 0H0V44" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dashflo-auth-grid)" />
    </svg>
  );
}

// Three fixed lines of operating-system vocabulary. Static text, not a
// simulated feed: inventing live-looking numbers on a login screen would be
// telling the visitor something untrue before they have even signed in.
const SIGNALS = [
  { label: "Intake", value: "Suppliers and API" },
  { label: "Distribution", value: "Caps, priority, returns" },
  { label: "Reconciliation", value: "Spend to cash" },
];

function BrandPanel() {
  return (
    <div className="relative hidden lg:flex lg:w-[46%] xl:w-[48%] shrink-0 overflow-hidden bg-slate-950 text-slate-100">
      {/* Restrained red system glow. Two soft radials, well under the text, so
          the panel reads as lit rather than decorated. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 top-[-10%] h-[520px] w-[520px] rounded-full opacity-[0.22] blur-3xl"
        style={{ background: "radial-gradient(circle, hsl(358 74% 59%) 0%, transparent 65%)" }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-32 bottom-[-15%] h-[460px] w-[460px] rounded-full opacity-[0.14] blur-3xl"
        style={{ background: "radial-gradient(circle, hsl(358 74% 59%) 0%, transparent 70%)" }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 text-white/[0.05]">
        <SystemGrid className="h-full w-full" />
      </div>
      {/* Fades the grid out toward the seam so the panel does not end on a hard
          ruled edge next to the form. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "linear-gradient(100deg, transparent 35%, rgb(2 6 23 / 0.85) 100%)" }}
      />

      <div className="relative flex flex-col justify-between p-12 xl:p-16">
        <DashFloBrand
          forceTheme="dark"
          iconClassName="h-10 w-10"
          textClassName="text-[22px] text-slate-50"
          className="[&_span]:text-slate-50"
        />

        <div className="max-w-md">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            Lead operations
          </p>
          <h2 className="mt-4 font-heading text-[34px] xl:text-[38px] font-bold leading-[1.12] tracking-tight text-white">
            One operating system for lead operations.
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-slate-400">
            Intake, distribution, delivery, billing and reporting on one record,
            from the first advertising dollar through to cash.
          </p>
        </div>

        <dl className="space-y-3.5">
          {SIGNALS.map((signal) => (
            <div key={signal.label} className="flex items-center gap-3.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500 w-[124px] shrink-0">
                {signal.label}
              </dt>
              <dd className="text-[13px] text-slate-300">{signal.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default function AuthLayout({ title, subtitle, footer, children }) {
  return (
    <div className="flex min-h-screen bg-background">
      <BrandPanel />

      <main className="flex flex-1 flex-col items-center justify-center px-5 py-10 sm:px-8 sm:py-14">
        <div className="w-full max-w-[420px]">
          {/* The brand on small screens, where the panel is not rendered. The
              login page must say DashFlo before it says anything else. */}
          <div className="mb-9 flex justify-center lg:hidden">
            <DashFloBrand iconClassName="h-9 w-9" textClassName="text-[19px]" />
          </div>

          <div className="mb-7">
            <h1 className="font-heading text-[27px] sm:text-[30px] font-bold leading-tight tracking-tight text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{subtitle}</p>
            )}
          </div>

          {children}

          {footer && (
            <p className="mt-7 text-center text-[13px] text-muted-foreground">{footer}</p>
          )}

          <p className="mt-8 text-center text-[12px] text-muted-foreground">
            <a
              href="https://dashflo.io/privacy"
              className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Privacy
            </a>
            <span aria-hidden="true" className="px-2 text-border">|</span>
            <a
              href="https://dashflo.io/terms"
              className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Terms
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
