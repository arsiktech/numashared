// The first anonymous-local pass creates a fresh backend identity before any
// Numa auth configuration is bundled. The real Convex tree replaces this
// temporary no-op module only after fresh, per-run environment keys are set.
export {};
