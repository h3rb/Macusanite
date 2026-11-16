---
title: Sampling Plan
color: '#87ceeb'
tags: [fieldwork, planning]
---
# Sampling Plan

## Objectives

Collect at least 12 fresh lenses per transect so that
[[Chambers/Lab/Analytical Methods]] has statistical weight.

## Transects

| Transect | Location | Target | Notes |
| --- | --- | --- | --- |
| T1 | North ridge | 12 lenses | fault-controlled |
| T2 | Dry wash | 8 lenses | reworked clasts |
| T3 | Plateau | 15 lenses | freshest glass |

## Sequence

```mermaid
sequenceDiagram
  participant Field
  participant Lab
  Field->>Lab: deliver 35 wrapped samples
  Lab-->>Field: grain size + Cs assay
  Field->>Field: update [[Chambers/Fieldwork/Macusanite Occurrence]]
```

## Schedule

```mermaid
gantt
  title Field season
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Reconnaissance
  North ridge :done, t1, 2026-05-04, 5d
  Dry wash :active, t2, after t1, 4d
  section Collection
  Plateau :t3, after t2, 6d
  Lab handoff :milestone, m1, after t3, 0d
```

## Risks

- Rind formation if samples stand wet overnight.
- Duplicate lenses: cross-check with [[Chambers/Mineralogy/Fluid Inclusions]].
