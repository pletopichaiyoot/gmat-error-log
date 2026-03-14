---
name: mobile-web-design
description: Build high-quality web applications with responsive layouts, strong visual systems, and practical UX patterns. Use for any web UI/page implementation.
allowed-tools: Read, Glob, Grep, Bash
---

# Web Application Design

> Philosophy: intentional visual direction, clear hierarchy, and production-ready responsiveness.
> Rule: design for full web usage first, then ensure responsive behavior across breakpoints.

This skill defines a practical workflow for web app UI implementation.

## 1. Core Constraints

Before coding, confirm these rules:

| Constraint | Rule | Why |
|------------|------|-----|
| Layout | Define desktop and tablet breakpoints explicitly | Web usage is often multi-column and dense |
| Hierarchy | Headings, spacing, and contrast must clearly guide scanning | Dashboards and tools need fast comprehension |
| Interaction | Hover, focus, active, and disabled states are required | Web UX depends on mouse and keyboard |
| Responsiveness | Desktop-first structure with responsive fallback to small widths | Preserves information density without breaking mobile |

## 2. Design System Setup

Define a visual system before implementation:

- CSS variables for color tokens (`bg`, `surface`, `text`, `muted`, `primary`, `danger`)
- Typography pair with explicit heading/body roles
- Spacing scale (4/8/12/16/24/32)
- Radius/shadow tokens for cards and controls
- Motion timing presets for transitions and reveals

## 3. Implementation Workflow

### Step 1: Structure for Desktop
Start with desktop/tablet information architecture:
- Use cards/sections to separate concerns
- Use table/grid layout where data density matters
- Keep primary controls near section headers

### Step 2: Responsive Downshift
Adapt layout for narrower screens:
- Collapse columns progressively (`3 -> 2 -> 1`)
- Preserve table readability with horizontal scroll wrappers
- Stack filters and actions when width is constrained

### Step 3: Production States
Implement complete UX states:
- Loading/skeleton
- Empty
- Error with actionable message
- Disabled/busy for buttons

## 4. Web App Checklist

- [ ] Distinct visual hierarchy for scan-heavy pages
- [ ] Keyboard focus and hover states implemented
- [ ] Tables usable at common laptop widths
- [ ] Filters/actions remain usable on narrow screens
- [ ] Loading and empty states present for data sections
- [ ] Color contrast passes accessibility checks
