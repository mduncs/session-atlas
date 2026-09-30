/**
 * Compatibility shim. Session list/search data access is shared so CLI and
 * TUI cannot grow separate query algebra. Phase 4 owns the implementation in
 * `src/data-access/session-list.ts`; Phase 5 consumes it through this seam.
 */
export * from "../data-access/session-list.js";
