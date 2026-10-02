/**
 * Build-manifest workarounds (written per job by run-job.mjs from `wrap` actions). Empty in the pristine harness.
 * Each wrapper is a provider component the harness renders around the demo (e.g. a query-state adapter).
 */
import type { ComponentType, ReactNode } from "react"

export const wrappers: ReadonlyArray<ComponentType<{ children: ReactNode }>> = []
