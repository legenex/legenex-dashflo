import React, { useState } from 'react';
import { api } from '@/api/client';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ArrowRight, ArrowLeft, Loader2, CheckCircle2 } from 'lucide-react';
import { STEPS } from '@/components/apply/applyConstants';
import CompanyStep from '@/components/apply/steps/CompanyStep';
import CommercialStep from '@/components/apply/steps/CommercialStep';
import DetailStep from '@/components/apply/steps/DetailStep';

const INITIAL = {
  company_name: '',
  primary_contact_name: '',
  primary_contact_role: '',
  primary_contact_email: '',
  primary_contact_phone: '',
  target_states: [],
  client_type: '',
  cpl: '',
  vertical: '',
  billing_type: 'prepay',
  billing_email: '',
  accounts_contact_name: '',
  prior_experience: '',
  experience_detail: '',
  additional_requirements: '',
};

// Client side gate for each step. Keeps the user from advancing with obviously
// missing fields; the server still validates everything on submit.
const REQUIRED_BY_STEP = [
  ['company_name', 'primary_contact_name', 'primary_contact_email', 'primary_contact_phone'],
  ['target_states', 'client_type', 'cpl', 'billing_type'],
  [],
];

export default function Apply() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(INITIAL);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { status, company_name }
  const [globalError, setGlobalError] = useState('');

  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const validateStep = () => {
    const req = REQUIRED_BY_STEP[step];
    const next = {};
    for (const key of req) {
      const v = form[key];
      const empty = key === 'target_states' ? (!Array.isArray(v) || v.length === 0) : !String(v ?? '').trim();
      if (empty) next[key] = 'This field is required.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const goNext = () => {
    if (!validateStep()) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setErrors({});
    setStep((s) => Math.max(s - 1, 0));
  };

  const submit = async () => {
    if (!validateStep()) return;
    setSubmitting(true);
    setGlobalError('');
    try {
      const payload = { ...form, cpl: form.cpl === '' ? '' : Number(form.cpl) };
      const res = await api.functions.invoke('submitBuyerOnboarding', payload);
      setResult(res.data);
    } catch (e) {
      const data = e?.response?.data;
      if (data?.field_errors) {
        setErrors(data.field_errors);
        // Jump back to the earliest step that has an error.
        const firstStepWithError = REQUIRED_BY_STEP.findIndex((keys) =>
          keys.some((k) => data.field_errors[k]),
        );
        if (firstStepWithError >= 0) setStep(firstStepWithError);
        setGlobalError(data.error || 'Some fields need attention.');
      } else {
        setGlobalError(data?.error || e?.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6 app-scroll">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-lg rounded-2xl border border-border bg-card p-10 text-center shadow-[0_24px_64px_-24px_rgba(0,0,0,0.5)]"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(152_65%_54%)]/15">
            <CheckCircle2 className="h-7 w-7 text-[hsl(152_65%_54%)]" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-foreground font-heading">
            {result.status === 'duplicate' ? 'Already received' : 'Application received'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            {result.status === 'duplicate'
              ? `We already have a recent submission for ${result.company_name}. Our team will be in touch shortly — no need to submit again.`
              : `Thanks, ${result.company_name}. Your application is in our queue. Our onboarding team will review the details and reach out shortly.`}
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background app-scroll">
      <div className="mx-auto max-w-2xl px-6 py-12 sm:py-16">
        {/* Brand header */}
        <div className="text-center mb-10">
          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-primary">Legenex</div>
          <h1 className="mt-3 text-3xl font-semibold text-foreground font-heading">Buyer onboarding</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Tell us about your firm and coverage needs. Takes about two minutes.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step;
            return (
              <React.Fragment key={s.key}>
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold transition-colors ${
                      done
                        ? 'bg-primary text-primary-foreground'
                        : active
                        ? 'bg-primary/15 text-primary ring-1 ring-primary'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                  </div>
                  <span className={`hidden sm:block text-[12.5px] font-medium ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && <div className="h-px w-6 sm:w-10 bg-border" />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-[0_24px_64px_-24px_rgba(0,0,0,0.5)]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === 0 && <CompanyStep form={form} set={set} errors={errors} />}
              {step === 1 && <CommercialStep form={form} set={set} errors={errors} />}
              {step === 2 && <DetailStep form={form} set={set} errors={errors} />}
            </motion.div>
          </AnimatePresence>

          {globalError && (
            <div className="mt-5 rounded-lg border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-[13px] text-primary">
              {globalError}
            </div>
          )}

          {/* Nav */}
          <div className="mt-7 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={goBack}
              disabled={step === 0 || submitting}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg text-[13.5px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-0 disabled:pointer-events-none transition-colors"
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </button>

            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={goNext}
                className="inline-flex items-center gap-1.5 h-10 px-6 rounded-lg bg-primary text-primary-foreground text-[13.5px] font-semibold hover:bg-primary/90 transition-colors"
              >
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="inline-flex items-center gap-2 h-10 px-6 rounded-lg bg-primary text-primary-foreground text-[13.5px] font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Submitting…' : 'Submit application'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}