# SystemForge design system

## Product context

SystemForge is a deterministic distributed-systems laboratory. It supports guided missions, custom-authored scenarios, and interviewer-controlled sessions. The core workspace is a dense mission-control interface containing a component palette, editable topology, inspector, event rail, telemetry, causal analysis, and requirement ledger. Browser-local simulation is the primary availability path; canonical server operations add durable runs and short links.

## Visual concept

A field instrument for systems engineers: part network-operations console, part incident notebook, part simulation time machine. Preserve the current reference-led, asymmetrical control-room composition. Content density and causality determine layout. Do not turn the product into a generic SaaS dashboard.

## Identity

- Product wordmark: uppercase `SystemForge`, with condensed display lettering and monospaced operational subtitle.
- Product mark: the current square `SF` mark on marketing/designer surfaces and the current shield mark in mission control.
- Owner mark: the real transparent Mahmoud Elfeel elephant logo. Use it as the browser favicon and as the owner identity in the footer. Do not redraw, recolor, or replace it with a generic mark.
- Repository: `https://github.com/mahmoudelfeelig/SystemForge`.
- Owner site: `https://elfeel.me`.
- Footer pattern: adapt the owner's existing cross-site pattern—elephant mark, copyright identity, and GitHub access—into SystemForge's square, dense, operational visual language.

## Color and status

- Base: `#070b10`; surfaces `#0b1219`, `#111a23`, `#17232d`.
- Borders: `#263641`, bright border `#415461`.
- Primary text `#e8eef2`; muted `#91a3ad`; dim `#60727d`.
- Cyan `#58bfff`: navigation, selection, primary actions, causal links.
- Lime `#75d48a`: healthy and available.
- Amber `#f2bf4b`: warning, pressure, private interview boundary.
- Orange `#f19745`: degraded transition.
- Red `#ff604f`: critical, failed objective, overload.
- Violet `#b993e8`: secondary analysis dimension only.
- Status colors are semantic. Never use decorative gradients, purple-blue washes, or arbitrary color accents.

## Typography

- Body: IBM Plex Sans.
- Display headings: Barlow Condensed, uppercase, compact line-height.
- Operational labels and data: IBM Plex Mono, uppercase when functioning as a label.
- Maintain a wide hierarchy: 7-10px telemetry labels, 12-14px readable data/body, 16-22px panel headings, large condensed landing statement.

## Geometry and spacing

- Near-square controls and panels: 1-2px control radii; square icon frames; thin technical dividers.
- Dense 4/7/9/12/16/24px workspace rhythm; larger landing insets are content-led.
- Avoid excessive rounded cards, pill actions, glassmorphism, decorative blobs, and empty premium spacing.
- The recurring motif is indexed technical annotation: `SYS / 01`, numbered rails, node ports, status lines, and causal time markers.

## Motion and accessibility

- Motion communicates state, selection, time position, causality, and hierarchy only.
- Respect `prefers-reduced-motion`.
- Visible cyan focus outlines; semantic headings and landmarks; controls at usable touch sizes on mobile.
- Preserve browser-local access messages during canonical overload or origin failures.

## Footer brief

The footer must be a compact terminal-like ownership strip, not a generic multi-column marketing footer. It should use the real elephant mark as a linked owner identifier, show `SystemForge` and `© Mahmoud Elfeel 2026`, expose the engine version/source path in a scannable technical label, and provide a clearly labelled GitHub repository action. It must work at 390px without horizontal document overflow and use the existing functional cyan hover/focus treatment.
