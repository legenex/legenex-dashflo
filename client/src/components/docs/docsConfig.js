// Central registry of documentation sections.
// Each entry: { slug, title, group, Component }, the DocsLayout sidebar and
// the router both read from this single source of truth.

import { lazy } from 'react';

// Documentation pages are code split. This registry is imported by the
// operator route table, so static imports here put all eleven doc pages into
// the main application chunk for every user, including ones who never open the
// documentation. The Suspense boundary in App.jsx covers them.
const Overview = lazy(() => import('@/pages/docs/Overview'));
const Authentication = lazy(() => import('@/pages/docs/Authentication'));
const PostLead = lazy(() => import('@/pages/docs/PostLead'));
const FieldDictionary = lazy(() => import('@/pages/docs/FieldDictionary'));
const ResponseReference = lazy(() => import('@/pages/docs/ResponseReference'));
const FeedbackReturns = lazy(() => import('@/pages/docs/FeedbackReturns'));
const ReportingApi = lazy(() => import('@/pages/docs/ReportingApi'));
const Postbacks = lazy(() => import('@/pages/docs/Postbacks'));
const ErrorsRateLimits = lazy(() => import('@/pages/docs/ErrorsRateLimits'));
const Versioning = lazy(() => import('@/pages/docs/Versioning'));
const Guides = lazy(() => import('@/pages/docs/Guides'));

export const DOCS_SECTIONS = [
  { group: 'Getting Started', items: [
    { slug: '', title: 'Overview & Quickstart', Component: Overview },
    { slug: 'authentication', title: 'Authentication', Component: Authentication },
  ]},
  { group: 'API Reference', items: [
    { slug: 'post-a-lead', title: 'Post a Lead', Component: PostLead },
    { slug: 'field-dictionary', title: 'Field Dictionary', Component: FieldDictionary },
    { slug: 'response-reference', title: 'Response Reference', Component: ResponseReference },
    { slug: 'feedback-returns', title: 'Feedback & Returns', Component: FeedbackReturns },
    { slug: 'reporting', title: 'Reporting API', Component: ReportingApi },
    { slug: 'postbacks', title: 'Postbacks & Webhooks', Component: Postbacks },
    { slug: 'errors', title: 'Errors & Rate Limits', Component: ErrorsRateLimits },
    { slug: 'versioning', title: 'Versioning & Changelog', Component: Versioning },
  ]},
  { group: 'Guides', items: [
    { slug: 'guides', title: 'Guides', Component: Guides },
  ]},
];

// Flat list for routing.
export const DOCS_ROUTES = DOCS_SECTIONS.flatMap(g => g.items);