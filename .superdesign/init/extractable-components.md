# Extractable components

SystemForge currently embeds its landing header and footer in `LandingPage.tsx`; there is no reusable layout component to extract yet. The footer requested in this task should become the first shared brand layout component.

## ComponentNode
- Source: `apps/web/src/components/ComponentNode.tsx`
- Category: basic
- Description: Status-aware service node used throughout the editable topology.
- Extractable props: selected (boolean), health (string), label (string)
- Hardcoded: component-kind icon selection, ports, status meters, sparkline presentation

## ServiceBanner
- Source: `apps/web/src/components/ServiceBanner.tsx`
- Category: basic
- Description: Non-blocking local-mode and canonical-service state banner.
- Extractable props: state (string), message (string), dismissible (boolean)
- Hardcoded: Phosphor status icons and local-mode wording hierarchy

## TelemetryPanel
- Source: `apps/web/src/components/TelemetryPanel.tsx`
- Category: basic
- Description: Multi-panel events, time-series, resource utilization, and causal-path workspace.
- Extractable props: activePanel (string), selectedEventId (string)
- Hardcoded: chart types, functional metric colors, operational labels

## CurrentLandingFooter
- Source: `apps/web/src/pages/LandingPage.tsx`
- Category: layout
- Description: Current compact source-license footer at the bottom of the landing page; target for the shared Elfeel identity redesign.
- Extractable props: repositoryUrl (string), productName (string), year (string)
- Hardcoded: SystemForge operational typography, square geometry, and cyan interaction color
