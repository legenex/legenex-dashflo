import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronRight, ChevronDown, Search, MessageSquarePlus, AlertTriangle, Database,
  Puzzle, FileCode, ShieldCheck, EyeOff, CornerUpRight, Send,
} from 'lucide-react';
import { usePermissions } from '@/lib/AuthContext';
import { pageReadiness } from '@/lib/progress/readiness';
import {
  useProgressPages, useProgressFindings, useReviewThreads, useVerificationRecords,
  useProgressMutation, mergePagesWithManifest, usePageManifest, parseJson,
} from '@/components/progress/useProgress';
import { sortSections } from '@/components/progress/progressNav';
import {
  ProgressPageHeader, Card, CardHeader, CardBody, Badge, EmptyState, Row,
  PrimaryButton, SecondaryButton, LoadingBlock, ReadinessBar, toneForReadiness,
  LIFECYCLE_LABEL, LIFECYCLE_TONE, PRIORITY_TONE, EvidenceBadge,
} from '@/components/progress/progressUi';

// Application Review: the tree of every section and page, plus the per page
// review workspace where Nick's knowledge actually enters the system.
//
// The tree is generated, not hand maintained. A route that exists in the router
// but has no review record shows as unregistered rather than being hidden, and a
// record whose route has disappeared shows as removed. Both are things worth
// seeing.

const SUBJECT_TYPES = [
  { value: 'page', label: 'The whole page' },
  { value: 'metric_card', label: 'A metric' },
  { value: 'lead_count', label: 'A lead count' },
  { value: 'status_pill', label: 'A status pill' },
  { value: 'table_column', label: 'A table column' },
  { value: 'filter', label: 'A filter' },
  { value: 'form_field', label: 'A form field' },
  { value: 'modal', label: 'A modal or drawer' },
  { value: 'component', label: 'A component' },
  { value: 'entity', label: 'An entity' },
  { value: 'field', label: 'An entity field' },
  { value: 'backend_function', label: 'A backend function' },
  { value: 'calculation', label: 'A calculation' },
  { value: 'permission', label: 'A permission' },
  { value: 'workflow', label: 'A workflow' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'migration_requirement', label: 'A migration requirement' },
];

const FINDING_TYPES = [
  'ui_inconsistency', 'ux_problem', 'incorrect_metric', 'data_inconsistency',
  'backend_defect', 'missing_functionality', 'performance', 'permission', 'security',
  'mobile', 'accessibility', 'missing_state', 'integration', 'migration_blocker',
  'technical_debt', 'copy_terminology', 'user_request',
];

const humanise = (s) => (s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const groupBy = (list, key) => {
  const out = {};
  (list || []).forEach((i) => { const k = i[key]; if (k) (out[k] = out[k] || []).push(i); });
  return out;
};

export default function ApplicationReview() {
  const manifest = usePageManifest();
  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('page');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const pagesQ = useProgressPages();
  const findingsQ = useProgressFindings();
  const threadsQ = useReviewThreads();
  const verifsQ = useVerificationRecords();

  const pages = useMemo(
    () => mergePagesWithManifest(pagesQ.data || [], manifest.pages),
    [pagesQ.data, manifest],
  );

  const findingsByPage = useMemo(() => groupBy(findingsQ.data, 'page_key'), [findingsQ.data]);
  const threadsByPage = useMemo(() => groupBy(threadsQ.data, 'page_key'), [threadsQ.data]);
  const verifsByPage = useMemo(
    () => groupBy((verifsQ.data || []).filter((v) => v.subject_type === 'page'), 'subject_key'),
    [verifsQ.data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((p) =>
      (p.title || '').toLowerCase().includes(q)
      || (p.route || '').toLowerCase().includes(q)
      || (p.component_path || '').toLowerCase().includes(q)
      || (p.section_label || '').toLowerCase().includes(q));
  }, [pages, query]);

  const sections = useMemo(() => {
    const grouped = groupBy(filtered, 'section_key');
    return sortSections(Object.keys(grouped)).map((key) => ({
      key,
      label: grouped[key][0]?.section_label || key,
      pages: grouped[key].sort((a, b) => (a.route || '').localeCompare(b.route || '')),
    }));
  }, [filtered]);

  const selected = pages.find((p) => p.page_key === selectedKey) || null;

  if (pagesQ.isLoading) {
    return (
      <>
        <ProgressPageHeader title="Application Review" description="Loading the page inventory." />
        <LoadingBlock label="Reading the inventory" />
      </>
    );
  }

  return (
    <>
      <ProgressPageHeader
        title="Application Review"
        description={`${pages.length} surfaces derived from the router, nav and permission config. Select one to review it.`}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* Tree */}
        <Card className="h-fit lg:sticky lg:top-4">
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pages, routes, components"
                className="w-full bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {sections.length === 0 ? (
              <EmptyState icon={Search} title="No matches" description="Nothing in the inventory matches that search." />
            ) : sections.map((section) => {
              const open = !collapsed[section.key];
              const sectionResults = section.pages.map((p) => pageReadiness(p, {
                findings: findingsByPage[p.page_key] || [],
                verifications: verifsByPage[p.page_key] || [],
              }));
              const scored = sectionResults.filter((r) => r.scored);
              const avg = scored.length
                ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length)
                : 0;
              return (
                <div key={section.key} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [section.key]: open }))}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-foreground">{section.label}</span>
                      <ReadinessBar value={avg} tone={toneForReadiness(avg)} className="mt-1.5" />
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                      {section.pages.length}
                    </span>
                  </button>
                  {open && (
                    <div className="pb-1">
                      {section.pages.map((p) => {
                        const active = p.page_key === selectedKey;
                        const open0 = (findingsByPage[p.page_key] || []).filter((f) => ['open', 'acknowledged'].includes(f.status || 'open'));
                        const p0 = open0.filter((f) => f.priority === 'P0').length;
                        return (
                          <button
                            key={p.page_key}
                            type="button"
                            onClick={() => setParams({ page: p.page_key })}
                            className={`flex w-full items-center gap-2 py-1.5 pl-8 pr-3 text-left transition-colors hover:bg-accent ${active ? 'bg-accent' : ''}`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate text-[12px] ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                                {p.title}
                              </span>
                              <span className="block truncate text-[10px] text-muted-foreground">{p.route}</span>
                            </span>
                            {p.nav_visibility === 'hidden' && <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" />}
                            {p0 > 0 && <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">P0</span>}
                            {!p.registered && <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">new</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Workspace */}
        <div className="min-w-0">
          {!selected ? (
            <Card>
              <EmptyState
                icon={FileCode}
                title="Select a surface to review"
                description="The tree lists every route, tab, redirect and portal page derived from the real router. Pick one to see what it does, what it depends on, and what is wrong with it."
              />
            </Card>
          ) : (
            <PageWorkspace
              page={selected}
              findings={findingsByPage[selected.page_key] || []}
              threads={threadsByPage[selected.page_key] || []}
              verifications={verifsByPage[selected.page_key] || []}
            />
          )}
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- *
 * Workspace
 * ---------------------------------------------------------------- */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'backend', label: 'Backend and dependencies' },
  { key: 'findings', label: 'Findings' },
  { key: 'comments', label: 'Comments' },
];

function PageWorkspace({ page, findings, threads, verifications }) {
  const { can } = usePermissions();
  const [tab, setTab] = useState('overview');
  const pageMutation = useProgressMutation('ProgressPage', 'progress-pages');

  const result = pageReadiness(page, { findings, verifications });
  const entities = parseJson(page.entity_dependencies, []);
  const functions = parseJson(page.function_dependencies, []);
  const components = parseJson(page.component_dependencies, []);
  const layouts = parseJson(page.layouts, []);
  const roles = parseJson(page.roles, []);
  const openFindings = findings.filter((f) => ['open', 'acknowledged'].includes(f.status || 'open'));

  const canWrite = can('progress_write');

  return (
    <div className="space-y-4">
      {/* Header facts */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold text-foreground">{page.title}</h2>
              <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">{page.route}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={LIFECYCLE_TONE[page.lifecycle_status] || 'neutral'}>
                {LIFECYCLE_LABEL[page.lifecycle_status] || 'Not started'}
              </Badge>
              <Badge tone={page.verification_status === 'verified' ? 'good' : 'neutral'}>
                {humanise(page.verification_status || 'unverified')}
              </Badge>
              {page.review_stale && <Badge tone="warn">Review stale</Badge>}
              {!page.registered && <Badge tone="warn">Not registered</Badge>}
              {page.orphaned && <Badge tone="bad">Route removed</Badge>}
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Readiness</span>
              <span className="text-[13px] font-semibold text-foreground">{result.score}%</span>
            </div>
            <ReadinessBar value={result.score} tone={toneForReadiness(result.score)} />
            {result.explanation.applied_caps.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.explanation.applied_caps.map((c, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground">
                    Capped at {c.to} by {humanise(c.cap).toLowerCase()}: {c.why}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">{result.explanation.formula}</p>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <Fact label="Section" value={page.section_label} />
            <Fact label="Type" value={humanise(page.route_type)} />
            <Fact label="Host scope" value={page.host_scope} />
            <Fact label="Audience" value={humanise(page.portal_scope)} />
            <Fact label="Auth" value={humanise(page.auth)} />
            <Fact label="Permission key" value={page.permission_key || 'none'} />
            <Fact label="In sidebar" value={page.nav_visibility === 'nav' ? 'Yes' : 'No, reachable only by URL'} />
            <Fact label="Criticality" value={humanise(page.criticality || 'normal')} />
            <Fact label="Roles with access" value={roles.length ? roles.join(', ') : 'unknown'} />
            <Fact label="Open findings" value={String(openFindings.length)} />
            <Fact label="Comments" value={String(threads.length)} />
            <Fact label="LeadByte parity" value={humanise(page.leadbyte_parity || 'not assessed')} />
          </dl>
        </CardBody>
      </Card>

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors ${
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
              {t.key === 'findings' && openFindings.length > 0 && (
                <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{openFindings.length}</span>
              )}
              {t.key === 'comments' && threads.length > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{threads.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && (
        <OverviewTab page={page} result={result} canWrite={canWrite} mutation={pageMutation} />
      )}
      {tab === 'backend' && (
        <BackendTab entities={entities} functions={functions} components={components} layouts={layouts} page={page} />
      )}
      {tab === 'findings' && <FindingsTab findings={findings} />}
      {tab === 'comments' && <CommentsTab page={page} threads={threads} />}
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[12px] text-foreground" title={value}>{value || 'not set'}</dd>
    </div>
  );
}

function OverviewTab({ page, result, canWrite, mutation }) {
  const [draft, setDraft] = useState({
    purpose: page.purpose || '',
    strengths: page.strengths || '',
    gaps: page.gaps || '',
    human_notes: page.human_notes || '',
    criticality: page.criticality || 'normal',
    lifecycle_status: page.lifecycle_status || 'not_started',
    migration_required: page.migration_required ?? '',
    leadbyte_equivalent: page.leadbyte_equivalent || '',
  });
  const [saved, setSaved] = useState(false);

  const save = () => {
    if (!page.id) return;
    const payload = {
      ...draft,
      migration_required: draft.migration_required === '' ? null : draft.migration_required === 'true' || draft.migration_required === true,
      last_reviewed_at: new Date().toISOString(),
      review_stale: false,
      needs_human_review: false,
    };
    mutation.mutate({ action: 'update', id: page.id, data: payload }, { onSuccess: () => setSaved(true) });
  };

  if (!page.registered) {
    return (
      <Card>
        <EmptyState
          icon={Database}
          title="This route has no review record yet"
          description="It exists in the router but has never been synced. Run Sync inventory from the Command Center to register it, then it can be assessed."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Assessment"
          subtitle="Your judgement. Nothing here is ever overwritten by a sync or by an agent."
        />
        <CardBody className="space-y-4">
          <Field label="What this page is for, and who uses it">
            <TextArea value={draft.purpose} onChange={(v) => setDraft({ ...draft, purpose: v })} disabled={!canWrite} rows={3} />
          </Field>
          <Field label="What it does well">
            <TextArea value={draft.strengths} onChange={(v) => setDraft({ ...draft, strengths: v })} disabled={!canWrite} rows={2} />
          </Field>
          <Field label="What appears incomplete or inconsistent">
            <TextArea value={draft.gaps} onChange={(v) => setDraft({ ...draft, gaps: v })} disabled={!canWrite} rows={3} />
          </Field>
          <Field label="Your notes">
            <TextArea value={draft.human_notes} onChange={(v) => setDraft({ ...draft, human_notes: v })} disabled={!canWrite} rows={2} />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Criticality">
              <Select
                value={draft.criticality}
                onChange={(v) => setDraft({ ...draft, criticality: v })}
                disabled={!canWrite}
                options={[['critical', 'Critical (weight 5)'], ['high', 'High (3)'], ['normal', 'Normal (1)'], ['low', 'Low (0.5)']]}
              />
            </Field>
            <Field label="Lifecycle">
              <Select
                value={draft.lifecycle_status}
                onChange={(v) => setDraft({ ...draft, lifecycle_status: v })}
                disabled={!canWrite}
                options={Object.entries(LIFECYCLE_LABEL)}
              />
            </Field>
            <Field label="Required for LeadByte cutover">
              <Select
                value={String(draft.migration_required)}
                onChange={(v) => setDraft({ ...draft, migration_required: v })}
                disabled={!canWrite}
                options={[['', 'Not decided'], ['true', 'Yes'], ['false', 'No']]}
              />
            </Field>
            <Field label="LeadByte equivalent">
              <TextInput value={draft.leadbyte_equivalent} onChange={(v) => setDraft({ ...draft, leadbyte_equivalent: v })} disabled={!canWrite} />
            </Field>
          </div>

          {canWrite && (
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={save} disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving' : 'Save assessment'}
              </PrimaryButton>
              {saved && !mutation.isPending && <span className="text-[12px] text-chart-5">Saved</span>}
            </div>
          )}
          {!canWrite && (
            <p className="text-[12px] text-muted-foreground">
              You have read access only. Ask an administrator for the progress write permission to record an assessment.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How this score was reached" subtitle="The number is a calculation, not an opinion" icon={ShieldCheck} />
        <CardBody>
          <div className="space-y-2">
            {result.explanation.dimensions.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] text-foreground">{d.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {d.assessed ? `${d.value} of 100` : 'not assessed, scores 0'}
                  <span className="ml-2 text-muted-foreground">weight {d.weight}%</span>
                </span>
              </div>
            ))}
          </div>
          {result.explanation.reasons.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-border pt-3">
              {result.explanation.reasons.map((r, i) => (
                <li key={i} className="text-[11px] text-muted-foreground">{r}</li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function BackendTab({ entities, functions, components, layouts, page }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Entities read (${entities.length})`} subtitle="Derived from the page's transitive import graph" icon={Database} />
          {entities.length === 0 ? (
            <EmptyState icon={Database} title="No entity reads detected" description="This surface either renders static content or gets its data through a layout or a backend function." />
          ) : (
            <div>{entities.map((e) => <Row key={e}><span className="font-mono text-[12px] text-foreground">{e}</span></Row>)}</div>
          )}
        </Card>
        <Card>
          <CardHeader title={`Backend functions called (${functions.length})`} subtitle="api.functions.invoke targets" icon={Puzzle} />
          {functions.length === 0 ? (
            <EmptyState icon={Puzzle} title="No backend functions called" description="This surface reads entities directly or is presentational." />
          ) : (
            <div>{functions.map((f) => <Row key={f}><span className="font-mono text-[12px] text-foreground">{f}</span></Row>)}</div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title={`Component graph (${components.length} files)`}
          subtitle="A change to any of these can affect this page. This is what drives stale review detection."
          icon={FileCode}
        />
        <CardBody>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Layout chain: {layouts.length ? layouts.join(' > ') : 'none'}
          </p>
          <p className="mb-3 font-mono text-[11px] text-foreground">{page.component_path || 'no component resolved'}</p>
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {components.map((c) => (
              <div key={c} className="border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground last:border-b-0">
                {c}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function FindingsTab({ findings }) {
  if (findings.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={AlertTriangle}
          title="No findings on this surface"
          description="Nothing has been raised here by the audit harness, an AI review, or a person. That is not the same as the page being correct."
        />
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={`Findings (${findings.length})`} subtitle="Machine, AI and human findings share one list" />
      <div>
        {findings.map((f) => (
          <div key={f.id} className="border-b border-border px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 text-[13px] font-medium text-foreground">{f.title || f.check_id}</p>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {f.priority && <Badge tone={PRIORITY_TONE[f.priority]}>{f.priority}</Badge>}
                <Badge tone={f.status === 'fixed' ? 'good' : 'neutral'}>{humanise(f.status || 'open')}</Badge>
                <EvidenceBadge type={f.evidence_type} requiresVerification={f.requires_verification} />
              </div>
            </div>
            {(f.description || f.detail) && (
              <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">{f.description || f.detail}</p>
            )}
            {(f.expected || f.observed) && (
              <div className="mt-2 space-y-0.5">
                {f.expected && <p className="text-[11px] text-muted-foreground">Expected: {f.expected}</p>}
                {f.observed && <p className="text-[11px] text-muted-foreground">Observed: {f.observed}</p>}
              </div>
            )}
            {f.evidence_path && (
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{f.evidence_path}</p>
            )}
            {f.open_question && (
              <p className="mt-2 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px] text-foreground">
                Needs your answer: {f.open_question}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- *
 * Comments
 * ---------------------------------------------------------------- */

function CommentsTab({ page, threads }) {
  const { can, role } = usePermissions();
  const mutation = useProgressMutation('ReviewThread', 'progress-threads');
  const [form, setForm] = useState({
    subject_type: 'page',
    subject_ref: '',
    observed_value: '',
    body: '',
    severity: 'P3',
    finding_type: '',
  });
  const canComment = can('progress_write') || can('progress_review');

  const submit = () => {
    if (!form.body.trim()) return;
    // Context is captured automatically so the comment survives without the
    // conversation that produced it.
    const captured = {
      route: page.route,
      page_key: page.page_key,
      component_path: page.component_path,
      section: page.section_label,
      lifecycle: page.lifecycle_status,
      role,
      viewport: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : null,
      captured_at: new Date().toISOString(),
    };
    mutation.mutate({
      action: 'create',
      data: {
        page_key: page.page_key,
        subject_type: form.subject_type,
        subject_ref: form.subject_ref || null,
        observed_value: form.observed_value || null,
        body: form.body.trim(),
        severity: form.severity,
        finding_type: form.finding_type || null,
        captured_context: JSON.stringify(captured),
        status: 'open',
        author_role: role,
      },
    }, {
      onSuccess: () => setForm({ ...form, body: '', subject_ref: '', observed_value: '' }),
    });
  };

  return (
    <div className="space-y-4">
      {canComment && (
        <Card>
          <CardHeader
            title="Add a comment"
            subtitle="Point at the exact thing. A comment on a specific metric or pill becomes a far better implementation prompt than a comment on the page."
            icon={MessageSquarePlus}
          />
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="What is this about">
                <Select
                  value={form.subject_type}
                  onChange={(v) => setForm({ ...form, subject_type: v })}
                  options={SUBJECT_TYPES.map((s) => [s.value, s.label])}
                />
              </Field>
              <Field label="Which one (name, label or path)">
                <TextInput
                  value={form.subject_ref}
                  onChange={(v) => setForm({ ...form, subject_ref: v })}
                  placeholder="e.g. Sold leads, StatusPill, reportMetrics.js"
                />
              </Field>
              <Field label="Value shown on screen">
                <TextInput
                  value={form.observed_value}
                  onChange={(v) => setForm({ ...form, observed_value: v })}
                  placeholder="e.g. 1,482"
                />
              </Field>
            </div>
            <Field label="What is wrong, and what it should do instead">
              <TextArea
                value={form.body}
                onChange={(v) => setForm({ ...form, body: v })}
                rows={3}
                placeholder="e.g. This sold lead count does not match the Leads page for the same date range. It looks like it is filtering on created date rather than sold date."
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Severity">
                <Select
                  value={form.severity}
                  onChange={(v) => setForm({ ...form, severity: v })}
                  options={[['P0', 'P0 migration or production blocker'], ['P1', 'P1 critical'], ['P2', 'P2 high'], ['P3', 'P3 normal'], ['P4', 'P4 low']]}
                />
              </Field>
              <Field label="Type">
                <Select
                  value={form.finding_type}
                  onChange={(v) => setForm({ ...form, finding_type: v })}
                  options={[['', 'Not classified'], ...FINDING_TYPES.map((t) => [t, humanise(t)])]}
                />
              </Field>
            </div>
            <PrimaryButton onClick={submit} disabled={!form.body.trim() || mutation.isPending}>
              <span className="flex items-center gap-1.5">
                <Send className="h-3.5 w-3.5" />
                {mutation.isPending ? 'Saving' : 'Add comment'}
              </span>
            </PrimaryButton>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title={`Comments (${threads.length})`} subtitle="Each one can become a finding, then a change request, then a prompt" />
        {threads.length === 0 ? (
          <EmptyState
            icon={MessageSquarePlus}
            title="No comments on this surface"
            description="This is where your knowledge of what is actually wrong enters the system."
          />
        ) : (
          <div>
            {threads.map((t) => (
              <div key={t.id} className="border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-[12px] text-muted-foreground">
                    On <span className="text-foreground">{humanise(t.subject_type)}</span>
                    {t.subject_ref && <span className="text-foreground"> "{t.subject_ref}"</span>}
                    {t.observed_value && <span> showing {t.observed_value}</span>}
                  </p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone={PRIORITY_TONE[t.severity]}>{t.severity}</Badge>
                    <Badge tone={t.status === 'converted' ? 'info' : 'neutral'}>{humanise(t.status)}</Badge>
                  </div>
                </div>
                <p className="mt-1.5 text-[13px] leading-snug text-foreground">{t.body}</p>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  {t.created_date ? new Date(t.created_date).toLocaleString() : ''}
                  {t.author_role ? ` by ${t.author_role}` : ''}
                </p>
                {t.status === 'open' && (
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <CornerUpRight className="h-3 w-3" />
                    Convert to a finding or change request from the Findings surface.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * Small form primitives
 * ---------------------------------------------------------------- */

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputClass = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60';

function TextInput({ value, onChange, placeholder, disabled }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={inputClass}
    />
  );
}

function TextArea({ value, onChange, rows = 3, placeholder, disabled }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      className={`${inputClass} resize-y`}
    />
  );
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={inputClass}
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
